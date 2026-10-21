import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createContext, type AppContext } from '../src/context.js';
import { buildServer } from '../src/server.js';
import type { AppConfig } from '@phoenixx/shared';

export async function testApp(overrides: Partial<AppConfig> = {}): Promise<{ ctx: AppContext; app: FastifyInstance; exportDir: string; close: () => Promise<void> }> {
  process.env.NODE_ENV = 'test';
  const exportDir = mkdtempSync(path.join(os.tmpdir(), 'seo-exports-'));
  const ctx = await createContext({
    DATABASE_URL: 'pglite://memory',
    DEMO_MODE: false,
    AI_PROVIDER: 'mock',
    SERVICE_API_KEY: 'test-service-key-123456',
    EXPORT_DIR: exportDir,
    CRAWL_DELAY_MS: 0,
    CRAWL_CONCURRENCY: 3,
    CRAWL_TIMEOUT_MS: 5000,
    RATE_LIMIT_PER_MINUTE: 10000,
    FRONTEND_URL: 'http://localhost:5173',
    ...overrides,
  } as Partial<AppConfig>);
  const app = await buildServer(ctx);
  return {
    ctx,
    app,
    exportDir,
    close: async () => {
      await app.close();
      await ctx.close();
    },
  };
}

export async function json<T = any>(app: FastifyInstance, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, opts: { token?: string; apiKey?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url,
    headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.apiKey ? { 'x-api-key': opts.apiKey } : {}), ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    payload: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let body: any = res.body;
  try {
    body = JSON.parse(res.body);
  } catch {
    /* non-JSON */
  }
  return { status: res.statusCode, body };
}
