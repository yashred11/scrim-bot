export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: value.message };
    const code = (value as { code?: unknown }).code;
    const status = (value as { status?: unknown }).status;
    if (code !== undefined) out.code = code;
    if (status !== undefined) out.status = status;
    if (value.stack) out.stack = value.stack.split('\n').slice(0, 4).join(' | ');
    return out;
  }
  return value;
}

export function createLogger(
  level: LogLevel = 'info',
  write: (line: string) => void = (line) => console.log(line),
): Logger {
  const emit = (lvl: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    let suffix = '';
    if (meta) {
      try {
        suffix = ' ' + JSON.stringify(meta, replacer);
      } catch {
        suffix = ' [unserializable meta]';
      }
    }
    write(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${message}${suffix}`);
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
