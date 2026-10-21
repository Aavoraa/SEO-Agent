import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { meta, parse, requireActor, requireRole } from '../http.js';
import { audit, getProject } from '../services/common.js';
import { decideRecommendation, generateProposal } from '../services/recommendations.js';
import { implementChange, rollbackChange, verifyChange } from '../services/changes.js';
import { decideBrief, decideDraft, generateBrief, generateDraft, runQuality } from '../services/content.js';
import { profileOf } from '../services/common.js';
import { validateCompetitorUrl } from '../services/competitors.js';
import { createProject } from '../services/projects.js';
import { JOBS, runJob } from '../services/jobs.js';
import { dispatchPending, raiseAlert } from '../services/alerts.js';
import { importBacklinks } from '../services/backlinks.js';
import { setMembership } from '../services/access.js';
import { emitEvent } from '../services/events.js';
import { assertLimit, requireOrgPermission } from '../services/tenancy.js';

type P = { projectId: string };
type PI = P & { id: string };

const ruleOverride = z.object({ enabled: z.boolean().optional(), severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(), params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional() });
const settingsSchema = z.object({
  rules: z.record(z.string(), ruleOverride).optional(),
  alertMinSeverity: z.record(z.string(), z.enum(['critical', 'high', 'medium', 'low', 'info'])).optional(),
  crawl: z.object({ maxPages: z.number().int().min(1).max(20000).optional(), checkExternalLinks: z.boolean().optional() }).optional(),
  ai: z.object({ autoAnalyzeCrawl: z.boolean().optional(), refineKeywordIntent: z.boolean().optional() }).optional(),
  thresholds: z.object({ minImpressionsForLocationPage: z.number().int().min(0).optional(), trafficDropPct: z.number().min(5).max(95).optional() }).optional(),
  searchConsoleSiteUrl: z.string().max(300).optional(),
  ga4PropertyId: z.string().regex(/^\d+$/, 'GA4 property ID is numeric (not the G- measurement ID)').optional(),
});
const serviceDef = z.object({ id: z.string().min(1).max(60), name: z.string().min(1).max(120), path: z.string().max(300).optional(), terms: z.array(z.string().max(80)).max(50) });
const locationDef = z.object({ id: z.string().min(1).max(60), name: z.string().min(1).max(120), level: z.enum(['locality', 'city', 'region', 'country']), aliases: z.array(z.string().max(60)).max(20), target: z.boolean() });
const profileSchema = z.object({
  name: z.string().max(120).optional(),
  description: z.string().max(1000).optional(),
  url: z.string().url().optional(),
  logoUrl: z.string().url().optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().optional(),
  address: z.object({ streetAddress: z.string(), addressLocality: z.string(), addressRegion: z.string(), postalCode: z.string().optional(), addressCountry: z.string() }).optional(),
  sameAs: z.array(z.string().url()).max(20).optional(),
  services: z.array(serviceDef).max(60).optional(),
  locations: z.array(locationDef).max(60).optional(),
  facts: z.array(z.string().max(500)).max(50).optional(),
  ctas: z.array(z.string().max(80)).max(10).optional(),
  languages: z.array(z.string().max(40)).max(10).optional(),
});

export async function actionRoutes(app: FastifyInstance, ctx: AppContext) {
  /* ── Projects & settings ── */
  app.post('/api/projects', async (req) => {
    const a = requireActor(req);
    const b = parse(z.object({ name: z.string().min(1).max(120), siteUrl: z.string().min(4).max(300), searchConsoleSiteUrl: z.string().max(300).optional(), ga4PropertyId: z.string().regex(/^\d+$/).optional(), organizationId: z.string().uuid().optional() }), req.body);
    const orgId = b.organizationId;
    if (orgId) {
      await requireOrgPermission(ctx, a, orgId, 'projects.create');
      const n = (await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM projects WHERE organization_id = $1', [orgId]))!.n;
      await assertLimit(ctx, orgId, 'projects', n);
    } else if (!(a.type === 'user' && a.role === 'admin')) {
      throw new AppError('organizationId is required', 400, 'validation');
    }
    const p = await createProject(ctx, { ...b, organizationId: orgId, blankProfile: !!orgId });
    await audit(ctx, { projectId: p.id, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'project.create', details: b, ...meta(req) });
    return p;
  });

  app.patch('/api/projects/:projectId', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId } = req.params as P;
    const b = parse(z.object({ name: z.string().min(1).max(120).optional(), settings: settingsSchema.optional(), businessProfile: profileSchema.optional() }), req.body);
    const p = await getProject(ctx, projectId);
    await ctx.db.query(`UPDATE projects SET name = COALESCE($2, name), settings = $3, business_profile = $4, updated_at = now() WHERE id = $1`, [projectId, b.name ?? null, { ...p.settings, ...(b.settings ?? {}) }, { ...profileOf(p), ...(b.businessProfile ?? {}) }]);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'project.update', details: { keys: Object.keys(b) }, ...meta(req) });
    return { ok: true };
  });

  /* ── Project members (project admins and platform admins) ── */
  app.get('/api/projects/:projectId/members', async (req) => {
    requireRole(req, 'admin');
    const { projectId } = req.params as P;
    return ctx.db.query(
      `SELECT u.id AS "userId", u.email, u.name, u.is_active AS "isActive", m.role, m.created_at AS "addedAt" FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1 ORDER BY m.created_at`,
      [projectId],
    );
  });

  /** Add an existing user by email (project admins can't browse the platform's user list). */
  app.post('/api/projects/:projectId/members', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId } = req.params as P;
    const b = parse(z.object({ email: z.string().email(), role: z.enum(['admin', 'editor', 'viewer']) }), req.body);
    const u = await ctx.db.one<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower($1) AND is_active', [b.email]);
    if (!u) throw new AppError('No active user with this email – a platform admin must create the account first', 404, 'not_found');
    await setMembership(ctx, projectId, u.id, b.role);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'member.set', entityType: 'user', entityId: u.id, details: b, ...meta(req) });
    return { ok: true, userId: u.id };
  });

  app.put('/api/projects/:projectId/members/:userId', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId, userId } = req.params as P & { userId: string };
    const b = parse(z.object({ role: z.enum(['admin', 'editor', 'viewer']) }), req.body);
    if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new AppError('Invalid user id', 400, 'validation');
    await setMembership(ctx, projectId, userId, b.role);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'member.set', entityType: 'user', entityId: userId, details: b, ...meta(req) });
    return { ok: true };
  });

  app.delete('/api/projects/:projectId/members/:userId', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId, userId } = req.params as P & { userId: string };
    if (a.type === 'user' && a.id === userId) throw new AppError('You cannot remove yourself from a project', 400, 'bad_request');
    await ctx.db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'member.remove', entityType: 'user', entityId: userId, ...meta(req) });
    return { ok: true };
  });

  /* ── Issues & alerts ── */
  app.patch('/api/projects/:projectId/issues/:id', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ status: z.enum(['open', 'acknowledged', 'ignored']) }), req.body);
    const r = await ctx.db.one(`UPDATE seo_issues SET status = $3 WHERE id = $1 AND project_id = $2 RETURNING id`, [id, projectId, b.status]);
    if (!r) throw new AppError('Issue not found', 404, 'not_found');
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: `issue.${b.status}`, entityType: 'seo_issue', entityId: id, ...meta(req) });
    return { ok: true };
  });

  app.patch('/api/projects/:projectId/alerts/:id', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ status: z.enum(['acknowledged', 'resolved', 'open']) }), req.body);
    await ctx.db.query(`UPDATE alerts SET status = $3, resolved_at = CASE WHEN $3 = 'resolved' THEN now() END WHERE id = $1 AND project_id = $2`, [id, projectId, b.status]);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: `alert.${b.status}`, entityType: 'alert', entityId: id, ...meta(req) });
    return { ok: true };
  });

  /** Workflow failure / external signal → alert (+ notification). Used by the n8n error workflow. */
  app.post('/api/projects/:projectId/alerts', async (req) => {
    const a = requireRole(req, 'editor', 'service');
    const { projectId } = req.params as P;
    const b = parse(
      z.object({ severity: z.enum(['critical', 'high', 'medium', 'low', 'info']), type: z.string().min(1).max(60), title: z.string().min(1).max(300), message: z.string().max(5000), fingerprint: z.string().min(1).max(200), evidence: z.record(z.string(), z.unknown()).optional() }),
      req.body,
    );
    const r = await raiseAlert(ctx, projectId, { ...b, type: `external:${b.type}` });
    const dispatched = r.isNew ? await dispatchPending(ctx, projectId) : null;
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'alert.raised', entityType: 'alert', entityId: r.id, details: { type: b.type }, ...meta(req) });
    return { ...r, dispatched };
  });

  /* ── Recommendations (human-in-the-loop) ── */
  app.post('/api/projects/:projectId/recommendations/:id/decision', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).optional(), editedValue: z.string().max(50000).optional(), previewConfirmed: z.boolean().optional() }), req.body);
    const d = await decideRecommendation(ctx, projectId, id, a, b, meta(req));
    if (d.changeId) await emitEvent(ctx, projectId, 'change.approved', { changeId: d.changeId, recommendationId: id, by: a.label });
    return d;
  });

  app.post('/api/projects/:projectId/recommendations/:id/generate', async (req) => {
    // Generation only – approval always requires a human editor/admin.
    requireRole(req, 'editor', 'service');
    const { projectId, id } = req.params as PI;
    return generateProposal(ctx, projectId, id, req.correlationId);
  });

  app.post('/api/projects/:projectId/recommendations/:id/submit', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const r = await ctx.db.one(`UPDATE recommendations SET status = 'pending_approval', updated_at = now() WHERE id = $1 AND project_id = $2 AND status = 'recommended' RETURNING id`, [id, projectId]);
    if (!r) throw new AppError('Only "recommended" items can be submitted for approval', 409, 'invalid_state');
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'recommendation.submitted', entityType: 'recommendation', entityId: id, ...meta(req) });
    return { ok: true };
  });

  app.post('/api/projects/:projectId/recommendations/:id/dismiss', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    await ctx.db.query(`UPDATE recommendations SET status = 'rejected', updated_at = now() WHERE id = $1 AND project_id = $2 AND status IN ('recommended','pending_approval')`, [id, projectId]);
    await ctx.db.query(`INSERT INTO approvals(project_id, recommendation_id, decision, reviewer_id, reviewer_label, comment) VALUES ($1,$2,'rejected',$3,$4,'Dismissed')`, [projectId, id, a.type === 'user' ? a.id : null, a.label]);
    return { ok: true };
  });

  /* ── Changes ── */
  app.post('/api/projects/:projectId/changes/:id/implement', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    return implementChange(ctx, projectId, id, a);
  });

  app.post('/api/projects/:projectId/changes/:id/verify', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ manualConfirm: z.boolean().optional(), note: z.string().max(1000).optional() }), req.body ?? {});
    return verifyChange(ctx, projectId, id, a, b);
  });

  app.post('/api/projects/:projectId/changes/:id/rollback', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ reason: z.string().max(1000).optional() }), req.body);
    return rollbackChange(ctx, projectId, id, a, b.reason);
  });

  /* ── Content workflow ── */
  app.post('/api/projects/:projectId/content/opportunities/:id/brief', async (req) => {
    // n8n (service) may GENERATE briefs; approving them always requires a human editor.
    const a = requireRole(req, 'editor', 'service');
    const { projectId, id } = req.params as PI;
    return generateBrief(ctx, projectId, id, a, req.correlationId);
  });

  app.patch('/api/projects/:projectId/content/opportunities/:id', async (req) => {
    requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ status: z.enum(['open', 'dismissed', 'published']) }), req.body);
    await ctx.db.query(`UPDATE content_opportunities SET status = $3, updated_at = now() WHERE id = $1 AND project_id = $2`, [id, projectId, b.status]);
    return { ok: true };
  });

  app.post('/api/projects/:projectId/content/briefs/:id/decision', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).optional(), brief: z.record(z.string(), z.unknown()).optional() }), req.body);
    return decideBrief(ctx, projectId, id, a, b.decision, b.comment, b.brief);
  });

  app.post('/api/projects/:projectId/content/briefs/:id/draft', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    return generateDraft(ctx, projectId, id, a, req.correlationId);
  });

  app.post('/api/projects/:projectId/content/drafts/:id/decision', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().max(2000).optional(), title: z.string().max(300).optional(), bodyMarkdown: z.string().max(200000).optional() }), req.body);
    return decideDraft(ctx, projectId, id, a, b.decision, b.comment, b.title || b.bodyMarkdown ? { title: b.title, bodyMarkdown: b.bodyMarkdown } : undefined);
  });

  app.post('/api/projects/:projectId/content/drafts/:id/quality', async (req) => {
    requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const d = await ctx.db.one<any>(`SELECT d.*, b.target_keyword, b.brief FROM content_drafts d LEFT JOIN content_briefs b ON b.id = d.brief_id WHERE d.id = $1 AND d.project_id = $2`, [id, projectId]);
    if (!d) throw new AppError('Draft not found', 404, 'not_found');
    const profile = profileOf(await getProject(ctx, projectId));
    const q = await runQuality(ctx, projectId, { title: d.title, bodyMarkdown: d.body_markdown, targetKeyword: d.target_keyword ?? d.title, metaDescription: d.meta?.metaDescription, intent: d.brief?.searchIntent }, profile, req.correlationId);
    await ctx.db.query('UPDATE content_drafts SET quality_report = $2, quality_score = $3 WHERE id = $1', [id, q, q.score]);
    return q;
  });

  /* ── Competitors (user-configured, never hard-coded) ── */
  app.post('/api/projects/:projectId/competitors', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId } = req.params as P;
    const b = parse(z.object({ name: z.string().min(1).max(120), baseUrl: z.string().min(4).max(300), maxPages: z.number().int().min(1).max(200).default(40), notes: z.string().max(1000).optional() }), req.body);
    const url = validateCompetitorUrl(b.baseUrl);
    const r = await ctx.db.one(`INSERT INTO competitors(project_id, name, base_url, max_pages, notes) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (project_id, base_url) DO UPDATE SET name = EXCLUDED.name, is_active = true RETURNING *`, [projectId, b.name, url, b.maxPages, b.notes ?? null]);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'competitor.add', details: { url }, ...meta(req) });
    return r;
  });

  app.delete('/api/projects/:projectId/competitors/:id', async (req) => {
    requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    await ctx.db.query('DELETE FROM competitors WHERE id = $1 AND project_id = $2', [id, projectId]);
    return { ok: true };
  });

  /* ── Backlinks ── */
  app.post('/api/projects/:projectId/backlinks/import', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId } = req.params as P;
    const b = parse(z.object({ csv: z.string().min(1).max(1_900_000), fileName: z.string().max(300).optional() }), req.body);
    const r = await importBacklinks(ctx, projectId, b.csv);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'backlinks.import', details: { fileName: b.fileName, inserted: r.inserted, updated: r.updated, skipped: r.skipped }, ...meta(req) });
    return r;
  });

  /* ── Jobs (n8n + dashboard "run now") ── */
  app.get('/api/jobs', async () => Object.entries(JOBS).map(([type, j]) => ({ type, description: j.description, timeoutMs: j.timeoutMs })));

  app.post('/api/projects/:projectId/jobs/:type', async (req, reply) => {
    const a = requireRole(req, 'editor', 'service');
    const { projectId, type } = req.params as P & { type: string };
    const q = parse(z.object({ wait: z.coerce.boolean().default(false) }), req.query);
    // Who started it is recorded server-side (audit history); a body value can't impersonate anyone.
    const body = { ...((req.body ?? {}) as Record<string, unknown>), createdBy: a.label, requestedBy: a.label };
    if (type.startsWith('migration') && a.role === 'service' && type !== 'migration-snapshot') throw new AppError('Migration comparisons must be started by a user', 403, 'forbidden');
    const res = await runJob(ctx, projectId, type, body, { trigger: a.role === 'service' ? 'n8n' : `user:${a.label}`, correlationId: req.correlationId, wait: q.wait });
    if (res.status === 'failed') reply.code((res as { statusCode?: number }).statusCode && (res as { statusCode: number }).statusCode < 500 ? (res as { statusCode: number }).statusCode : 500);
    else if (res.status === 'running') reply.code(202);
    return res;
  });
}
