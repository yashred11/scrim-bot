import type { RestLike } from '../src/notifier.js';

export class FakeApiError extends Error {
  constructor(
    public code: number,
    public status: number,
  ) {
    super(`Discord API error [${code}]`);
    this.name = 'DiscordAPIError';
  }
}

export interface FakeMember {
  id: string;
  bot?: boolean;
  roles: Set<string>;
}

export const IDS = {
  guild: '100000000000000001',
  channel: '200000000000000001',
  message: '300000000000000001',
  bot: '400000000000000001',
  roleEEU: '500000000000000001',
  roleWEU: '500000000000000002',
  roleNA: '500000000000000003',
  emojiCIS: '600000000000000001',
};

const big = (s: string) => BigInt(s);

/** In-memory stand-in for the parts of the Discord REST API the bot uses. */
export class FakeDiscord {
  members = new Map<string, FakeMember>();
  /** decoded emoji route param -> user ids who reacted (normal reactions) */
  reactions = new Map<string, Set<string>>();
  ownReactions = new Set<string>();
  calls: { method: string; route: string; query?: Record<string, string>; body?: unknown }[] = [];
  messageExists = true;
  messageAuthorId = IDS.bot;
  messageTitle: string | undefined = 'Regional Role Assignment';
  /** return an error to make a role PUT/DELETE fail */
  roleFailure: ((method: string, userId: string, roleId: string) => Error | undefined) | undefined;
  /** make reaction listing fail with this error */
  reactionListFailure: Error | undefined;
  /** delay (ms) before a role PUT/DELETE resolves, per user */
  roleDelay: ((userId: string) => number) | undefined;
  private nextMessageId = 900000000000000001n;

  rest: RestLike = {
    get: (route: string, options?: { query?: URLSearchParams }) => this.handle('GET', route, options),
    put: (route: string, options?: { query?: URLSearchParams }) => this.handle('PUT', route, options),
    delete: (route: string, options?: { query?: URLSearchParams }) => this.handle('DELETE', route, options),
    post: (route: string, options?: { body?: unknown }) => this.handle('POST', route, options),
    patch: (route: string, options?: { body?: unknown }) => this.handle('PATCH', route, options),
  } as unknown as RestLike;

  addMember(id: string, roles: string[] = [], bot = false): void {
    this.members.set(id, { id, bot, roles: new Set(roles) });
  }

  react(emojiParam: string, userId: string): void {
    const set = this.reactions.get(emojiParam) ?? new Set<string>();
    set.add(userId);
    this.reactions.set(emojiParam, set);
  }

  callsTo(method: string, pattern: RegExp): { route: string }[] {
    return this.calls.filter((c) => c.method === method && pattern.test(c.route));
  }

  private async handle(method: string, route: string, options?: { query?: URLSearchParams; body?: unknown }): Promise<unknown> {
    const query = options?.query ? Object.fromEntries(options.query.entries()) : undefined;
    this.calls.push({ method, route, query, body: options?.body });

    let m: RegExpExecArray | null;

    if ((m = /^\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/.exec(route))) {
      const [, , userId, roleId] = m as unknown as [string, string, string, string];
      const delay = this.roleDelay?.(userId) ?? 0;
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const failure = this.roleFailure?.(method, userId, roleId);
      if (failure) throw failure;
      const member = this.members.get(userId);
      if (!member) throw new FakeApiError(10007, 404);
      if (method === 'PUT') member.roles.add(roleId);
      else member.roles.delete(roleId);
      return undefined;
    }

    if ((m = /^\/guilds\/(\d+)\/members$/.exec(route)) && method === 'GET') {
      const limit = Number(query?.limit ?? 1);
      const after = big(query?.after ?? '0');
      return [...this.members.values()]
        .filter((x) => big(x.id) > after)
        .sort((a, b) => (big(a.id) < big(b.id) ? -1 : 1))
        .slice(0, limit)
        .map((x) => ({ user: { id: x.id, bot: x.bot ?? false }, roles: [...x.roles] }));
    }

    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/(.+)\/@me$/.exec(route)) && method === 'PUT') {
      this.ownReactions.add(decodeURIComponent(m[3] as string));
      if (!this.reactions.has(decodeURIComponent(m[3] as string))) this.reactions.set(decodeURIComponent(m[3] as string), new Set());
      return undefined;
    }

    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/(.+)$/.exec(route)) && method === 'GET') {
      if (this.reactionListFailure) throw this.reactionListFailure;
      const key = decodeURIComponent(m[3] as string);
      const users = this.reactions.get(key);
      if (!users) throw new FakeApiError(10014, 404);
      if ((query?.type ?? '0') !== '0') return [];
      const limit = Number(query?.limit ?? 25);
      const after = big(query?.after ?? '0');
      return [...users]
        .filter((id) => big(id) > after)
        .sort((a, b) => (big(a) < big(b) ? -1 : 1))
        .slice(0, limit)
        .map((id) => ({ id, bot: this.members.get(id)?.bot ?? false }));
    }

    if ((m = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route))) {
      if (!this.messageExists) throw new FakeApiError(10008, 404);
      if (method === 'PATCH') {
        this.messageTitle = (options?.body as { embeds: { title: string }[] }).embeds[0]?.title;
        return this.messageJson(m[2] as string);
      }
      return this.messageJson(m[2] as string);
    }

    if ((m = /^\/channels\/(\d+)\/messages$/.exec(route))) {
      if (method === 'POST') {
        const id = String(this.nextMessageId++);
        this.messageExists = true;
        this.messageAuthorId = IDS.bot;
        this.messageTitle = (options?.body as { embeds: { title: string }[] }).embeds[0]?.title;
        this.ownReactions.clear();
        return this.messageJson(id);
      }
      return this.messageExists
        ? [{ id: IDS.message, author: { id: this.messageAuthorId }, embeds: [{ title: this.messageTitle }] }]
        : [];
    }

    throw new Error(`FakeDiscord: unhandled ${method} ${route}`);
  }

  private messageJson(id: string): unknown {
    return {
      id,
      author: { id: this.messageAuthorId },
      embeds: [{ title: this.messageTitle }],
      reactions: [...this.reactions.keys()].map((key) => {
        const idx = key.lastIndexOf(':');
        const emoji = idx > 0 ? { id: key.slice(idx + 1), name: key.slice(0, idx) } : { id: null, name: key };
        return { emoji, me: this.ownReactions.has(key), count: this.reactions.get(key)?.size ?? 0 };
      }),
    };
  }
}

export function reactionPacket(
  type: 'ADD' | 'REMOVE',
  userId: string,
  emoji: { id: string | null; name: string | null },
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    t: `MESSAGE_REACTION_${type}`,
    d: {
      user_id: userId,
      message_id: IDS.message,
      channel_id: IDS.channel,
      guild_id: IDS.guild,
      emoji,
      ...(type === 'ADD' ? { member: { user: { id: userId, bot: false } } } : {}),
      ...overrides,
    },
  };
}
