import 'dotenv/config';
import { Client, Events, GatewayIntentBits, Options, Routes } from 'discord.js';
import { commandDefinitions, commandsMatch, formatSyncReport, handleInteraction, type CommandContext } from './commands.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { errorMessage } from './errors.js';
import { startHealthServer } from './health.js';
import { createLogger } from './logger.js';
import { createNotifier } from './notifier.js';
import { discoverPollMessage, fetchPollMessage } from './poll.js';
import { RoleService } from './roleService.js';
import { inspectGuild, type Issue } from './startup.js';

const bootLogger = createLogger('info');

process.on('unhandledRejection', (reason) => {
  bootLogger.error('Unhandled promise rejection', { error: reason });
});
process.on('uncaughtException', (error) => {
  bootLogger.error('Uncaught exception, exiting so the supervisor restarts the bot', { error });
  process.exit(1);
});

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      bootLogger.error(e.message);
      process.exit(2);
    }
    throw e;
  }
}

const config = loadConfigOrExit();

const logger = createLogger(config.logLevel);
const startedAt = new Date();

const client = new Client({
  // DISCORD_API_BASE is only used by the end-to-end test, which points the bot at a fake Discord server.
  ...(process.env.DISCORD_API_BASE ? { rest: { api: process.env.DISCORD_API_BASE } } : {}),
  // Reactions are read from raw gateway packets, so no message content, members or presence data is needed.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
  makeCache: Options.cacheWithLimits({
    MessageManager: 0,
    ReactionManager: 0,
    PresenceManager: 0,
    GuildMemberManager: 0,
  }),
});

let service: RoleService | undefined;
let issues: Issue[] = [];

client.on(Events.Raw, (packet: unknown) => {
  void service?.handleRaw(packet);
});
client.on(Events.Error, (error) => logger.error('Client error', { error }));
client.on(Events.Warn, (message) => logger.warn(message));
client.on(Events.ShardDisconnect, (event, id) => logger.warn('Shard disconnected', { shard: id, code: event.code }));
client.on(Events.ShardReconnecting, (id) => logger.info('Shard reconnecting', { shard: id }));
client.on(Events.ShardResume, (id, replayed) => logger.info('Shard resumed', { shard: id, replayedEvents: replayed }));

client.once(Events.ClientReady, (ready) => {
  logger.info('Logged in', { tag: ready.user.tag });
  void onReady(ready).catch((e) => logger.error('Startup task failed', { error: e }));
});

async function onReady(ready: Client<true>): Promise<void> {
  const rest = ready.rest;
  const notify = createNotifier(rest, config.notifyChannelId, logger);

  service = new RoleService({ rest, guildId: config.guildId, roles: config.roles, botUserId: ready.user.id, logger, notify });

  // Start handling reactions right away when the message is known from config.
  if (config.messageId) service.setMessage(config.roleChannelId, config.messageId);

  const ctx: CommandContext = {
    client: ready,
    rest,
    config,
    service,
    logger,
    startedAt,
    getIssues: () => issues,
  };

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    handleInteraction(interaction, ctx).catch((e) => logger.error('Interaction failed', { error: e }));
  });

  // 1. Setup check: permissions, role hierarchy, channel access.
  try {
    issues = await inspectGuild(ready, config);
    for (const issue of issues) logger[issue.level === 'error' ? 'error' : 'warn'](issue.message);
    if (issues.length > 0) notify(`Setup problems found:\n${issues.map((i) => `- ${i.message}`).join('\n')}`);
    else logger.info('Setup check passed');
  } catch (e) {
    logger.error('Setup check failed', { error: e });
    notify(`Setup check failed: ${errorMessage(e)}`);
  }

  // 2. Find the role message: configured ID first, then the bot's own embed in the role channel.
  try {
    let messageId = config.messageId;
    if (messageId && !(await fetchPollMessage(rest, config.roleChannelId, messageId))) {
      logger.warn('ROLE_REACTION_MESSAGE_ID does not exist anymore, searching the channel', { messageId });
      messageId = undefined;
    }
    messageId ??= await discoverPollMessage(rest, config.roleChannelId, ready.user.id);
    if (messageId) {
      service.setMessage(config.roleChannelId, messageId);
      logger.info('Watching role message', { channelId: config.roleChannelId, messageId });
    } else {
      logger.warn('No role message found. Run /rolepoll in the server to create one.');
      notify('No role message found. Run `/rolepoll` to create one.');
    }
  } catch (e) {
    logger.error('Could not look up the role message', { error: e });
    notify(`Could not look up the role message: ${errorMessage(e)}`);
  }

  // 3. Slash commands. Failure is not fatal because reactions keep working without them.
  try {
    const route = Routes.applicationGuildCommands(ready.user.id, config.guildId);
    const existing = await rest.get(route);
    if (commandsMatch(existing)) {
      logger.info('Slash commands registered (already up to date)');
    } else {
      await rest.put(route, { body: commandDefinitions });
      logger.info('Slash commands registered');
    }
  } catch (e) {
    logger.warn(
      'Could not register slash commands. Re-invite the bot with the applications.commands scope (see DEPLOY.md).',
      { error: e },
    );
  }

  // 4. Catch up on reactions made while the bot was offline.
  if (config.syncOnStart === 'add' && service.watchedMessage) {
    setTimeout(() => {
      service
        ?.sync({ apply: true, remove: false })
        .then((report) => {
          const changed = report.added + report.failed;
          logger.info('Startup sync done', { added: report.added, failed: report.failed });
          if (changed > 0) notify(`Startup sync:\n${formatSyncReport(report)}`);
        })
        .catch((e) => logger.error('Startup sync failed', { error: e }));
    }, 10_000);
  }
}

const healthServer = startHealthServer(
  config.healthPort,
  () => {
    const ready = client.isReady();
    return {
      ok: ready && client.ws.status === 0,
      details: { ready, wsStatus: client.ws.status, ping: ready ? client.ws.ping : null, uptimeSec: Math.floor(process.uptime()) },
    };
  },
  logger,
);

async function shutdown(signal: string): Promise<void> {
  logger.info('Shutting down', { signal });
  healthServer?.close();
  await client.destroy();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

client.login(config.token).catch((e) => {
  logger.error('Login failed', { error: e });
  process.exit(1);
});
