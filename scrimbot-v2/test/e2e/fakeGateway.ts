import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export const E = {
  guild: '286578921464528897',
  channel: '715215514917404714',
  message: '1173349584609755206',
  bot: '800000000000000001',
  everyoneRole: '286578921464528897',
  botRole: '800000000000000010',
  modRole: '800000000000000011',
  roleEEU: '525701397895970826',
  roleNA: '312108246892806155',
  roleSEA: '311813622802153472',
  emojiCIS: '571021359728033822',
};

const BIG = (s: string) => BigInt(s);

export interface RestCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

/** A just-enough Discord: HTTP REST on /api/v10 and a real WebSocket gateway on the same port. */
export class FakeGateway {
  private server = http.createServer((req, res) => void this.onHttp(req, res));
  private wss = new WebSocketServer({ server: this.server });
  private sockets = new Set<WebSocket>();
  private seq = 0;
  port = 0;

  calls: RestCall[] = [];
  identifyIntents: number | undefined;
  identifyCount = 0;
  resumeCount = 0;
  members = new Map<string, { roles: Set<string>; bot?: boolean }>();
  reactions = new Map<string, Set<string>>(); // decoded emoji param -> user ids
  failRolePutFor = new Set<string>();
  commands: unknown[] = [];

  async start(): Promise<void> {
    this.wss.on('connection', (ws) => this.onSocket(ws));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get apiBase(): string {
    return `http://127.0.0.1:${this.port}/api`;
  }

  dispatch(t: string, d: unknown): void {
    const payload = JSON.stringify({ op: 0, t, s: ++this.seq, d });
    for (const s of this.sockets) s.send(payload);
  }

  /** Close the gateway connection from the server side, like a network drop. */
  dropConnections(code = 4000): void {
    for (const s of this.sockets) s.close(code, 'test drop');
  }

  callsMatching(method: string, pattern: RegExp): RestCall[] {
    return this.calls.filter((c) => c.method === method && pattern.test(c.path));
  }

  private user(id: string, bot = false) {
    return { id, username: `user${id.slice(-4)}`, discriminator: '0', avatar: null, bot, global_name: null };
  }

  private onSocket(ws: WebSocket): void {
    this.sockets.add(ws);
    ws.on('close', () => this.sockets.delete(ws));
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30000 } }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as { op: number; d?: { intents?: number } };
      if (msg.op === 1) {
        ws.send(JSON.stringify({ op: 11 }));
      } else if (msg.op === 2) {
        this.identifyCount++;
        this.identifyIntents = msg.d?.intents;
        const ready = {
          v: 10,
          user: this.user(E.bot, true),
          guilds: [{ id: E.guild, unavailable: true }],
          session_id: 'session-1',
          resume_gateway_url: `ws://127.0.0.1:${this.port}`,
          application: { id: E.bot, flags: 0 },
          shard: [0, 1],
        };
        ws.send(JSON.stringify({ op: 0, t: 'READY', s: ++this.seq, d: ready }));
        setTimeout(() => this.dispatch('GUILD_CREATE', this.guildPayload()), 30);
      } else if (msg.op === 6) {
        this.resumeCount++;
        ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: ++this.seq, d: {} }));
      }
    });
  }

  private roles() {
    const role = (id: string, name: string, position: number, permissions: string) => ({
      id, name, position, permissions, color: 0, hoist: false, managed: false, mentionable: false, flags: 0,
    });
    return [
      // @everyone can see and use the role channel
      role(E.everyoneRole, '@everyone', 0, String(1024 + 2048 + 16384 + 65536 + 64)),
      role(E.roleEEU, 'EEU', 1, '0'),
      role(E.roleNA, 'NA', 2, '0'),
      role(E.roleSEA, 'SEA', 3, '0'),
      role(E.modRole, 'Moderator', 5, '0'),
      role(E.botRole, 'ScrimbotRole', 10, '268435456'), // Manage Roles
    ];
  }

  private guildPayload() {
    return {
      id: E.guild,
      name: 'Fake Scrims',
      icon: null,
      features: [],
      owner_id: '1',
      roles: this.roles(),
      emojis: [],
      stickers: [],
      channels: [{ id: E.channel, type: 0, name: 'roles', guild_id: E.guild, position: 0, permission_overwrites: [] }],
      threads: [],
      members: [],
      presences: [],
      voice_states: [],
      stage_instances: [],
      guild_scheduled_events: [],
      member_count: 12000,
      large: true,
      unavailable: false,
      joined_at: new Date().toISOString(),
      premium_tier: 0,
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      mfa_level: 0,
      preferred_locale: 'en-US',
      nsfw_level: 0,
      system_channel_flags: 0,
    };
  }

  private async onHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = decodeURIComponent(url.pathname).replace(/^\/api\/v10/, '');
    const query = Object.fromEntries(url.searchParams.entries());
    let bodyText = '';
    for await (const chunk of req) bodyText += chunk;
    let body: unknown;
    try {
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      body = bodyText;
    }
    const method = req.method ?? 'GET';
    this.calls.push({ method, path, query, body });

    const json = (status: number, data: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    const empty = (): void => {
      res.writeHead(204).end();
    };
    let m: RegExpExecArray | null;

    if (method === 'GET' && path === '/gateway/bot') {
      return json(200, {
        url: `ws://127.0.0.1:${this.port}`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      });
    }
    if ((m = /^\/guilds\/\d+\/members\/(\d+)\/roles\/(\d+)$/.exec(path))) {
      const [, userId, roleId] = m as unknown as [string, string, string];
      if (this.failRolePutFor.has(userId)) return json(403, { code: 50013, message: 'Missing Permissions' });
      const member = this.members.get(userId);
      if (!member) return json(404, { code: 10007, message: 'Unknown Member' });
      if (method === 'PUT') member.roles.add(roleId);
      else member.roles.delete(roleId);
      return empty();
    }
    if (method === 'GET' && path === `/guilds/${E.guild}/members/${E.bot}`) {
      return json(200, { user: this.user(E.bot, true), roles: [E.botRole], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 });
    }
    if (method === 'GET' && path === `/guilds/${E.guild}/roles`) return json(200, this.roles());
    if (method === 'GET' && path === `/guilds/${E.guild}/members`) {
      const after = BIG(query.after ?? '0');
      const limit = Number(query.limit ?? 1);
      const page = [...this.members.entries()]
        .filter(([id]) => BIG(id) > after)
        .sort((a, b) => (BIG(a[0]) < BIG(b[0]) ? -1 : 1))
        .slice(0, limit)
        .map(([id, mem]) => ({ user: this.user(id, mem.bot), roles: [...mem.roles] }));
      return json(200, page);
    }
    if (method === 'GET' && (m = /^\/channels\/\d+\/messages\/\d+\/reactions\/(.+)$/.exec(path))) {
      const users = this.reactions.get(decodeURIComponent(m[1] as string));
      if (!users) return json(404, { code: 10014, message: 'Unknown Emoji' });
      if ((query.type ?? '0') !== '0') return json(200, []);
      return json(200, [...users].map((id) => this.user(id)));
    }
    if (method === 'GET' && path === `/channels/${E.channel}/messages/${E.message}`) {
      return json(200, { id: E.message, channel_id: E.channel, author: this.user(E.bot, true), embeds: [{ title: 'Regional Role Assignment' }], reactions: [] });
    }
    if (method === 'GET' && path === `/channels/${E.channel}/messages`) return json(200, []);
    if (/^\/applications\/\d+\/guilds\/\d+\/commands$/.test(path)) {
      if (method === 'PUT') this.commands = (body as unknown[]) ?? [];
      return json(200, this.commands);
    }
    if (method === 'POST' && /^\/interactions\/\d+\/[^/]+\/callback$/.test(path)) return empty();
    if (/^\/webhooks\/\d+\/[^/]+\/messages\/@original$/.test(path)) return json(200, { id: '1' });

    return json(404, { code: 0, message: `fake discord: unhandled ${method} ${path}` });
  }

  /** Builds a slash command interaction as Discord would send it. */
  interaction(name: string, member: { id: string; roles: string[]; permissions: string }, options: { name: string; type: number; value: unknown }[] = []): unknown {
    return {
      id: String(900000000000000000n + BigInt(this.calls.length + Math.floor(Math.random() * 1e6))),
      application_id: E.bot,
      type: 2,
      token: `tok-${Math.random().toString(36).slice(2)}`,
      version: 1,
      guild_id: E.guild,
      channel_id: E.channel,
      locale: 'en-US',
      guild_locale: 'en-US',
      app_permissions: '0',
      entitlements: [],
      authorizing_integration_owners: {},
      context: 0,
      member: {
        user: this.user(member.id),
        roles: member.roles,
        permissions: member.permissions,
        joined_at: new Date().toISOString(),
        deaf: false,
        mute: false,
        flags: 0,
      },
      data: { id: '1', name, type: 1, options },
    };
  }
}
