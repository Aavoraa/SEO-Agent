import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { meta, parse, requireActor, requireRole } from '../http.js';
import { audit, getProject } from '../services/common.js';
import { isBot, resolveKey } from '../services/heatmaps.js';
import { deleteRecording, getRecording, ingestRecording, listRecordings, recordingEvents, recordingSettingsOf, saveRecordingSettings, setFavorite, type RecordingFilter } from '../services/recordings.js';

type P = { projectId: string };

/** rrweb's recorder (MIT), served from our own origin so customer sites don't load a third-party CDN. */
let recorderJs: string | null = null;
function recorder() {
  if (recorderJs === null) {
    const entry = createRequire(import.meta.url).resolve('@rrweb/record');
    recorderJs = readFileSync(path.join(path.dirname(entry), 'record.umd.min.cjs'), 'utf8').replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/, '\n');
  }
  return recorderJs;
}

const publicHeaders = (reply: FastifyReply) => reply.header('access-control-allow-origin', '*').header('cross-origin-resource-policy', 'cross-origin');

const recSchema = z.object({
  k: z.string().regex(/^hm_[0-9a-f]{24}$/),
  s: z.string().regex(/^[a-z0-9]{8,40}$/),
  v: z.string().regex(/^[a-z0-9]{6,40}$/),
  p: z.string().max(500),
  t: z.string().max(300).optional(),
  d: z.enum(['desktop', 'tablet', 'mobile']),
  vw: z.number().int().min(0).max(20_000),
  vh: z.number().int().min(0).max(20_000),
  q: z.number().int().min(0).max(1_000_000),
  e: z.array(z.unknown()).min(1).max(20_000),
});

const flag = z.preprocess((v) => v === true || v === '1' || v === 'true', z.boolean()).optional();

const listQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(3),
  device: z.enum(['all', 'desktop', 'tablet', 'mobile']).default('all'),
  minDurationSec: z.coerce.number().int().min(0).max(36_000).optional(),
  page: z.string().max(300).optional(),
  rage: flag,
  dead: flag,
  errors: flag,
  favorites: flag,
  unviewed: flag,
  sort: z.enum(['newest', 'oldest', 'longest', 'clicks', 'pages']).default('newest'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function recordingRoutes(app: FastifyInstance, ctx: AppContext) {
  /* ── public (called by hm.js on customer websites) ── */
  app.get('/rr.js', async (_req, reply) => {
    publicHeaders(reply).header('content-type', 'application/javascript; charset=utf-8').header('cache-control', 'public, max-age=86400');
    return recorder();
  });

  app.get('/api/collect/config', { config: { rateLimit: { max: 240, timeWindow: '1 minute', keyGenerator: (req) => req.ip } } }, async (req, reply) => {
    const q = parse(z.object({ k: z.string().regex(/^hm_[0-9a-f]{24}$/) }), req.query);
    publicHeaders(reply).header('cache-control', 'public, max-age=300');
    const info = await resolveKey(ctx, q.k);
    if (!info) throw new AppError('Unknown site key', 404, 'not_found');
    const s = recordingSettingsOf(info.settings);
    return { recordings: { enabled: s.enabled && !isBot(req.headers['user-agent']), sampleRate: s.sampleRate, masking: s.masking } };
  });

  app.post('/api/collect/rec', { bodyLimit: 8 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator: (req) => req.ip } } }, async (req, reply) => {
    publicHeaders(reply);
    const ua = req.headers['user-agent'];
    if (isBot(ua)) return reply.code(204).send();
    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        throw new AppError('Invalid JSON', 400, 'validation');
      }
    }
    const b = parse(recSchema, body);
    const country = typeof req.headers['cf-ipcountry'] === 'string' && /^[A-Z]{2}$/.test(req.headers['cf-ipcountry']) ? req.headers['cf-ipcountry'] : null;
    await ingestRecording(ctx, b, { origin: (req.headers.origin as string | undefined) ?? (req.headers.referer as string | undefined), userAgent: ua, country });
    return reply.code(204).send();
  });

  /* ── project ── */
  app.get('/api/projects/:projectId/recordings', async (req) => {
    const q = parse(listQuery, req.query);
    return listRecordings(ctx, (req.params as P).projectId, q);
  });

  app.get('/api/projects/:projectId/recordings/settings', async (req) => {
    const p = await getProject(ctx, (req.params as P).projectId);
    const s = recordingSettingsOf(p.settings);
    const clarityId = (await ctx.db.one<{ id: string | null }>(`SELECT config->>'clarityProjectId' AS id FROM integrations WHERE project_id = $1 AND provider = 'microsoft_clarity'`, [p.id]))?.id ?? null;
    return { ...s, retentionDays: ctx.cfg.RECORDING_RETENTION_DAYS, maxMbPerSession: ctx.cfg.RECORDING_MAX_MB, clarityRecordingsUrl: clarityId ? `https://clarity.microsoft.com/projects/view/${encodeURIComponent(clarityId)}/impressions?date=Last%203%20days` : null };
  });

  app.put('/api/projects/:projectId/recordings/settings', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId } = req.params as P;
    const b = parse(z.object({ enabled: z.boolean(), sampleRate: z.number().min(0).max(1).default(1), masking: z.enum(['balanced', 'strict']).default('balanced') }), req.body);
    const r = await saveRecordingSettings(ctx, projectId, b);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'recordings.settings', details: b, ...meta(req) });
    return r;
  });

  app.get('/api/projects/:projectId/recordings/:id', async (req) => {
    const { projectId, id } = req.params as P & { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('Invalid recording id', 400, 'validation');
    const q = parse(listQuery.partial().extend({ days: z.coerce.number().int().min(1).max(365).default(365) }), req.query);
    return getRecording(ctx, projectId, id, { markViewed: requireActor(req).type === 'user', filter: q as RecordingFilter });
  });

  app.get('/api/projects/:projectId/recordings/:id/events', async (req) => {
    const { projectId, id } = req.params as P & { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError('Invalid recording id', 400, 'validation');
    return { events: await recordingEvents(ctx, projectId, id) };
  });

  app.patch('/api/projects/:projectId/recordings/:id', async (req) => {
    requireRole(req, 'editor');
    const { projectId, id } = req.params as P & { id: string };
    const b = parse(z.object({ favorite: z.boolean() }), req.body);
    return setFavorite(ctx, projectId, id, b.favorite);
  });

  app.delete('/api/projects/:projectId/recordings/:id', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId, id } = req.params as P & { id: string };
    const r = await deleteRecording(ctx, projectId, id);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'recording.delete', entityType: 'recording', entityId: id, ...meta(req) });
    return r;
  });
}
