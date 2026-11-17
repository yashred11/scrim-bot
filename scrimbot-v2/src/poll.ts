import { Routes } from 'discord.js';
import type { RoleEntry } from './config.js';
import { emojiKey } from './emoji.js';
import { apiErrorCode } from './errors.js';
import type { RestLike } from './notifier.js';

export const POLL_TITLE = 'Regional Role Assignment';
const EMBED_COLOR = 0x1abc9c; // same teal as the original message

interface ApiMessage {
  id: string;
  channel_id?: string;
  author?: { id: string };
  embeds?: { title?: string }[];
  reactions?: { emoji: { id: string | null; name: string | null }; me: boolean }[];
}

/** Message body in the same wording as the original message. */
export function buildPollBody(entries: RoleEntry[]): { embeds: { title: string; description: string; color: number }[] } {
  const lines = [
    'Please react to this message with a corresponding emoji to get your regional role assigned to yourself.',
    'With that role you will be able to see your regional channels.',
    'Thank you.',
    '',
    ...entries.map((e) => `${e.emoji.display} - <@&${e.roleId}>`),
  ];
  return { embeds: [{ title: POLL_TITLE, description: lines.join('\n'), color: EMBED_COLOR }] };
}

/** Finds the newest role message this bot posted in the channel. */
export async function discoverPollMessage(
  rest: RestLike,
  channelId: string,
  botUserId: string,
): Promise<string | undefined> {
  const messages = (await rest.get(Routes.channelMessages(channelId), {
    query: new URLSearchParams({ limit: '100' }),
  })) as ApiMessage[];
  return messages.find((m) => m.author?.id === botUserId && m.embeds?.some((e) => e.title === POLL_TITLE))?.id;
}

/** Returns the message if it exists, or undefined when Discord says it was deleted. */
export async function fetchPollMessage(rest: RestLike, channelId: string, messageId: string): Promise<ApiMessage | undefined> {
  try {
    return (await rest.get(Routes.channelMessage(channelId, messageId))) as ApiMessage;
  } catch (e) {
    if (apiErrorCode(e) === 10008) return undefined;
    throw e;
  }
}

export interface PublishResult {
  messageId: string;
  channelId: string;
  created: boolean;
  reactionsAdded: number;
}

/**
 * Edits the existing role message, or posts a new one, then adds any missing reactions.
 * A message written by a different bot cannot be edited, so that case is reported to the caller.
 */
export async function publishPoll(
  rest: RestLike,
  opts: { channelId: string; botUserId: string; entries: RoleEntry[]; existing?: { channelId: string; messageId: string }; forceNew?: boolean },
): Promise<PublishResult> {
  const body = buildPollBody(opts.entries);
  let message: ApiMessage | undefined;
  let created = false;

  if (opts.existing && !opts.forceNew) {
    message = await fetchPollMessage(rest, opts.existing.channelId, opts.existing.messageId);
    if (message && message.author?.id !== opts.botUserId) {
      throw new Error(
        'The current role message was posted by a different account, so this bot cannot edit it. ' +
          'Reactions on it still work. Use /rolepoll new:true to post a fresh message instead.',
      );
    }
    if (message) {
      message = (await rest.patch(Routes.channelMessage(opts.existing.channelId, opts.existing.messageId), { body })) as ApiMessage;
      message = (await fetchPollMessage(rest, opts.existing.channelId, opts.existing.messageId)) ?? message;
    }
  }

  const channelId = message ? (opts.existing as { channelId: string }).channelId : opts.channelId;
  if (!message) {
    message = (await rest.post(Routes.channelMessages(channelId), { body })) as ApiMessage;
    created = true;
  }

  const have = new Set(
    (message.reactions ?? []).filter((r) => r.me).map((r) => emojiKey(r.emoji)),
  );
  let reactionsAdded = 0;
  for (const entry of opts.entries) {
    if (have.has(entry.emoji.key)) continue;
    await rest.put(Routes.channelMessageOwnReaction(channelId, message.id, entry.emoji.routeParam));
    reactionsAdded++;
  }

  return { messageId: message.id, channelId, created, reactionsAdded };
}
