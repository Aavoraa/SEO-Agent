import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { meta, parse, requireRole } from '../http.js';
import { audit } from '../services/common.js';
import { TRACKER_JS } from '../services/heatmap-tracker.js';
import { collect, isBot, disconnectClarity, heatmapData, heatmapPages, heatmapSetup, pageSnapshot, saveClarity, syncClarity } from '../services/heatmaps.js';

type P = { projectId: string };
const device = z.enum(['all', 'desktop', 'tablet', 'mobile']).default('all');
const days = z.coerce.number().int().min(1).max(365).default(3);
const unit = z.number().min(0).max(1);

const collectSchema = z.object({
  k: z.string().regex(/^hm_[0-9a-f]{24}$/),
  v: z.string().regex(/^[a-z0-9]{6,40}$/),
  p: z.string().max(500),
  t: z.string().max(300).optional(),
  d: z.enum(['desktop', 'tablet', 'mobile']),
  vw: z.number().int().min(0).max(20_000),
  vh: z.number().int().min(0).max(20_000),
  h: z.number().int().min(0).max(1_000_000),
  s: unit,
  e: z
    .array(z.object({ sel: z.string().max(1000).nullable(), l: z.string().max(120).nullable(), rx: unit, ry: unit, x: unit, y: z.number().int().min(0).max(1_000_000), h: z.number().int().min(0).max(1_000_000), r: z.boolean(), dd: z.boolean() }))
    .max(100),
});

export async function heatmapRoutes(app: FastifyInstance, ctx: AppContext) {
  /* ── public: tracker script + beacon endpoint ── */
  app.get('/hm.js', async (_req, reply) => {
    reply.header('content-type', 'application/javascript; charset=utf-8').header('cache-control', 'public, max-age=3600').header('cross-origin-resource-policy', 'cross-origin');
    return TRACKER_JS;
  });

  app.post('/api/collect', { bodyLimit: 64 * 1024, config: { rateLimit: { max: 240, timeWindow: '1 minute', keyGenerator: (req) => req.ip } } }, async (req, reply) => {
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        throw new AppError('Invalid JSON', 400, 'validation');
      }
    }
    const b = parse(collectSchema, body);
    if (isBot(req.headers['user-agent'])) return reply.code(204).send();
    await collect(ctx, b, (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined));
    reply.header('access-control-allow-origin', '*');
    return reply.code(204).send();
  });

  /* ── project: heatmaps ── */
  app.get('/api/projects/:projectId/heatmaps/setup', async (req) => heatmapSetup(ctx, (req.params as P).projectId));

  app.get('/api/projects/:projectId/heatmaps/pages', async (req) => {
    const q = parse(z.object({ days, device }), req.query);
    return heatmapPages(ctx, (req.params as P).projectId, q);
  });

  app.get('/api/projects/:projectId/heatmaps', async (req) => {
    const q = parse(z.object({ path: z.string().min(1).max(500), days, device }), req.query);
    return heatmapData(ctx, (req.params as P).projectId, q.path, q);
  });

  app.get('/api/projects/:projectId/heatmaps/snapshot', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const q = parse(z.object({ path: z.string().min(1).max(500) }), req.query);
    return pageSnapshot(ctx, (req.params as P).projectId, q.path);
  });

  /* ── Microsoft Clarity ── */
  app.put('/api/projects/:projectId/heatmaps/clarity', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId } = req.params as P;
    const b = parse(z.object({ clarityProjectId: z.string().regex(/^[a-z0-9]{6,20}$/i, 'Clarity project id looks like "yj3dehirsu"'), apiToken: z.string().min(20).max(4000).nullable().optional() }), req.body);
    const r = await saveClarity(ctx, projectId, b);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'integration.clarity.save', details: { clarityProjectId: b.clarityProjectId, token: b.apiToken ? 'updated' : b.apiToken === null ? 'removed' : 'unchanged' }, ...meta(req) });
    return r;
  });
  app.delete('/api/projects/:projectId/heatmaps/clarity', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId } = req.params as P;
    const r = await disconnectClarity(ctx, projectId);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'integration.clarity.disconnect', ...meta(req) });
    return r;
  });
  app.post('/api/projects/:projectId/heatmaps/clarity/sync', async (req) => {
    requireRole(req, 'editor', 'service');
    const b = parse(z.object({ numOfDays: z.number().int().min(1).max(3).default(3) }), req.body ?? {});
    return syncClarity(ctx, (req.params as P).projectId, b);
  });
}
