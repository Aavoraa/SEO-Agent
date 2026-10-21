import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { meta, parse, requireActor, requireRole } from '../http.js';
import { audit, getProject } from '../services/common.js';
import { commandCenter } from '../services/command-center.js';
import { listOpportunities, nextBestAction, refreshOpportunities, setOpportunityStatus } from '../services/opportunities.js';
import { globalSearch } from '../services/search.js';
import { detectWebsite } from '../services/detection.js';
import { automationOf, validateAutomation } from '../services/autopilot.js';
import { createProject } from '../services/projects.js';
import { assertLimit, requireOrgPermission } from '../services/tenancy.js';
import { OPPORTUNITY_WEIGHTS } from '@phoenixx/seo-engine';

type P = { projectId: string };

export async function platformRoutes(app: FastifyInstance, ctx: AppContext) {
  /* ── Command Center & Opportunity Engine ── */
  app.get('/api/projects/:projectId/command-center', async (req) => commandCenter(ctx, (req.params as P).projectId));

  app.get('/api/projects/:projectId/opportunities', async (req) => {
    const q = parse(z.object({ category: z.enum(['quick_win', 'high_impact', 'strategic', 'at_risk', 'competitive', 'ai_search', 'emerging']).optional(), status: z.enum(['open', 'in_progress', 'done', 'dismissed', 'snoozed', 'all']).default('open'), limit: z.coerce.number().int().min(1).max(500).default(200) }), req.query);
    return { items: await listOpportunities(ctx, (req.params as P).projectId, q), formula: { weights: OPPORTUNITY_WEIGHTS, description: 'Priority = 100 × (0.30·Impact + 0.20·Business value + 0.15·Confidence + 0.15·(1 − Effort) + 0.10·Time sensitivity + 0.10·(1 − Risk)) × Memory (0.85–1.10 from your approval history on similar changes)' } };
  });
  app.get('/api/projects/:projectId/next-best-action', async (req) => ({ nextBestAction: await nextBestAction(ctx, (req.params as P).projectId) }));
  app.post('/api/projects/:projectId/opportunities/refresh', async (req) => {
    requireRole(req, 'editor', 'service');
    return refreshOpportunities(ctx, (req.params as P).projectId);
  });
  app.patch('/api/projects/:projectId/opportunities/:id', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as P & { id: string };
    const b = parse(z.object({ status: z.enum(['open', 'in_progress', 'dismissed', 'snoozed']), snoozeDays: z.number().int().min(1).max(180).optional() }), req.body);
    const r = await setOpportunityStatus(ctx, projectId, id, b.status, b.snoozeDays);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: `opportunity.${b.status}`, entityType: 'opportunity', entityId: id, ...meta(req) });
    return r;
  });

  /* ── Global search ── */
  app.get('/api/projects/:projectId/search', async (req) => {
    const q = parse(z.object({ q: z.string().max(100).default('') }), req.query);
    return globalSearch(ctx, (req.params as P).projectId, q.q);
  });

  /* ── Automation level ── */
  app.get('/api/projects/:projectId/automation', async (req) => automationOf((await getProject(ctx, (req.params as P).projectId)).settings));
  app.put('/api/projects/:projectId/automation', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId } = req.params as P;
    const b = parse(z.object({ level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]), allowedMediumTypes: z.array(z.string()).max(10).default([]), dailyLimit: z.number().int().min(1).max(100).default(5) }), req.body);
    await validateAutomation(ctx, projectId, b);
    await ctx.db.query(`UPDATE projects SET settings = jsonb_set(settings, '{automation}', $2::jsonb), updated_at = now() WHERE id = $1`, [projectId, b]);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'automation.update', details: b, ...meta(req) });
    return b;
  });

  /* ── Onboarding ── */
  app.post('/api/onboarding/detect', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    requireActor(req);
    const b = parse(z.object({ url: z.string().min(3).max(300) }), req.body);
    return detectWebsite(ctx, b.url);
  });

  app.post('/api/onboarding/projects', async (req) => {
    const a = requireActor(req);
    const b = parse(z.object({ organizationId: z.string().uuid(), url: z.string().min(3).max(300), name: z.string().min(1).max(120).optional() }), req.body);
    await requireOrgPermission(ctx, a, b.organizationId, 'projects.create');
    const n = (await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM projects WHERE organization_id = $1', [b.organizationId]))!.n;
    await assertLimit(ctx, b.organizationId, 'projects', n);
    const detection = await detectWebsite(ctx, b.url);
    const host = new URL(detection.url).hostname.replace(/^www\./, '');
    const p = await createProject(ctx, { name: b.name ?? detection.title?.split(/[|–-]/)[0]?.trim() ?? host, siteUrl: detection.url, organizationId: b.organizationId, blankProfile: true });
    await ctx.db.query(`UPDATE projects SET settings = settings || $2::jsonb WHERE id = $1`, [p.id, { detection: { ...detection, detectedAt: new Date().toISOString() } }]);
    await audit(ctx, { projectId: p.id, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'project.create', details: { url: detection.url, via: 'onboarding' }, ...meta(req) });
    return { project: p, detection };
  });

  app.get('/api/projects/:projectId/onboarding', async (req) => {
    const { projectId } = req.params as P;
    const p = await getProject(ctx, projectId);
    const s = await ctx.db.one<any>(
      `SELECT (SELECT COUNT(*) FROM integrations WHERE project_id = $1 AND provider = 'google_search_console' AND status = 'connected')::int AS gsc,
              (SELECT COUNT(*) FROM integrations WHERE project_id = $1 AND provider = 'google_analytics' AND status = 'connected')::int AS ga4,
              (SELECT COUNT(*) FROM competitors WHERE project_id = $1)::int AS competitors,
              (SELECT COUNT(*) FROM seo_audits WHERE project_id = $1)::int AS audits,
              (SELECT COUNT(*) FROM opportunities WHERE project_id = $1)::int AS opportunities`,
      [projectId],
    );
    const detection = (p.settings as { detection?: unknown }).detection ?? null;
    const steps = [
      { id: 'website', label: 'Add website & detect technology', done: true },
      { id: 'gsc', label: 'Connect Google Search Console', done: s.gsc > 0 || p.is_demo, optional: false, href: '/settings?tab=integrations' },
      { id: 'ga4', label: 'Connect Google Analytics 4', done: s.ga4 > 0 || p.is_demo, optional: true, href: '/settings?tab=integrations' },
      { id: 'competitors', label: 'Add competitors', done: s.competitors > 0, optional: true, href: '/competitors' },
      { id: 'audit', label: 'Run baseline audit', done: s.audits > 0 },
      { id: 'opportunities', label: 'Review your first opportunities', done: s.opportunities > 0, href: '/opportunities' },
    ];
    return { steps, detection, complete: steps.filter((x) => !x.optional).every((x) => x.done) };
  });
}
