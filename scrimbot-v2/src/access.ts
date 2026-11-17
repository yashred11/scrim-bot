import { PermissionFlagsBits } from 'discord.js';

export interface Overwrite {
  id: string;
  allow: bigint;
  deny: bigint;
}

export interface ChannelInfo {
  id: string;
  name: string;
  category: string | null;
  kind: string;
  /** Role overwrites only. Member overwrites do not apply to a role. */
  overwrites: Overwrite[];
}

export interface RoleInfoForAccess {
  id: string;
  name: string;
  permissions: bigint;
}

export interface RoleAccess {
  roleId: string;
  roleName: string;
  /** Channels this role can see that @everyone cannot. */
  unlocked: ChannelInfo[];
  /** The role has Administrator, which shows every channel regardless of overwrites. */
  isAdministrator: boolean;
}

export interface AccessReport {
  /** Channels a member with no roles can already see. */
  visibleToEveryone: ChannelInfo[];
  perRole: RoleAccess[];
}

/**
 * Whether a member holding exactly the given roles (plus @everyone) can see the channel.
 * Follows Discord's order: base permissions, @everyone overwrite, then role overwrites.
 */
export function canViewChannel(basePermissions: bigint, channel: ChannelInfo, everyoneId: string, roleIds: string[]): boolean {
  if ((basePermissions & PermissionFlagsBits.Administrator) !== 0n) return true;
  let perms = basePermissions;

  const everyone = channel.overwrites.find((o) => o.id === everyoneId);
  if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;

  let deny = 0n;
  let allow = 0n;
  for (const o of channel.overwrites) {
    if (roleIds.includes(o.id)) {
      deny |= o.deny;
      allow |= o.allow;
    }
  }
  perms = (perms & ~deny) | allow;
  return (perms & PermissionFlagsBits.ViewChannel) !== 0n;
}

export function computeRoleAccess(input: {
  everyoneId: string;
  everyonePermissions: bigint;
  roles: RoleInfoForAccess[];
  channels: ChannelInfo[];
}): AccessReport {
  const visibleToEveryone = input.channels.filter((c) =>
    canViewChannel(input.everyonePermissions, c, input.everyoneId, []),
  );
  const baselineIds = new Set(visibleToEveryone.map((c) => c.id));

  const perRole = input.roles.map((role) => {
    const base = input.everyonePermissions | role.permissions;
    const unlocked = input.channels.filter(
      (c) => !baselineIds.has(c.id) && canViewChannel(base, c, input.everyoneId, [role.id]),
    );
    return {
      roleId: role.id,
      roleName: role.name,
      unlocked,
      isAdministrator: (role.permissions & PermissionFlagsBits.Administrator) !== 0n,
    };
  });

  return { visibleToEveryone, perRole };
}

function groupByCategory(channels: ChannelInfo[]): Map<string, ChannelInfo[]> {
  const groups = new Map<string, ChannelInfo[]>();
  for (const c of [...channels].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = c.category ?? '(no category)';
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/** Plain-text report suitable for a file attachment. */
export function formatAccessReport(report: AccessReport, guildName: string): string {
  const lines: string[] = [
    `Channel access by role for ${guildName}`,
    'Shows what a member holding ONLY that role (plus @everyone) can see.',
    'Tier roles such as "(WEU-EEU) Semi-pro" are not included, so a channel that needs one of them will not appear here.',
    '',
    `Visible to everyone with no role: ${report.visibleToEveryone.length} channels`,
    '',
  ];
  for (const r of report.perRole) {
    lines.push(`=== ${r.roleName} (${r.roleId}) ===`);
    if (r.isAdministrator) {
      lines.push('WARNING: this role has Administrator, so it can see every channel.');
    }
    if (r.unlocked.length === 0) {
      lines.push('Unlocks no channels beyond what everyone already sees.');
    } else {
      lines.push(`Unlocks ${r.unlocked.length} channels:`);
      for (const [category, channels] of groupByCategory(r.unlocked)) {
        lines.push(`  ${category}`);
        for (const c of channels) lines.push(`    #${c.name} (${c.kind})`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
