import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PermissionFlagsBits as P } from 'discord.js';
import { canViewChannel, computeRoleAccess, formatAccessReport, type ChannelInfo } from '../src/access.js';

const EVERYONE = '1000';
const WEU = '2000';
const NA = '3000';
const VIEW = P.ViewChannel;

const channel = (name: string, overwrites: ChannelInfo['overwrites'], category: string | null = null): ChannelInfo => ({
  id: name,
  name,
  category,
  kind: 'GuildText',
  overwrites,
});

describe('canViewChannel', () => {
  it('lets everyone see a channel with no overwrites when @everyone has View Channel', () => {
    assert.ok(canViewChannel(VIEW, channel('general', []), EVERYONE, []));
  });

  it('hides a channel that denies View Channel to @everyone', () => {
    const c = channel('private', [{ id: EVERYONE, allow: 0n, deny: VIEW }]);
    assert.ok(!canViewChannel(VIEW, c, EVERYONE, []));
  });

  it('shows a private channel to a role that is allowed, but not to other roles', () => {
    const c = channel('weu', [
      { id: EVERYONE, allow: 0n, deny: VIEW },
      { id: WEU, allow: VIEW, deny: 0n },
    ]);
    assert.ok(canViewChannel(VIEW, c, EVERYONE, [WEU]));
    assert.ok(!canViewChannel(VIEW, c, EVERYONE, [NA]));
  });

  it('lets a role-level deny override a base permission', () => {
    const c = channel('x', [{ id: NA, allow: 0n, deny: VIEW }]);
    assert.ok(!canViewChannel(VIEW, c, EVERYONE, [NA]));
  });

  it('lets a role-level allow win over the @everyone deny, as Discord does', () => {
    const c = channel('x', [
      { id: EVERYONE, allow: 0n, deny: VIEW },
      { id: WEU, allow: VIEW, deny: 0n },
      { id: NA, allow: 0n, deny: VIEW },
    ]);
    assert.ok(canViewChannel(VIEW, c, EVERYONE, [WEU, NA]));
  });

  it('shows everything to Administrator', () => {
    const c = channel('secret', [{ id: EVERYONE, allow: 0n, deny: VIEW }]);
    assert.ok(canViewChannel(P.Administrator, c, EVERYONE, []));
  });
});

describe('computeRoleAccess', () => {
  const channels = [
    channel('rules', []),
    channel('weu-open', [{ id: EVERYONE, allow: 0n, deny: VIEW }, { id: WEU, allow: VIEW, deny: 0n }], 'WEU & EEU'),
    channel('na-open', [{ id: EVERYONE, allow: 0n, deny: VIEW }, { id: NA, allow: VIEW, deny: 0n }], 'NA & SA'),
    channel('staff', [{ id: EVERYONE, allow: 0n, deny: VIEW }]),
  ];
  const report = computeRoleAccess({
    everyoneId: EVERYONE,
    everyonePermissions: VIEW,
    roles: [
      { id: WEU, name: 'WEU', permissions: 0n },
      { id: NA, name: 'NA', permissions: 0n },
    ],
    channels,
  });

  it('reports channels visible with no role as the baseline', () => {
    assert.deepEqual(report.visibleToEveryone.map((c) => c.name), ['rules']);
  });

  it('lists only the channels each role adds beyond the baseline', () => {
    assert.deepEqual(report.perRole.find((r) => r.roleId === WEU)!.unlocked.map((c) => c.name), ['weu-open']);
    assert.deepEqual(report.perRole.find((r) => r.roleId === NA)!.unlocked.map((c) => c.name), ['na-open']);
  });

  it('warns when a regional role has Administrator', () => {
    const r = computeRoleAccess({
      everyoneId: EVERYONE,
      everyonePermissions: VIEW,
      roles: [{ id: WEU, name: 'WEU', permissions: P.Administrator }],
      channels,
    });
    assert.ok(r.perRole[0]!.isAdministrator);
    assert.equal(r.perRole[0]!.unlocked.length, 3);
    assert.match(formatAccessReport(r, 'Test'), /WARNING.*Administrator/);
  });

  it('formats a readable report grouped by category', () => {
    const text = formatAccessReport(report, 'Dota 2 Scrims');
    assert.match(text, /=== WEU \(2000\) ===/);
    assert.match(text, /WEU & EEU\n\s+#weu-open/);
    assert.match(text, /Tier roles/);
  });
});
