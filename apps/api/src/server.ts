import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AppError, newId } from '@phoenixx/shared';
import { AIBudgetError, AIDisabledError, AIProviderError, AIValidationError } from '@phoenixx/ai-engine';
import type { AppContext } from './context.js';
import { authenticate } from './http.js';
import { auditDeployRoutes } from './routes/audit-deploy.js';
import { orgRoutes } from './routes/orgs.js';
import { platformRoutes } from './routes/platform.js';
import { heatmapRoutes } from './routes/heatmaps.js';
import { recordingRoutes } from './routes/recordings.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';
import { actionRoutes } from './routes/actions.js';
import { listRules } from '@phoenixx/seo-engine';

export const VERSION = '0.1.0';

export async function buildServer(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, trustProxy: true, genReqId: () => newId() });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } });
  await app.register(cors, { origin: ctx.cfg.FRONTEND_URL.split(',').map((s) => s.trim()), credentials: false, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(rateLimit, { max: ctx.cfg.RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute', keyGenerator: (req) => (req.headers['x-api-key'] as string | undefined)?.slice(0, 16) ?? req.ip });

  app.decorateRequest('correlationId', '');
  app.addHook('onRequest', async (req, reply) => {
    const incoming = req.headers['x-correlation-id'];
    req.correlationId = typeof incoming === 'string' && /^[\w-]{6,80}$/.test(incoming) ? incoming : req.id;
    reply.header('x-correlation-id', req.correlationId);
    if (req.url.startsWith('/api/')) {
      // Auth errors are deferred to requireActor() so public endpoints (login, status) still work with a stale token.
      try {
        req.actor = (await authenticate(ctx, req)) ?? undefined;
      } catch (e) {
        req.authError = e as Error;
      }
    }
  });
  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const ms = Math.round(reply.elapsedTime);
    const lvl = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : 'debug';
    ctx.log[lvl]('http.request', { method: req.method, url: req.url.split('?')[0], status: reply.statusCode, ms, correlationId: req.correlationId, actor: req.actor?.label });
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number; code?: string };
    let status = 500;
    let code = 'internal_error';
    let message = 'Internal server error';
    let details: unknown;
    if (err instanceof AppError) {
      status = err.statusCode;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (err instanceof AIDisabledError) {
      status = 400;
      code = 'ai_disabled';
      message = err.message;
    } else if (err instanceof AIBudgetError) {
      status = 402;
      code = 'ai_budget';
      message = err.message;
    } else if (err instanceof AIValidationError) {
      status = 502;
      code = 'ai_invalid_output';
      message = err.message;
    } else if (err instanceof AIProviderError) {
      status = err.kind === 'rate_limit' ? 429 : err.kind === 'auth' ? 502 : 502;
      code = `ai_${err.kind}`;
      message = `AI provider error: ${err.message}`;
    } else if (err.statusCode && err.statusCode < 500) {
      status = err.statusCode;
      code = err.code ?? "bad_request";
      message = err.message;
    }
    if (status >= 500) ctx.log.error('http.error', { error: err.message, stack: err.stack, correlationId: req.correlationId, url: req.url });
    reply.code(status).send({ error: { code, message, details, correlationId: req.correlationId } });
  });

  app.get('/health', async () => ({ status: 'ok', version: VERSION }));
  app.get('/ready', async (_req, reply) => {
    try {
      await ctx.db.query('SELECT 1');
      return { status: 'ready', db: ctx.db.kind };
    } catch (e) {
      return reply.code(503).send({ status: 'not_ready', error: (e as Error).message });
    }
  });

  app.get('/api/system/status', async () => {
    const users = await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
    return {
      version: VERSION,
      demoMode: ctx.cfg.DEMO_MODE,
      needsSetup: (users?.n ?? 0) === 0,
      database: ctx.db.kind,
      ai: ctx.ai.info,
      google: { serviceAccount: !!ctx.cfg.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, oauthClient: !!(ctx.cfg.GOOGLE_CLIENT_ID && ctx.cfg.GOOGLE_CLIENT_SECRET), searchConsoleSiteUrl: ctx.cfg.SEARCH_CONSOLE_SITE_URL ?? null, ga4PropertyId: ctx.cfg.GA4_PROPERTY_ID ?? null },
      websiteAdapter: ctx.adapter.name,
      notifications: ctx.notifiers.map((n) => n.channel),
      siteUrl: ctx.cfg.SEO_SITE_URL,
      productName: ctx.cfg.PRODUCT_NAME,
      signupEnabled: ctx.cfg.SIGNUP_ENABLED && !ctx.cfg.DEMO_MODE,
    };
  });
  app.get('/api/system/rules', async () => listRules());

  await authRoutes(app, ctx);
  await dataRoutes(app, ctx);
  await actionRoutes(app, ctx);
  await auditDeployRoutes(app, ctx);
  await orgRoutes(app, ctx);
  await platformRoutes(app, ctx);
  await heatmapRoutes(app, ctx);
  await recordingRoutes(app, ctx);

  // Optional: serve the built dashboard from the API (single-container deployments).
  const dist = process.env.DASHBOARD_DIST ?? path.resolve(process.cwd(), 'apps/dashboard/dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, { root: dist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api/') ? reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } }) : reply.sendFile('index.html')));
  }
  return app;
}
