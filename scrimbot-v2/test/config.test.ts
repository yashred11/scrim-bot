import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, loadConfig, parseRoleMapping } from '../src/config.js';
import { emojiKey, parseEmojiSpec } from '../src/emoji.js';

// The exact value used in the production ConfigMap of the old bot.
const PRODUCTION_MAPPING =
  'CIS:571021359728033822!525701397895970826|🇪🇺!312187620300161034|🇺🇸!312108246892806155|SouthAmerica:571021393987108882!525704926853333012|🌏!311813622802153472|LFT:570733976600182814!455334715784953856|MiddleEast:1173234161675423775!1171071913418825798';

const baseEnv = {
  DISCORD_TOKEN: 'token',
  GUILD_ID: '286578921464528897',
  ROLE_CHANNEL: '715215514917404714',
  ROLE_MAPPING: PRODUCTION_MAPPING,
};

describe('emoji parsing', () => {
  it('matches custom emoji by id, so a rename does not break the mapping', () => {
    const parsed = parseEmojiSpec('CIS:571021359728033822');
    assert.equal(parsed.key, 'custom:571021359728033822');
    assert.equal(emojiKey({ id: '571021359728033822', name: 'renamed_emoji' }), parsed.key);
  });

  it('renders custom and animated emoji for the embed', () => {
    assert.equal(parseEmojiSpec('CIS:571021359728033822').display, '<:CIS:571021359728033822>');
    assert.equal(parseEmojiSpec('a:party:571021359728033822').display, '<a:party:571021359728033822>');
  });

  it('ignores the U+FE0F variation selector when matching unicode emoji', () => {
    assert.equal(parseEmojiSpec('❤️').key, emojiKey({ id: null, name: '❤' }));
    assert.equal(emojiKey({ id: null, name: '🌏' }), parseEmojiSpec('🌏').key);
  });

  it('url-encodes unicode emoji for REST routes but not custom ones', () => {
    assert.equal(parseEmojiSpec('🌏').routeParam, encodeURIComponent('🌏'));
    assert.equal(parseEmojiSpec('LFT:570733976600182814').routeParam, 'LFT:570733976600182814');
  });

  it('rejects a custom emoji written without an id', () => {
    assert.throws(() => parseEmojiSpec('CIS'), /name:id/);
  });
});

describe('ROLE_MAPPING', () => {
  it('parses the production value into the 7 regional entries', () => {
    const entries = parseRoleMapping(PRODUCTION_MAPPING);
    assert.equal(entries.length, 7);
    assert.equal(entries[0]?.roleId, '525701397895970826');
    assert.equal(entries[6]?.roleId, '1171071913418825798');
  });

  it('reports every problem at once', () => {
    assert.throws(
      () => parseRoleMapping('🇪🇺!123|🇺🇸|CIS!525701397895970826'),
      (e: unknown) => e instanceof ConfigError && e.problems.length === 3,
    );
  });

  it('rejects the same emoji twice', () => {
    assert.throws(() => parseRoleMapping('🇪🇺!312187620300161034|🇪🇺!312108246892806155'), /twice/);
  });
});

describe('loadConfig', () => {
  it('accepts the old DISCORD_CLIENT_SECRET name so the existing Kubernetes secret keeps working', () => {
    const { DISCORD_TOKEN: _unused, ...rest } = baseEnv;
    const config = loadConfig({ ...rest, DISCORD_CLIENT_SECRET: 'old-name' });
    assert.equal(config.token, 'old-name');
  });

  it('applies defaults', () => {
    const config = loadConfig(baseEnv);
    assert.equal(config.syncOnStart, 'add');
    assert.equal(config.healthPort, 8080);
    assert.equal(config.logLevel, 'info');
    assert.equal(config.messageId, undefined);
  });

  it('lowercases the command role allow list and splits on |', () => {
    const config = loadConfig({ ...baseEnv, ROLE_PERMISSION_ALLOWED_ROLES: 'Admin|Senior Moderator|Moderator' });
    assert.deepEqual(config.commandRoles, ['admin', 'senior moderator', 'moderator']);
  });

  it('fails with a readable list when required values are missing or wrong', () => {
    assert.throws(
      () => loadConfig({ GUILD_ID: 'abc', ROLE_MAPPING: '' }),
      (e: unknown) =>
        e instanceof ConfigError &&
        e.problems.some((p) => p.includes('DISCORD_TOKEN')) &&
        e.problems.some((p) => p.includes('GUILD_ID')) &&
        e.problems.some((p) => p.includes('ROLE_CHANNEL')) &&
        e.problems.some((p) => p.includes('ROLE_MAPPING')),
    );
  });

  it('rejects more than 20 reactions', () => {
    const many = Array.from({ length: 21 }, (_, i) => `${String.fromCodePoint(0x1f600 + i)}!50000000000000${String(i).padStart(4, '0')}`).join('|');
    assert.throws(() => loadConfig({ ...baseEnv, ROLE_MAPPING: many }), /20/);
  });
});
