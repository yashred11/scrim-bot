import { Routes, type REST } from 'discord.js';
import type { Logger } from './logger.js';

export type RestLike = Pick<REST, 'get' | 'put' | 'delete' | 'post' | 'patch'>;
export type Notify = (text: string) => void;

const SAME_TEXT_COOLDOWN_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 1000;

/**
 * Posts important problems to NOTIFY_CHANNEL. Identical messages are suppressed for 10 minutes
 * and no more than one message goes out every 5 seconds, so a persistent failure cannot flood
 * the channel. Never throws.
 */
export function createNotifier(
  rest: RestLike,
  channelId: string | undefined,
  logger: Logger,
  now: () => number = Date.now,
): Notify {
  const lastSent = new Map<string, number>();
  let lastAny = 0;

  return (text: string): void => {
    if (!channelId) return;
    const t = now();
    const previous = lastSent.get(text);
    if (previous !== undefined && t - previous < SAME_TEXT_COOLDOWN_MS) return;
    if (t - lastAny < MIN_INTERVAL_MS) return;
    lastSent.set(text, t);
    lastAny = t;

    rest
      .post(Routes.channelMessages(channelId), {
        body: { content: text.slice(0, 1900), allowed_mentions: { parse: [] } },
      })
      .catch((e: unknown) => logger.warn('Could not post to the notify channel', { error: e }));
  };
}
