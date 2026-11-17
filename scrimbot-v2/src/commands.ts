import {
  AttachmentBuilder,
  ChannelType,
  InteractionContextType,
  OverwriteType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import type { Config } from './config.js';
import { computeRoleAccess, formatAccessReport, type ChannelInfo } from './access.js';
import { errorMessage } from './errors.js';
import type { Logger } from './logger.js';
import type { RestLike } from './notifier.js';
import { publishPoll } from './poll.js';
import type { RoleService, SyncReport } from './roleService.js';
import type { Issue } from './startup.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('rolepoll')
    .setDescription('Post or refresh the regional role message')
    .addBooleanOption((o) => o.setName('new').setDescription('Post a new message instead of editing the current one'))
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('rolesync')
    .setDescription('Compare reactions with roles and fix the difference')
    .addBooleanOption((o) => o.setName('apply').setDescription('Make the changes. Without this it only reports what would change'))
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('roleaccess')
    .setDescription('List the channels each regional role unlocks')
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName('rolestatus')
    .setDescription('Show bot health and role assignment counters')
    .setContexts(InteractionContextType.Guild),
].map((c) => c.toJSON());

interface CommandShape {
  name: string;
  description: string;
  contexts?: number[] | null;
  options?: { name: string; description: string; type: number; required?: boolean }[];
}

function normalize(commands: CommandShape[]): string {
  return JSON.stringify(
    [...commands]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({
        name: c.name,
        description: c.description,
        contexts: c.contexts ?? null,
        options: (c.options ?? []).map((o) => ({ name: o.name, description: o.description, type: o.type, required: !!o.required })),
      })),
  );
}

/**
 * True when Discord already has exactly these commands. Used to skip re-registering on every
 * start, so a crash loop cannot run into Discord's command registration limits.
 */
export function commandsMatch(existing: unknown, desired: unknown = commandDefinitions): boolean {
  if (!Array.isArray(existing) || !Array.isArray(desired)) return false;
  return normalize(existing as CommandShape[]) === normalize(desired as CommandShape[]);
}

export interface CommandContext {
  client: Client<true>;
  rest: RestLike;
  config: Config;
  service: RoleService;
  logger: Logger;
  startedAt: Date;
  getIssues: () => Issue[];
}

/** Administrators always pass. Everyone else needs a role whose ID or name is on the allow list. */
export function isAuthorized(
  input: { isAdministrator: boolean; roleIds: string[]; roleNames: string[] },
  allowed: string[],
): boolean {
  if (input.isAdministrator) return true;
  const allow = new Set(allowed.map((a) => a.toLowerCase()));
  return (
    input.roleIds.some((id) => allow.has(id)) || input.roleNames.some((name) => allow.has(name.toLowerCase()))
  );
}

export function formatSyncReport(report: SyncReport): string {
  const lines = [report.dryRun ? '**Sync preview (nothing changed)**' : '**Sync finished**'];
  for (const r of report.perRole) {
    const change = report.remove ? `+${r.toAdd} / -${r.toRemove}` : `+${r.toAdd}`;
    lines.push(`${r.emoji} <@&${r.roleId}>: ${r.reactors} reacted, ${r.holders} hold the role, ${change}`);
  }
  if (report.dryRun) {
    lines.push('Run `/rolesync apply:true` to make these changes.');
  } else {
    lines.push(
      `Added ${report.added}, removed ${report.removed}, failed ${report.failed}, left the server ${report.gone}, ` +
        `changed live during sync ${report.skippedLive}. Took ${(report.durationMs / 1000).toFixed(1)}s.`,
    );
  }
  return lines.join('\n');
}

export function formatStatus(ctx: CommandContext): string {
  const w = ctx.service.watchedMessage;
  const s = ctx.service.stats;
  const issues = ctx.getIssues();
  const uptimeMin = Math.floor((Date.now() - ctx.startedAt.getTime()) / 60000);
  const lines = [
    `**Gateway:** ready, ${ctx.client.ws.ping}ms ping, up ${uptimeMin} min`,
    w
      ? `**Watching:** https://discord.com/channels/${ctx.config.guildId}/${w.channelId}/${w.messageId}`
      : '**Watching:** no role message found. Run `/rolepoll`.',
    `**Mapped roles:** ${ctx.config.roles.length}`,
    `**Since start:** ${s.added} added, ${s.removed} removed, ${s.errors} errors`,
    `**Last reaction handled:** ${s.lastEventAt ? `<t:${Math.floor(s.lastEventAt.getTime() / 1000)}:R>` : 'none yet'}`,
    `**Sync running:** ${ctx.service.isSyncing ? 'yes' : 'no'}`,
  ];
  if (issues.length === 0) lines.push('**Setup check:** no problems found');
  else lines.push('**Setup check:**', ...issues.map((i) => `- ${i.level === 'error' ? 'ERROR' : 'warning'}: ${i.message}`));
  return lines.join('\n');
}

export async function handleInteraction(interaction: ChatInputCommandInteraction, ctx: CommandContext): Promise<void> {
  const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });

  if (interaction.guildId !== ctx.config.guildId) {
    await reply('This bot only works in its configured server.');
    return;
  }

  const rawRoles = interaction.member?.roles;
  const roleIds = Array.isArray(rawRoles) ? rawRoles : rawRoles ? [...rawRoles.cache.keys()] : [];
  const authorized = isAuthorized(
    {
      isAdministrator: interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false,
      roleIds,
      roleNames: roleIds.map((id) => interaction.guild?.roles.cache.get(id)?.name ?? ''),
    },
    ctx.config.commandRoles,
  );
  if (!authorized) {
    await reply('You do not have permission to use this command.');
    return;
  }

  const edit = (content: string) => interaction.editReply({ content, allowedMentions: { parse: [] } });

  switch (interaction.commandName) {
    case 'rolestatus':
      await reply(formatStatus(ctx));
      return;

    case 'rolepoll': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const forceNew = interaction.options.getBoolean('new') ?? false;
        const result = await publishPoll(ctx.rest, {
          channelId: ctx.config.roleChannelId,
          botUserId: ctx.client.user.id,
          entries: ctx.config.roles,
          existing: ctx.service.watchedMessage,
          forceNew,
        });
        ctx.service.setMessage(result.channelId, result.messageId);
        const link = `https://discord.com/channels/${ctx.config.guildId}/${result.channelId}/${result.messageId}`;
        let text = `${result.created ? 'Posted a new' : 'Updated the'} role message: ${link}\nReactions added: ${result.reactionsAdded}.`;
        if (result.created && ctx.config.messageId && ctx.config.messageId !== result.messageId) {
          text += `\nROLE_REACTION_MESSAGE_ID is still ${ctx.config.messageId}. Change it to ${result.messageId} or the bot goes back to the old message after a restart.`;
        }
        await edit(text);
      } catch (e) {
        ctx.logger.error('/rolepoll failed', { error: e });
        await edit(`Failed: ${errorMessage(e)}`);
      }
      return;
    }

    case 'roleaccess': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const guild = interaction.guild;
        if (!guild) throw new Error('This command only works in a server.');
        const channels: ChannelInfo[] = [];
        for (const c of guild.channels.cache.values()) {
          if (c.isThread() || c.type === ChannelType.GuildCategory) continue;
          channels.push({
            id: c.id,
            name: c.name,
            category: c.parent?.name ?? null,
            kind: ChannelType[c.type] ?? String(c.type),
            overwrites: [...c.permissionOverwrites.cache.values()]
              .filter((o) => o.type === OverwriteType.Role)
              .map((o) => ({ id: o.id, allow: o.allow.bitfield, deny: o.deny.bitfield })),
          });
        }
        const mappedRoleIds = [...new Set(ctx.config.roles.map((r) => r.roleId))];
        const roles = mappedRoleIds.flatMap((id) => {
          const role = guild.roles.cache.get(id);
          return role ? [{ id, name: role.name, permissions: role.permissions.bitfield }] : [];
        });
        const report = computeRoleAccess({
          everyoneId: guild.id,
          everyonePermissions: guild.roles.everyone.permissions.bitfield,
          roles,
          channels,
        });
        const summary = report.perRole.map((r) => `${r.roleName}: ${r.unlocked.length} channels${r.isAdministrator ? ' (Administrator!)' : ''}`);
        await interaction.editReply({
          content: `**Channels unlocked per role** (${report.visibleToEveryone.length} channels are visible to everyone)\n${summary.join('\n')}\nFull list attached.`,
          files: [new AttachmentBuilder(Buffer.from(formatAccessReport(report, guild.name), 'utf8'), { name: 'role-access.txt' })],
          allowedMentions: { parse: [] },
        });
      } catch (e) {
        ctx.logger.error('/roleaccess failed', { error: e });
        await edit(`Failed: ${errorMessage(e)}`);
      }
      return;
    }

    case 'rolesync': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const report = await ctx.service.sync({
          apply: interaction.options.getBoolean('apply') ?? false,
          remove: false,
        });
        await edit(formatSyncReport(report));
      } catch (e) {
        ctx.logger.error('/rolesync failed', { error: e });
        await edit(`Sync failed: ${errorMessage(e)}`);
      }
      return;
    }

    default:
      await reply('Unknown command.');
  }
}
