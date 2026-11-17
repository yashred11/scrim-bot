import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

function run(env: Record<string, string>) {
  const entry = process.env.E2E_ENTRY ?? 'src/index.ts';
  return spawnSync(process.execPath, entry.endsWith('.ts') ? ['--import', 'tsx', entry] : [entry], {
    env: { PATH: process.env.PATH, HEALTH_PORT: '0', ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
}

describe('startup failures are clear and exit non-zero', () => {
  it('prints every config problem and exits with code 2', () => {
    const r = run({ GUILD_ID: 'nope' });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /DISCORD_TOKEN/);
    assert.match(r.stdout, /GUILD_ID must be a Discord ID/);
    assert.match(r.stdout, /ROLE_CHANNEL is required/);
    assert.match(r.stdout, /ROLE_MAPPING is required/);
  });

  it('exits with code 1 and a logged reason when the token is rejected', () => {
    const r = run({
      DISCORD_TOKEN: 'not-a-real-token',
      GUILD_ID: '286578921464528897',
      ROLE_CHANNEL: '715215514917404714',
      ROLE_MAPPING: '🇪🇺!312187620300161034',
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /Login failed/);
  });
});
