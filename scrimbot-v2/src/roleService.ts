import { Routes } from 'discord.js';
import type { RoleEntry } from './config.js';
import { emojiKey } from './emoji.js';
import { apiErrorCode, apiErrorStatus, errorMessage } from './errors.js';
import { silentLogger, type Logger } from './logger.js';
import type { Notify, RestLike } from './notifier.js';

interface ReactionPayload {
  user_id: string;
  message_id: string;
  channel_id: string;
  guild_id?: string;
  emoji: { id: string | null; name: string | null };
  member?: { user?: { bot?: boolean } };
}

type Outcome = 'ok' | 'gone' | 'failed';

export interface SyncOptions {
  /** false = report only, change nothing. */
  apply: boolean;
  /** true = also take the role from holders who have no matching reaction. */
  remove: boolean;
}

export interface RolePlan {
  roleId: string;
  emoji: string;
  reactors: number;
  holders: number;
  toAdd: number;
  toRemove: number;
}

export interface SyncReport {
  dryRun: boolean;
  remove: boolean;
  perRole: RolePlan[];
  added: number;
  removed: number;
  failed: number;
  /** Reacted but already left the server. */
  gone: number;
  /** Changed by a live reaction while the sync was running, so the sync left them alone. */
  skippedLive: number;
  durationMs: number;
}

export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface RoleServiceDeps {
  rest: RestLike;
  guildId: string;
  roles: RoleEntry[];
  botUserId: string;
  logger?: Logger;
  notify?: Notify;
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: number[];
}

const REACTION_PAGE = 100;
const MEMBER_PAGE = 1000;
const SYNC_CONCURRENCY = 4;
const UNKNOWN_EMOJI = 10014;

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class RoleService {
  private readonly rest: RestLike;
  private readonly guildId: string;
  private readonly roles: RoleEntry[];
  private readonly botUserId: string;
  private readonly log: Logger;
  private readonly notify: Notify;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retryDelaysMs: number[];
  private readonly roleByKey = new Map<string, RoleEntry>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly touched = new Set<string>();
  private syncing = false;

  private channelId: string | undefined;
  private messageId: string | undefined;

  readonly stats = { added: 0, removed: 0, errors: 0, ignored: 0, lastEventAt: undefined as Date | undefined };

  constructor(deps: RoleServiceDeps) {
    this.rest = deps.rest;
    this.guildId = deps.guildId;
    this.roles = deps.roles;
    this.botUserId = deps.botUserId;
    this.log = deps.logger ?? silentLogger;
    this.notify = deps.notify ?? (() => {});
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.retryDelaysMs = deps.retryDelaysMs ?? [1000, 3000];
    for (const entry of deps.roles) this.roleByKey.set(entry.emoji.key, entry);
  }

  get watchedMessage(): { channelId: string; messageId: string } | undefined {
    if (!this.channelId || !this.messageId) return undefined;
    return { channelId: this.channelId, messageId: this.messageId };
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  setMessage(channelId: string, messageId: string): void {
    this.channelId = channelId;
    this.messageId = messageId;
  }

  /**
   * Handles one raw gateway packet. Works on the packet alone, so it does not depend on
   * discord.js caches or partials. Never throws.
   */
  async handleRaw(packet: unknown): Promise<void> {
    const p = packet as { t?: string | null; d?: ReactionPayload } | null;
    if (!p || !p.d) return;
    if (p.t !== 'MESSAGE_REACTION_ADD' && p.t !== 'MESSAGE_REACTION_REMOVE') return;
    const d = p.d;

    if (!this.messageId || d.message_id !== this.messageId) return;
    if (d.guild_id !== this.guildId) return;

    const key = emojiKey(d.emoji);
    const entry = key ? this.roleByKey.get(key) : undefined;
    if (!entry) {
      this.stats.ignored++;
      return;
    }
    if (d.user_id === this.botUserId) return;

    const add = p.t === 'MESSAGE_REACTION_ADD';
    if (add && d.member?.user?.bot) return;

    this.stats.lastEventAt = new Date();
    if (this.syncing) this.touched.add(d.user_id);

    await this.enqueue(d.user_id, () =>
      this.setRole(d.user_id, entry.roleId, add, `Reaction role ${add ? 'added' : 'removed'}: ${entry.emoji.display}`),
    );
  }

  /** Runs tasks for the same user strictly in the order they arrived. */
  private enqueue<T>(userId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(userId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tracked = run.finally(() => {
      if (this.chains.get(userId) === tracked) this.chains.delete(userId);
    });
    this.chains.set(userId, tracked);
    return run;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        const status = apiErrorStatus(e);
        const retryable = status === undefined || status >= 500;
        if (!retryable || attempt >= this.retryDelaysMs.length) throw e;
        await this.sleep(this.retryDelaysMs[attempt++] as number);
      }
    }
  }

  private async setRole(userId: string, roleId: string, add: boolean, reason: string): Promise<Outcome> {
    const route = Routes.guildMemberRole(this.guildId, userId, roleId);
    try {
      await this.withRetry(() => (add ? this.rest.put(route, { reason }) : this.rest.delete(route, { reason })));
      if (add) this.stats.added++;
      else this.stats.removed++;
      this.log.info(add ? 'Role added' : 'Role removed', { userId, roleId });
      return 'ok';
    } catch (e) {
      const code = apiErrorCode(e);
      if (code === 10007 || code === 10013) {
        this.log.debug('Member is no longer in the server', { userId });
        return 'gone';
      }
      this.stats.errors++;
      this.log.error(add ? 'Failed to add role' : 'Failed to remove role', { userId, roleId, error: e });
      if (code === 50013 || code === 50001) {
        this.notify(
          `Cannot ${add ? 'add' : 'remove'} role <@&${roleId}>: Missing Permissions. ` +
            'The bot needs Manage Roles and its own role must sit above the regional roles.',
        );
      } else if (code === 10011) {
        this.notify(`Role ${roleId} from ROLE_MAPPING does not exist in this server.`);
      } else {
        this.notify(`Role update failed for <@${userId}> (${errorMessage(e)}).`);
      }
      return 'failed';
    }
  }

  // ---------------------------------------------------------------- sync

  private async fetchReactors(
    channelId: string,
    messageId: string,
    entry: RoleEntry,
  ): Promise<{ users: Set<string>; missing: boolean }> {
    const users = new Set<string>();
    // type 0 = normal reaction, type 1 = super reaction
    for (const type of [0, 1]) {
      let after: string | undefined;
      for (;;) {
        const query = new URLSearchParams({ limit: String(REACTION_PAGE), type: String(type) });
        if (after) query.set('after', after);
        let page: { id: string; bot?: boolean }[];
        try {
          page = (await this.withRetry(() =>
            this.rest.get(Routes.channelMessageReaction(channelId, messageId, entry.emoji.routeParam), { query }),
          )) as { id: string; bot?: boolean }[];
        } catch (e) {
          if (apiErrorCode(e) === UNKNOWN_EMOJI) return { users, missing: true };
          throw e;
        }
        for (const u of page) if (!u.bot && u.id !== this.botUserId) users.add(u.id);
        if (page.length < REACTION_PAGE) break;
        after = page[page.length - 1]?.id;
      }
    }
    return { users, missing: false };
  }

  private async fetchHolders(roleIds: string[]): Promise<{ holders: Map<string, Set<string>>; bots: Set<string> }> {
    const wanted = new Set(roleIds);
    const holders = new Map<string, Set<string>>(roleIds.map((id) => [id, new Set<string>()]));
    const bots = new Set<string>();
    let after = '0';
    for (;;) {
      const query = new URLSearchParams({ limit: String(MEMBER_PAGE), after });
      const members = (await this.withRetry(() => this.rest.get(Routes.guildMembers(this.guildId), { query }))) as {
        user: { id: string; bot?: boolean };
        roles: string[];
      }[];
      for (const m of members) {
        if (m.user.bot) bots.add(m.user.id);
        for (const roleId of m.roles) if (wanted.has(roleId)) holders.get(roleId)?.add(m.user.id);
      }
      if (members.length < MEMBER_PAGE) break;
      after = (members[members.length - 1] as { user: { id: string } }).user.id;
    }
    return { holders, bots };
  }

  /**
   * Compares who reacted with who holds each role and fixes the difference. With apply=false it
   * only reports. Any failure while reading aborts the whole run before anything is changed.
   */
  async sync(opts: SyncOptions): Promise<SyncReport> {
    if (!this.channelId || !this.messageId) throw new SyncError('No role message is configured or found.');
    if (this.syncing) throw new SyncError('A sync is already running.');
    const { channelId, messageId } = this;

    this.syncing = true;
    this.touched.clear();
    const started = Date.now();

    try {
      const reactorsByRole = new Map<string, Set<string>>();
      const emojiByRole = new Map<string, string[]>();
      const missingEmoji: string[] = [];

      for (const entry of this.roles) {
        const { users, missing } = await this.fetchReactors(channelId, messageId, entry);
        if (missing) missingEmoji.push(entry.emoji.display);
        const set = reactorsByRole.get(entry.roleId) ?? new Set<string>();
        users.forEach((u) => set.add(u));
        reactorsByRole.set(entry.roleId, set);
        emojiByRole.set(entry.roleId, [...(emojiByRole.get(entry.roleId) ?? []), entry.emoji.display]);
      }

      if (opts.remove && missingEmoji.length > 0) {
        throw new SyncError(
          `Refusing to remove roles: the reaction ${missingEmoji.join(', ')} is not on the message, ` +
            'so everyone would look like they never reacted. Run /rolepoll first.',
        );
      }

      const { holders, bots } = await this.fetchHolders([...reactorsByRole.keys()]);

      const perRole: RolePlan[] = [];
      const tasks: { userId: string; roleId: string; add: boolean }[] = [];

      for (const [roleId, reactors] of reactorsByRole) {
        const held = holders.get(roleId) ?? new Set<string>();
        const toAdd = [...reactors].filter((u) => !held.has(u));
        const toRemove = opts.remove ? [...held].filter((u) => !reactors.has(u) && !bots.has(u)) : [];

        if (opts.remove && held.size >= 20 && toRemove.length > held.size * 0.5) {
          throw new SyncError(
            `Refusing to remove ${toRemove.length} of ${held.size} holders of role ${roleId}. ` +
              'That is more than half, which usually means the role is also given out another way.',
          );
        }

        perRole.push({
          roleId,
          emoji: (emojiByRole.get(roleId) ?? []).join(' '),
          reactors: reactors.size,
          holders: held.size,
          toAdd: toAdd.length,
          toRemove: toRemove.length,
        });
        for (const userId of toAdd) tasks.push({ userId, roleId, add: true });
        for (const userId of toRemove) tasks.push({ userId, roleId, add: false });
      }

      const report: SyncReport = {
        dryRun: !opts.apply,
        remove: opts.remove,
        perRole,
        added: 0,
        removed: 0,
        failed: 0,
        gone: 0,
        skippedLive: 0,
        durationMs: 0,
      };

      if (opts.apply) {
        await runPool(tasks, SYNC_CONCURRENCY, async (task) => {
          if (this.touched.has(task.userId)) {
            report.skippedLive++;
            return;
          }
          const outcome = await this.enqueue(task.userId, () =>
            this.setRole(task.userId, task.roleId, task.add, 'Reaction role sync'),
          );
          if (outcome === 'gone') report.gone++;
          else if (outcome === 'failed') report.failed++;
          else if (task.add) report.added++;
          else report.removed++;
        });
      }

      report.durationMs = Date.now() - started;
      this.log.info('Sync finished', { ...report, perRole: undefined });
      return report;
    } finally {
      this.syncing = false;
      this.touched.clear();
    }
  }
}
