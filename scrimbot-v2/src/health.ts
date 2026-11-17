import http from 'node:http';
import type { Logger } from './logger.js';

export interface HealthStatus {
  ok: boolean;
  details: Record<string, unknown>;
}

/** GET /healthz returns 200 when the gateway connection is ready and 503 otherwise. */
export function startHealthServer(port: number, getStatus: () => HealthStatus, logger: Logger): http.Server | undefined {
  if (port === 0) return undefined;

  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/healthz' && req.url !== '/')) {
      res.writeHead(404).end();
      return;
    }
    let status: HealthStatus;
    try {
      status = getStatus();
    } catch (e) {
      status = { ok: false, details: { error: String(e) } };
    }
    res.writeHead(status.ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: status.ok, ...status.details }));
  });

  server.on('error', (e) => logger.error('Health server error', { error: e }));
  server.listen(port, '0.0.0.0', () => logger.info('Health server listening', { port }));
  return server;
}
