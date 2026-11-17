import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { parseRoleMapping } from '../src/config.js';
import { RoleService, SyncError } from '../src/roleService.js';
import { FakeApiError, FakeDiscord, IDS, reactionPacket } from './fakeDiscord.js';

const MAPPING = `CIS:${IDS.emojiCIS}!${IDS.roleEEU}|🇪🇺!${IDS.roleWEU}|🇺🇸!${IDS.roleNA}`;
const CIS = { id: IDS.emojiCIS, name: 'CIS' };
const EU = { id: null, name: '🇪🇺' };
const US = { id: null, name: '🇺🇸' };

// 18-digit user ids
const user = (n: number) => `70000000000${String(n).padStart(7, '0')}`;

function setup() {
  const discord = new FakeDiscord();
  const notices: string[] = [];
  const service = new RoleService({
    rest: discord.rest,
    guildId: IDS.guild,
    roles: parseRoleMapping(MAPPING),
    botUserId: IDS.bot,
    notify: (t) => notices.push(t),
    sleep: async () => {},
    retryDelaysMs: [0, 0],
  });
  service.setMessage(IDS.channel, IDS.message);
  // the fake needs to know which reactions exist on the message
  discord.react(`CIS:${IDS.emojiCIS}`, 'x');
  discord.reactions.get(`CIS:${IDS.emojiCIS}`)!.clear();
  discord.reactions.set('🇪🇺', new Set());
  discord.reactions.set('🇺🇸', new Set());
  return { discord, service, notices };
}

describe('live reactions', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.discord.addMember(user(1));
  });

  it('adds the role for a custom emoji (matched by id)', async () => {
    await ctx.service.handleRaw(reactionPacket('ADD', user(1), CIS));
    assert.ok(ctx.discord.members.get(user(1))!.roles.has(IDS.roleEEU));
  });

  it('adds the role for a unicode emoji', async () => {
    await ctx.service.handleRaw(reactionPacket('ADD', user(1), EU));
    assert.ok(ctx.discord.members.get(user(1))!.roles.has(IDS.roleWEU));
  });

  it('matches a custom emoji even if it was renamed in the server', async () => {
    await ctx.service.handleRaw(reactionPacket('ADD', user(1), { id: IDS.emojiCIS, name: 'totally_new_name' }));
    assert.ok(ctx.discord.members.get(user(1))!.roles.has(IDS.roleEEU));
  });

  it('removes the role when the reaction is removed', async () => {
    ctx.discord.members.get(user(1))!.roles.add(IDS.roleNA);
    await ctx.service.handleRaw(reactionPacket('REMOVE', user(1), US));
    assert.ok(!ctx.discord.members.get(user(1))!.roles.has(IDS.roleNA));
  });

  it('works for a message the bot never cached, because it only reads the packet', async () => {
    // Nothing about the message was fetched; the packet alone is enough.
    assert.equal(ctx.discord.calls.length, 0);
    await ctx.service.handleRaw(reactionPacket('ADD', user(1), US));
    assert.ok(ctx.discord.members.get(user(1))!.roles.has(IDS.roleNA));
    // exactly one API call: the role PUT. No message, user or member fetches.
    assert.equal(ctx.discord.calls.length, 1);
  });

  it('ignores reactions on other messages', async () => {
    await ctx.service.handleRaw(reactionPacket('ADD', user(1), CIS, { message_id: '999999999999999999' }));
    assert.equal(ctx.discord.calls.length, 0);
  });

  it('ignores other servers', async () => {
    await ctx.service.handleRaw(reactionPacket('ADD', user(1), CIS, { guild_id: '111111111111111111' }));
    assert.equal(ctx.discord.calls.length, 0);
  });

  it('ignores emoji that are not in the mapping', async () => {
    await ctx.service.handleRaw(reactionPacket('ADD', user(1), { id: null, name: '👍' }));
    assert.equal(ctx.discord.calls.length, 0);
    assert.equal(ctx.service.stats.ignored, 1);
  });

  it('ignores the bot itself and other bots', async () => {
    await ctx.service.handleRaw(reactionPacket('ADD', IDS.bot, CIS));
    await ctx.service.handleRaw(reactionPacket('ADD', user(1), CIS, { member: { user: { id: user(1), bot: true } } }));
    assert.equal(ctx.discord.calls.length, 0);
  });

  it('ignores unrelated gateway packets and malformed input without throwing', async () => {
    await ctx.service.handleRaw({ t: 'MESSAGE_CREATE', d: {} });
    await ctx.service.handleRaw(null);
    await ctx.service.handleRaw('nonsense');
    await ctx.service.handleRaw({ t: 'MESSAGE_REACTION_ADD' });
    assert.equal(ctx.discord.calls.length, 0);
  });

  it('does nothing until a role message is known', async () => {
    const fresh = new RoleService({ rest: ctx.discord.rest, guildId: IDS.guild, roles: parseRoleMapping(MAPPING), botUserId: IDS.bot });
    await fresh.handleRaw(reactionPacket('ADD', user(1), CIS));
    assert.equal(ctx.discord.calls.length, 0);
  });
});

describe('ordering and failures', () => {
  it('applies add then remove in order even when the add is slow', async () => {
    const { discord, service } = setup();
    discord.addMember(user(1));
    let first = true;
    discord.roleDelay = () => {
      if (first) {
        first = false;
        return 40; // the add takes longer than the remove would
      }
      return 0;
    };
    const a = service.handleRaw(reactionPacket('ADD', user(1), CIS));
    const b = service.handleRaw(reactionPacket('REMOVE', user(1), CIS));
    await Promise.all([a, b]);
    assert.ok(!discord.members.get(user(1))!.roles.has(IDS.roleEEU), 'final state must be "no role"');
  });

  it('keeps going after a failure and does not throw', async () => {
    const { discord, service } = setup();
    discord.addMember(user(1));
    discord.addMember(user(2));
    discord.roleFailure = (_m, userId) => (userId === user(1) ? new FakeApiError(50013, 403) : undefined);
    await service.handleRaw(reactionPacket('ADD', user(1), CIS));
    await service.handleRaw(reactionPacket('ADD', user(2), CIS));
    assert.ok(!discord.members.get(user(1))!.roles.has(IDS.roleEEU));
    assert.ok(discord.members.get(user(2))!.roles.has(IDS.roleEEU));
    assert.equal(service.stats.errors, 1);
  });

  it('tells the notify channel what to fix on Missing Permissions', async () => {
    const { discord, service, notices } = setup();
    discord.addMember(user(1));
    discord.roleFailure = () => new FakeApiError(50013, 403);
    await service.handleRaw(reactionPacket('ADD', user(1), CIS));
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /Manage Roles/);
    assert.match(notices[0]!, new RegExp(IDS.roleEEU));
  });

  it('does not count a member who left as an error', async () => {
    const { discord, service, notices } = setup();
    await service.handleRaw(reactionPacket('ADD', user(99), CIS)); // not a member
    assert.equal(service.stats.errors, 0);
    assert.equal(notices.length, 0);
  });

  it('retries transient failures and then succeeds', async () => {
    const { discord, service } = setup();
    discord.addMember(user(1));
    let attempts = 0;
    discord.roleFailure = () => (++attempts < 3 ? new FakeApiError(0, 503) : undefined);
    await service.handleRaw(reactionPacket('ADD', user(1), CIS));
    assert.equal(attempts, 3);
    assert.ok(discord.members.get(user(1))!.roles.has(IDS.roleEEU));
  });

  it('does not retry a 4xx error', async () => {
    const { discord, service } = setup();
    discord.addMember(user(1));
    let attempts = 0;
    discord.roleFailure = () => (++attempts, new FakeApiError(50013, 403));
    await service.handleRaw(reactionPacket('ADD', user(1), CIS));
    assert.equal(attempts, 1);
  });
});

describe('sync', () => {
  it('finds reactors who are missing the role, across multiple pages', async () => {
    const { discord, service } = setup();
    // 250 people reacted with CIS (3 pages of 100), 40 of them already have the role
    for (let i = 1; i <= 250; i++) {
      discord.addMember(user(i), i <= 40 ? [IDS.roleEEU] : []);
      discord.react(`CIS:${IDS.emojiCIS}`, user(i));
    }
    const preview = await service.sync({ apply: false, remove: false });
    const eeu = preview.perRole.find((r) => r.roleId === IDS.roleEEU)!;
    assert.equal(eeu.reactors, 250);
    assert.equal(eeu.holders, 40);
    assert.equal(eeu.toAdd, 210);
    assert.equal(discord.callsTo('PUT', /\/roles\//).length, 0, 'a preview must not change anything');

    const result = await service.sync({ apply: true, remove: false });
    assert.equal(result.added, 210);
    assert.equal([...discord.members.values()].filter((m) => m.roles.has(IDS.roleEEU)).length, 250);
  });

  it('reads more than one page of members', async () => {
    const { discord, service } = setup();
    for (let i = 1; i <= 2300; i++) discord.addMember(user(i), i % 2 === 0 ? [IDS.roleNA] : []);
    for (let i = 1; i <= 2300; i++) if (i % 2 === 0) discord.react('🇺🇸', user(i));
    const report = await service.sync({ apply: false, remove: false });
    const na = report.perRole.find((r) => r.roleId === IDS.roleNA)!;
    assert.equal(na.holders, 1150);
    assert.equal(na.toAdd, 0);
    assert.equal(discord.callsTo('GET', /\/members$/).length, 3);
  });

  it('skips people who reacted but already left the server', async () => {
    const { discord, service } = setup();
    discord.addMember(user(1));
    discord.react('🇪🇺', user(1));
    discord.react('🇪🇺', user(2)); // never in the members map = left
    const report = await service.sync({ apply: true, remove: false });
    assert.equal(report.added, 1);
    assert.equal(report.gone, 1);
    assert.equal(report.failed, 0);
  });

  it('never removes roles unless remove is requested', async () => {
    const { discord, service } = setup();
    discord.addMember(user(1), [IDS.roleNA]); // has role, never reacted
    const report = await service.sync({ apply: true, remove: false });
    assert.equal(report.removed, 0);
    assert.ok(discord.members.get(user(1))!.roles.has(IDS.roleNA));
  });

  it('removes roles from people without a reaction when remove is requested, but not from bots', async () => {
    const { discord, service } = setup();
    discord.addMember(user(1), [IDS.roleNA]);
    discord.addMember(user(2), [IDS.roleNA]);
    discord.addMember(user(3), [IDS.roleNA], true); // bot account with the role
    discord.react('🇺🇸', user(2));
    const report = await service.sync({ apply: true, remove: true });
    assert.equal(report.removed, 1);
    assert.ok(!discord.members.get(user(1))!.roles.has(IDS.roleNA));
    assert.ok(discord.members.get(user(2))!.roles.has(IDS.roleNA));
    assert.ok(discord.members.get(user(3))!.roles.has(IDS.roleNA));
  });

  it('refuses to remove when a reaction is missing from the message', async () => {
    const { discord, service } = setup();
    discord.reactions.delete('🇺🇸'); // someone cleared that emoji
    discord.addMember(user(1), [IDS.roleNA]);
    await assert.rejects(() => service.sync({ apply: true, remove: true }), (e: unknown) => e instanceof SyncError && /not on the message/.test(e.message));
    assert.ok(discord.members.get(user(1))!.roles.has(IDS.roleNA));
  });

  it('refuses a removal that would strip more than half of a large role', async () => {
    const { discord, service } = setup();
    for (let i = 1; i <= 30; i++) discord.addMember(user(i), [IDS.roleNA]);
    discord.react('🇺🇸', user(1));
    await assert.rejects(() => service.sync({ apply: true, remove: true }), /more than half/);
    assert.equal([...discord.members.values()].filter((m) => m.roles.has(IDS.roleNA)).length, 30);
  });

  it('aborts without changing anything if reading reactions fails', async () => {
    const { discord, service } = setup();
    discord.addMember(user(1));
    discord.react('🇪🇺', user(1));
    discord.reactionListFailure = new FakeApiError(50001, 403);
    await assert.rejects(() => service.sync({ apply: true, remove: false }));
    assert.equal(discord.callsTo('PUT', /\/roles\//).length, 0);
  });

  it('does not run two syncs at once', async () => {
    const { discord, service } = setup();
    for (let i = 1; i <= 20; i++) {
      discord.addMember(user(i));
      discord.react('🇪🇺', user(i));
    }
    discord.roleDelay = () => 5;
    const first = service.sync({ apply: true, remove: false });
    await assert.rejects(() => service.sync({ apply: true, remove: false }), /already running/);
    await first;
  });

  it('leaves alone anyone whose reaction changed live while the sync was running', async () => {
    const { discord, service } = setup();
    // 8 reactors; the sync works on 4 at a time with 25ms per call, so user 8 is still
    // waiting in the plan when we remove their reaction ~5ms in.
    for (let i = 1; i <= 8; i++) {
      discord.addMember(user(i));
      discord.react('🇪🇺', user(i));
    }
    discord.roleDelay = () => 25;
    const running = service.sync({ apply: true, remove: false });
    await new Promise((r) => setTimeout(r, 5));
    discord.reactions.get('🇪🇺')!.delete(user(8));
    await service.handleRaw(reactionPacket('REMOVE', user(8), EU));
    const report = await running;

    assert.ok(!discord.members.get(user(8))!.roles.has(IDS.roleWEU), 'the stale snapshot must not give user 8 the role back');
    assert.equal(report.skippedLive, 1);
    assert.equal(report.added, 7);
    assert.ok(discord.members.get(user(1))!.roles.has(IDS.roleWEU));
  });

  it('refuses to run when no role message is known', async () => {
    const discord = new FakeDiscord();
    const service = new RoleService({ rest: discord.rest, guildId: IDS.guild, roles: parseRoleMapping(MAPPING), botUserId: IDS.bot });
    await assert.rejects(() => service.sync({ apply: false, remove: false }), /No role message/);
  });
});
