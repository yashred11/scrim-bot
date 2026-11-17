import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRoleMapping } from '../src/config.js';
import { buildPollBody, discoverPollMessage, publishPoll } from '../src/poll.js';
import { FakeDiscord, IDS } from './fakeDiscord.js';

const entries = parseRoleMapping(`CIS:${IDS.emojiCIS}!${IDS.roleEEU}|🇪🇺!${IDS.roleWEU}`);

describe('poll message', () => {
  it('uses the same title and wording as the original message', () => {
    const body = buildPollBody(entries);
    const embed = body.embeds[0]!;
    assert.equal(embed.title, 'Regional Role Assignment');
    assert.match(embed.description, /^Please react to this message with a corresponding emoji to get your regional role assigned to yourself\.\nWith that role you will be able to see your regional channels\.\nThank you\.\n\n/);
    assert.match(embed.description, new RegExp(`<:CIS:${IDS.emojiCIS}> - <@&${IDS.roleEEU}>`));
    assert.match(embed.description, new RegExp(`🇪🇺 - <@&${IDS.roleWEU}>`));
  });

  it('finds the bot\'s own role message when no id is configured', async () => {
    const discord = new FakeDiscord();
    assert.equal(await discoverPollMessage(discord.rest, IDS.channel, IDS.bot), IDS.message);
  });

  it('does not adopt a role-looking message from someone else', async () => {
    const discord = new FakeDiscord();
    discord.messageAuthorId = '123456789012345678';
    assert.equal(await discoverPollMessage(discord.rest, IDS.channel, IDS.bot), undefined);
  });
});

describe('publishPoll', () => {
  it('edits the existing message and adds only the missing reactions', async () => {
    const discord = new FakeDiscord();
    discord.reactions.set(`CIS:${IDS.emojiCIS}`, new Set());
    discord.ownReactions.add(`CIS:${IDS.emojiCIS}`); // already reacted
    const result = await publishPoll(discord.rest, {
      channelId: IDS.channel,
      botUserId: IDS.bot,
      entries,
      existing: { channelId: IDS.channel, messageId: IDS.message },
    });
    assert.equal(result.created, false);
    assert.equal(result.messageId, IDS.message);
    assert.equal(result.reactionsAdded, 1);
    assert.equal(discord.callsTo('PUT', /reactions/).length, 1);
    assert.equal(discord.callsTo('PATCH', /messages/).length, 1);
  });

  it('posts a new message when the old one was deleted', async () => {
    const discord = new FakeDiscord();
    discord.messageExists = false;
    const result = await publishPoll(discord.rest, {
      channelId: IDS.channel,
      botUserId: IDS.bot,
      entries,
      existing: { channelId: IDS.channel, messageId: IDS.message },
    });
    assert.equal(result.created, true);
    assert.notEqual(result.messageId, IDS.message);
    assert.equal(result.reactionsAdded, 2);
  });

  it('posts a new message on request without touching the old one', async () => {
    const discord = new FakeDiscord();
    const result = await publishPoll(discord.rest, {
      channelId: IDS.channel,
      botUserId: IDS.bot,
      entries,
      existing: { channelId: IDS.channel, messageId: IDS.message },
      forceNew: true,
    });
    assert.equal(result.created, true);
    assert.equal(discord.callsTo('PATCH', /messages/).length, 0);
  });

  it('explains why it cannot edit a message written by a different account', async () => {
    const discord = new FakeDiscord();
    discord.messageAuthorId = '123456789012345678';
    await assert.rejects(
      () =>
        publishPoll(discord.rest, {
          channelId: IDS.channel,
          botUserId: IDS.bot,
          entries,
          existing: { channelId: IDS.channel, messageId: IDS.message },
        }),
      /different account.*new:true/s,
    );
    assert.equal(discord.callsTo('PATCH', /messages/).length, 0);
  });
});
