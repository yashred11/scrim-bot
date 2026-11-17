import { parseEmojiSpec, type ParsedEmoji } from './emoji.js';
import type { LogLevel } from './logger.js';

export interface RoleEntry {
  emoji: ParsedEmoji;
  roleId: string;
}

export interface Config {
  token: string;
  guildId: string;
  roleChannelId: string;
  messageId: string | undefined;
  roles: RoleEntry[];
  /** Role IDs or lowercase role names allowed to run commands, besides Administrators. */
  commandRoles: string[];
  notifyChannelId: string | undefined;
  syncOnStart: 'add' | 'off';
  healthPort: number;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

const SNOWFLAKE = /^\d{17,20}$/;

/** Format: [emoji]![role id] pairs separated by |. Throws ConfigError listing every problem. */
export function parseRoleMapping(raw: string): RoleEntry[] {
  const problems: string[] = [];
  const entries: RoleEntry[] = [];
  const seen = new Set<string>();

  for (const part of raw.split('|').map((p) => p.trim()).filter((p) => p.length > 0)) {
    const pieces = part.split('!');
    if (pieces.length !== 2) {
      problems.push(`ROLE_MAPPING entry "${part}" must look like emoji!roleId`);
      continue;
    }
    const [emojiSpec = '', roleId = ''] = pieces.map((p) => p.trim());
    if (!SNOWFLAKE.test(roleId)) {
      problems.push(`ROLE_MAPPING entry "${part}" has an invalid role id "${roleId}"`);
      continue;
    }
    try {
      const emoji = parseEmojiSpec(emojiSpec);
      if (seen.has(emoji.key)) {
        problems.push(`ROLE_MAPPING lists the emoji ${emoji.display} twice`);
        continue;
      }
      seen.add(emoji.key);
      entries.push({ emoji, roleId });
    } catch (e) {
      problems.push(`ROLE_MAPPING entry "${part}": ${(e as Error).message}`);
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return entries;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];
  const get = (name: string): string => (env[name] ?? '').trim();

  const token = get('DISCORD_TOKEN') || get('DISCORD_CLIENT_SECRET');
  if (!token) problems.push('DISCORD_TOKEN (or DISCORD_CLIENT_SECRET) is required');

  const snowflake = (name: string, required: boolean): string | undefined => {
    const value = get(name);
    if (!value) {
      if (required) problems.push(`${name} is required`);
      return undefined;
    }
    if (!SNOWFLAKE.test(value)) {
      problems.push(`${name} must be a Discord ID (17 to 20 digits), got "${value}"`);
      return undefined;
    }
    return value;
  };

  const guildId = snowflake('GUILD_ID', true);
  const roleChannelId = snowflake('ROLE_CHANNEL', true);
  const messageId = snowflake('ROLE_REACTION_MESSAGE_ID', false);
  const notifyChannelId = snowflake('NOTIFY_CHANNEL', false);

  let roles: RoleEntry[] = [];
  if (!get('ROLE_MAPPING')) {
    problems.push('ROLE_MAPPING is required');
  } else {
    try {
      roles = parseRoleMapping(get('ROLE_MAPPING'));
    } catch (e) {
      if (e instanceof ConfigError) problems.push(...e.problems);
      else throw e;
    }
  }
  if (get('ROLE_MAPPING') && roles.length === 0 && problems.length === 0) {
    problems.push('ROLE_MAPPING has no entries');
  }
  if (roles.length > 20) problems.push('ROLE_MAPPING has more than 20 entries, the Discord reaction limit');

  const commandRoles = get('ROLE_PERMISSION_ALLOWED_ROLES')
    .split('|')
    .map((r) => r.trim().toLowerCase())
    .filter((r) => r.length > 0);

  const syncRaw = (get('SYNC_ON_START') || 'add').toLowerCase();
  if (syncRaw !== 'add' && syncRaw !== 'off') problems.push('SYNC_ON_START must be "add" or "off"');

  const portRaw = get('HEALTH_PORT') || '8080';
  const healthPort = Number(portRaw);
  if (!Number.isInteger(healthPort) || healthPort < 0 || healthPort > 65535) {
    problems.push('HEALTH_PORT must be a port number, or 0 to disable');
  }

  const levelRaw = (get('LOG_LEVEL') || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(levelRaw)) {
    problems.push('LOG_LEVEL must be debug, info, warn or error');
  }

  if (problems.length > 0 || !guildId || !roleChannelId) throw new ConfigError(problems);

  return {
    token,
    guildId,
    roleChannelId,
    messageId,
    roles,
    commandRoles,
    notifyChannelId,
    syncOnStart: syncRaw === 'off' ? 'off' : 'add',
    healthPort,
    logLevel: levelRaw as LogLevel,
  };
}
