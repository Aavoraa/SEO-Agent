import { redact } from './security.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Structured JSON-lines logger. Correlation IDs are carried via child(). Secrets are redacted. */
export function createLogger(base: Record<string, unknown> = {}, level: Level = (process.env.LOG_LEVEL as Level) || 'info'): Logger {
  const silent = process.env.NODE_ENV === 'test' && !process.env.LOG_IN_TESTS;
  const emit = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (silent || ORDER[lvl] < ORDER[level]) return;
    const rec = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...(fields ? redact(fields) : {}) };
    const line = JSON.stringify(rec, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v));
    (lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger({ ...base, ...f }, level),
  };
}

export const logger = createLogger({ service: 'phoenixx-seo' });
