import { PermissionFlagsBits, type Client } from 'discord.js';
import type { Config, RoleEntry } from './config.js';

export interface Issue {
  level: 'error' | 'warn';
  message: string;
}

export interface RoleInfo {
  id: string;
  name: string;
  position: number;
  managed: boolean;
}

/** Pure check of the role setup, so the rules can be tested without Discord. */
export function checkRoleSetup(input: {
  guildRoles: RoleInfo[];
  entries: RoleEntry[];
  botHighestPosition: number;
  botCanManageRoles: boolean;
}): Issue[] {
  const issues: Issue[] = [];
  if (!input.botCanManageRoles) {
    issues.push({ level: 'error', message: 'The bot does not have the Manage Roles permission.' });
  }
  const byId = new Map(input.guildRoles.map((r) => [r.id, r]));
  for (const entry of input.entries) {
    const role = byId.get(entry.roleId);
    if (!role) {
      issues.push({
        level: 'error',
        message: `Role ${entry.roleId} (for ${entry.emoji.display}) from ROLE_MAPPING does not exist in this server.`,
      });
      continue;
    }
    if (role.managed) {
      issues.push({ level: 'error', message: `Role "${role.name}" is managed by an integration and cannot be assigned.` });
    } else if (role.position >= input.botHighestPosition) {
      issues.push({
        level: 'error',
        message: `Role "${role.name}" is not below the bot's highest role, so the bot cannot assign it. Move the bot role above it.`,
      });
    }
  }
  return issues;
}

/** Looks at the live server and reports anything that would make role assignment fail. */
export async function inspectGuild(client: Client<true>, config: Config): Promise<Issue[]> {
  const issues: Issue[] = [];
  const guild = await client.guilds.fetch(config.guildId);
  const me = await guild.members.fetchMe();
  const roles = await guild.roles.fetch();

  issues.push(
    ...checkRoleSetup({
      guildRoles: [...roles.values()].map((r) => ({ id: r.id, name: r.name, position: r.position, managed: r.managed })),
      entries: config.roles,
      botHighestPosition: me.roles.highest.position,
      botCanManageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
    }),
  );

  const channel = await guild.channels.fetch(config.roleChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    issues.push({ level: 'error', message: `ROLE_CHANNEL ${config.roleChannelId} is not a text channel the bot can see.` });
  } else {
    const perms = channel.permissionsFor(me);
    const needed: [bigint, string][] = [
      [PermissionFlagsBits.ViewChannel, 'View Channel'],
      [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
      [PermissionFlagsBits.SendMessages, 'Send Messages'],
      [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
      [PermissionFlagsBits.AddReactions, 'Add Reactions'],
    ];
    for (const [flag, label] of needed) {
      if (!perms?.has(flag)) {
        issues.push({ level: 'warn', message: `The bot lacks ${label} in the role channel.` });
      }
    }
  }
  return issues;
}
