/**
 * Vercel serverless entry (bundled to apps/api/dist/vercel.js, re-exported by /api/index.js).
 *
 * - With DATABASE_URL (+ JWT_SECRET, APP_ENCRYPTION_KEY, SERVICE_API_KEY) set on the Vercel project
 *   it runs the full production API against PostgreSQL (e.g. Neon).
 * - Without DATABASE_URL it falls back to the clearly-labelled DEMO: an embedded database in /tmp
 *   seeded with sample data on cold start. Demo data is per instance and resets on cold starts.
 *
 * Long-running work (large crawls) is limited by the function maxDuration; schedule heavy jobs from
 * n8n against a long-running deployment (docker-compose) for production use.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

function prepareEnv() {
  const env = process.env;
  env.EXPORT_DIR ??= '/tmp/exports';
  if (env.DATABASE_URL) return;
  env.DEMO_MODE = 'true';
  env.DEMO_DATABASE_URL ??= 'pglite:///tmp/demo-db';
  // Demo only: derive stable (per-project) secrets so sessions work across instances. Never used with real data.
  const seed = createHash('sha256').update(`phoenixx-seo-demo:${env.VERCEL_PROJECT_ID ?? 'local'}`).digest('base64url');
  env.JWT_SECRET ??= `${seed}-jwt`;
  env.APP_ENCRYPTION_KEY ??= `${seed}-enc`;
  env.SERVICE_API_KEY ??= `${seed}-svc`;
}

let booting: Promise<FastifyInstance> | null = null;

async function boot(): Promise<FastifyInstance> {
  prepareEnv();
  const { createContext } = await import('./context.js');
  const { buildServer } = await import('./server.js');
  const ctx = await createContext();
  if (ctx.cfg.DEMO_MODE) {
    const { seedDemo } = await import('./demo/seed.js');
    await seedDemo(ctx, { log: (m) => ctx.log.info('demo.seed', { message: m }) });
  } else {
    const { createProject } = await import('./services/projects.js');
    const p = await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM projects WHERE NOT is_demo');
    if (!p?.n) await createProject(ctx, { name: 'Phoenixx IT', siteUrl: ctx.cfg.SEO_SITE_URL, searchConsoleSiteUrl: ctx.cfg.SEARCH_CONSOLE_SITE_URL, ga4PropertyId: ctx.cfg.GA4_PROPERTY_ID });
  }
  const app = await buildServer(ctx);
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    booting ??= boot().catch((e) => {
      booting = null; // retry on the next request
      throw e;
    });
    const app = await booting;
    app.server.emit('request', req, res);
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'startup_failed', message: (e as Error).message } }));
  }
}
