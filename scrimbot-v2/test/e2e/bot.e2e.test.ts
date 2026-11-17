import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { E, FakeGateway } from './fakeGateway.js';

const HEALTH_PORT = 18000 + Math.floor(Math.random() * 1000);
const gw = new FakeGateway();
let bot: ChildProcess;
let output = '';
let exitCode: number | null | undefined;

async function waitFor(cond: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${what}.\n--- bot output ---\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const roleCalls = (method: 'PUT' | 'DELETE') => gw.callsMatching(method, /\/members\/\d+\/roles\/\d+$/);
const U = (n: number) => `70000000000${String(n).padStart(7, '0')}`;
const CIS = { id: E.emojiCIS, name: 'CIS' };

function reaction(type: 'ADD' | 'REMOVE', userId: string, emoji: { id: string | null; name: string }, messageId = E.message) {
  gw.dispatch(`MESSAGE_REACTION_${type}`, {
    user_id: userId,
    channel_id: E.channel,
    message_id: messageId,
    guild_id: E.guild,
    emoji,
    ...(type === 'ADD' ? { member: { user: { id: userId, username: 'x', discriminator: '0', avatar: null }, roles: [] } } : {}),
  });
}

before(async () => {
  await gw.start();
  for (let i = 1; i <= 6; i++) gw.members.set(U(i), { roles: new Set() });
  // Startup sync scenario: user 5 reacted with CIS while the bot was offline and has no role yet.
  gw.reactions.set(`CIS:${E.emojiCIS}`, new Set([U(5)]));
  gw.reactions.set('🇺🇸', new Set());
  gw.reactions.set('🌏', new Set());

  // E2E_ENTRY=dist/index.js runs the compiled build, which is what the Docker image ships.
  const entry = process.env.E2E_ENTRY ?? 'src/index.ts';
  bot = spawn(process.execPath, entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry], {
    env: {
      PATH: process.env.PATH,
      DISCORD_TOKEN: 'fake-token',
      DISCORD_API_BASE: gw.apiBase,
      GUILD_ID: E.guild,
      ROLE_CHANNEL: E.channel,
      ROLE_REACTION_MESSAGE_ID: E.message,
      ROLE_MAPPING: `CIS:${E.emojiCIS}!${E.roleEEU}|🇺🇸!${E.roleNA}|🌏!${E.roleSEA}`,
      ROLE_PERMISSION_ALLOWED_ROLES: 'Moderator',
      SYNC_ON_START: 'add',
      HEALTH_PORT: String(HEALTH_PORT),
      LOG_LEVEL: 'debug',
    },
  });
  bot.stdout?.on('data', (d) => (output += d));
  bot.stderr?.on('data', (d) => (output += d));
  bot.on('exit', (code) => (exitCode = code));

  await waitFor(() => output.includes('Slash commands registered'), 'the bot to finish starting');
});

after(async () => {
  if (bot && exitCode === undefined) bot.kill('SIGKILL');
  await gw.stop();
});

describe('bot against a fake Discord', () => {
  it('connects with only the Guilds and GuildMessageReactions intents (no privileged intents)', () => {
    assert.equal(gw.identifyIntents, (1 << 0) | (1 << 10));
  });

  it('runs its startup checks and finds the configured message', () => {
    assert.match(output, /Logged in/);
    assert.match(output, /Setup check passed/);
    assert.match(output, /Watching role message/);
  });

  it('registers the four slash commands for the guild', () => {
    const put = gw.callsMatching('PUT', /\/applications\/\d+\/guilds\/\d+\/commands$/)[0];
    const names = (put?.body as { name: string }[]).map((c) => c.name).sort();
    assert.deepEqual(names, ['roleaccess', 'rolepoll', 'rolestatus', 'rolesync']);
  });

  it('answers the health check', async () => {
    const res = await fetch(`http://127.0.0.1:${HEALTH_PORT}/healthz`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; ready: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.ready, true);
  });

  it('gives the role for a custom emoji reaction, using one API call', async () => {
    const before = gw.calls.length;
    reaction('ADD', U(1), CIS);
    await waitFor(() => roleCalls('PUT').some((c) => c.path.endsWith(`/members/${U(1)}/roles/${E.roleEEU}`)), 'role PUT for user 1');
    assert.ok(gw.members.get(U(1))!.roles.has(E.roleEEU));
    assert.equal(gw.calls.length - before, 1);
  });

  it('gives and takes the role for a unicode emoji', async () => {
    reaction('ADD', U(2), { id: null, name: '🇺🇸' });
    await waitFor(() => gw.members.get(U(2))!.roles.has(E.roleNA), 'NA role added');
    reaction('REMOVE', U(2), { id: null, name: '🇺🇸' });
    await waitFor(() => !gw.members.get(U(2))!.roles.has(E.roleNA), 'NA role removed');
  });

  it('ignores reactions on other messages and unmapped emoji', async () => {
    const before = gw.calls.length;
    reaction('ADD', U(3), CIS, '999999999999999999');
    reaction('ADD', U(3), { id: null, name: '👍' });
    await sleep(300);
    assert.equal(gw.calls.length, before);
    assert.equal(gw.members.get(U(3))!.roles.size, 0);
  });

  it('survives a role failure and keeps serving other users', async () => {
    gw.failRolePutFor.add(U(4));
    reaction('ADD', U(4), CIS);
    await waitFor(() => output.includes('Failed to add role'), 'the failure to be logged');
    reaction('ADD', U(3), CIS);
    await waitFor(() => gw.members.get(U(3))!.roles.has(E.roleEEU), 'the next user to get a role');
    assert.equal(exitCode, undefined, 'the bot must still be running');
    const res = await fetch(`http://127.0.0.1:${HEALTH_PORT}/healthz`);
    assert.equal(res.status, 200);
  });

  it('catches up on a reaction made while it was offline (startup sync)', async () => {
    await waitFor(() => gw.members.get(U(5))!.roles.has(E.roleEEU), 'the startup sync to add user 5', 15000);
    assert.match(output, /Startup sync done/);
  });

  it('answers /rolestatus for an Administrator', async () => {
    const before = gw.callsMatching('POST', /callback$/).length;
    gw.dispatch('INTERACTION_CREATE', gw.interaction('rolestatus', { id: U(6), roles: [], permissions: '8' }));
    await waitFor(() => gw.callsMatching('POST', /callback$/).length > before, 'an interaction callback');
    const cb = gw.callsMatching('POST', /callback$/).at(-1)!.body as { data: { content: string; flags: number } };
    assert.match(cb.data.content, /Gateway/);
    assert.match(cb.data.content, /Setup check:\*\* no problems found/);
    assert.equal(cb.data.flags & 64, 64, 'reply must be ephemeral');
  });

  it('allows a member with the Moderator role, matched by role name', async () => {
    const before = gw.callsMatching('POST', /callback$/).length;
    gw.dispatch('INTERACTION_CREATE', gw.interaction('rolestatus', { id: U(6), roles: [E.modRole], permissions: '0' }));
    await waitFor(() => gw.callsMatching('POST', /callback$/).length > before, 'an interaction callback');
    const cb = gw.callsMatching('POST', /callback$/).at(-1)!.body as { data: { content: string } };
    assert.match(cb.data.content, /Gateway/);
  });

  it('refuses a regular member', async () => {
    const before = gw.callsMatching('POST', /callback$/).length;
    gw.dispatch('INTERACTION_CREATE', gw.interaction('rolesync', { id: U(6), roles: [], permissions: '0' }, [{ name: 'apply', type: 5, value: true }]));
    await waitFor(() => gw.callsMatching('POST', /callback$/).length > before, 'an interaction callback');
    const cb = gw.callsMatching('POST', /callback$/).at(-1)!.body as { data: { content: string } };
    assert.match(cb.data.content, /do not have permission/);
  });

  it('answers /roleaccess with a file listing the channels each role unlocks', async () => {
    const before = gw.callsMatching('PATCH', /@original$/).length;
    gw.dispatch('INTERACTION_CREATE', gw.interaction('roleaccess', { id: U(6), roles: [], permissions: '8' }));
    await waitFor(() => gw.callsMatching('PATCH', /@original$/).length > before, 'the roleaccess reply');
    assert.ok(!output.includes('/roleaccess failed'), output);
  });

  it('runs /rolesync as a preview without changing anything', async () => {
    const puts = roleCalls('PUT').length;
    const before = gw.callsMatching('PATCH', /@original$/).length;
    gw.dispatch('INTERACTION_CREATE', gw.interaction('rolesync', { id: U(6), roles: [], permissions: '8' }));
    await waitFor(() => gw.callsMatching('PATCH', /@original$/).length > before, 'the sync preview reply');
    const edit = gw.callsMatching('PATCH', /@original$/).at(-1)!.body as { content: string };
    assert.match(edit.content, /Sync preview \(nothing changed\)/);
    assert.equal(roleCalls('PUT').length, puts);
  });

  it('keeps working after the gateway connection drops and resumes', async () => {
    const identifies = gw.identifyCount;
    gw.dropConnections(4000);
    await waitFor(() => gw.resumeCount > 0 || gw.identifyCount > identifies, 'the bot to reconnect', 15000);
    await sleep(500);
    reaction('ADD', U(6), CIS);
    await waitFor(() => gw.members.get(U(6))!.roles.has(E.roleEEU), 'a reaction handled after reconnect');
    assert.equal(exitCode, undefined);
  });

  it('shuts down cleanly on SIGTERM', async () => {
    bot.kill('SIGTERM');
    await waitFor(() => exitCode !== undefined, 'the process to exit');
    assert.equal(exitCode, 0);
    assert.match(output, /Shutting down/);
  });
});
