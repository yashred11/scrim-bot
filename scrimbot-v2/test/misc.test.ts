import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commandDefinitions, commandsMatch, isAuthorized } from '../src/commands.js';
import { parseRoleMapping } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createNotifier } from '../src/notifier.js';
import { checkRoleSetup } from '../src/startup.js';
import { FakeDiscord, IDS } from './fakeDiscord.js';

describe('command authorization', () => {
  const allowed = ['admin', 'moderator', '123456789012345678'];
  it('always allows Administrators', () => {
    assert.ok(isAuthorized({ isAdministrator: true, roleIds: [], roleNames: [] }, []));
  });
  it('allows by role name, case-insensitive', () => {
    assert.ok(isAuthorized({ isAdministrator: false, roleIds: ['1'], roleNames: ['Moderator'] }, allowed));
  });
  it('allows by role id', () => {
    assert.ok(isAuthorized({ isAdministrator: false, roleIds: ['123456789012345678'], roleNames: ['x'] }, allowed));
  });
  it('denies everyone else, and everyone when the list is empty', () => {
    assert.ok(!isAuthorized({ isAdministrator: false, roleIds: ['9'], roleNames: ['Member'] }, allowed));
    assert.ok(!isAuthorized({ isAdministrator: false, roleIds: ['9'], roleNames: ['Moderator'] }, []));
  });
});

describe('startup role check', () => {
  const entries = parseRoleMapping(`🇪🇺!${IDS.roleEEU}|🇺🇸!${IDS.roleWEU}|🌏!${IDS.roleNA}`);
  const role = (id: string, position: number, managed = false) => ({ id, name: `role-${position}`, position, managed });

  it('passes when the bot role is above every regional role', () => {
    const issues = checkRoleSetup({
      guildRoles: [role(IDS.roleEEU, 3), role(IDS.roleWEU, 4), role(IDS.roleNA, 5)],
      entries,
      botHighestPosition: 10,
      botCanManageRoles: true,
    });
    assert.deepEqual(issues, []);
  });

  it('flags a role at or above the bot, a missing role, a managed role, and missing Manage Roles', () => {
    const issues = checkRoleSetup({
      guildRoles: [role(IDS.roleEEU, 10), role(IDS.roleWEU, 2, true)],
      entries,
      botHighestPosition: 10,
      botCanManageRoles: false,
    });
    assert.equal(issues.length, 4);
    assert.ok(issues.every((i) => i.level === 'error'));
    assert.ok(issues.some((i) => /Manage Roles/.test(i.message)));
    assert.ok(issues.some((i) => /not below the bot/.test(i.message)));
    assert.ok(issues.some((i) => /managed by an integration/.test(i.message)));
    assert.ok(issues.some((i) => /does not exist/.test(i.message)));
  });
});

describe('notifier', () => {
  it('suppresses identical messages and rate limits different ones', async () => {
    let now = 1_000_000;
    const posts: string[] = [];
    const stub = { post: async (_r: string, o: { body: { content: string } }) => void posts.push(o.body.content) } as never;
    const n = createNotifier(stub, '200000000000000009', createLogger('error', () => {}), () => now);
    n('a');
    n('a'); // same text
    n('b'); // too soon after 'a'
    now += 6_000;
    n('b');
    now += 11 * 60_000;
    n('a'); // cooldown over
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(posts, ['a', 'b', 'a']);
  });

  it('does nothing and does not throw when no channel is configured or posting fails', async () => {
    const stub = { post: async () => { throw new Error('boom'); } } as never;
    createNotifier(stub, undefined, createLogger('error', () => {}))('x');
    createNotifier(stub, '200000000000000009', createLogger('error', () => {}))('x');
    await new Promise((r) => setImmediate(r));
  });
});

describe('logger', () => {
  it('serializes errors and respects the level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.info('hidden');
    log.error('boom', { error: Object.assign(new Error('bad'), { code: 50013 }) });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /ERROR boom/);
    assert.match(lines[0]!, /"code":50013/);
  });
});

describe('slash command registration', () => {
  it('skips registering when Discord already has the same commands, ignoring extra fields Discord adds', () => {
    const fromDiscord = commandDefinitions.map((c) => ({ ...c, id: '1', application_id: '2', version: '3', default_member_permissions: null }));
    assert.ok(commandsMatch(fromDiscord));
  });
  it('registers when a command changed, is missing, or Discord returned nothing', () => {
    const changed = commandDefinitions.map((c) => ({ ...c }));
    changed[0] = { ...changed[0]!, description: 'something else' };
    assert.ok(!commandsMatch(changed));
    assert.ok(!commandsMatch(commandDefinitions.slice(1)));
    assert.ok(!commandsMatch([]));
    assert.ok(!commandsMatch(undefined));
  });
});
