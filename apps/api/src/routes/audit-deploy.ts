import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listRules } from '@phoenixx/seo-engine';
import { AppError, signJwt, verifyJwt } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { meta, parse, requireRole } from '../http.js';
import { audit, getProject, profileOf } from '../services/common.js';
import { auditHistory, auditReport, compareAudits } from '../services/audits.js';
import { auditPdf } from '../services/audit-pdf.js';
import { decideRecommendation } from '../services/recommendations.js';
import { deployChange, deploymentStatus, getDeployment, listDeployments, previewChange, resolveDeployment, saveConnection, setLive, testConnection } from '../services/deployments.js';
import { emitEvent } from '../services/events.js';

type P = { projectId: string };
type PI = P & { id: string };
const device = z.enum(['desktop', 'mobile']).optional();

/** Display status for the unified change list (Changes page). */
function changeStatus(kind: 'recommendation' | 'change', s: string): string {
  if (kind === 'recommendation') return s === 'pending_approval' ? 'PENDING_APPROVAL' : s === 'rejected' ? 'REJECTED' : 'DRAFT';
  const map: Record<string, string> = { approved: 'APPROVED', deploying: 'DEPLOYING', deployed: 'DEPLOYED', implemented: 'DEPLOYED', verified: 'VERIFIED', monitoring: 'VERIFIED', completed: 'VERIFIED', failed: 'FAILED', verification_failed: 'VERIFICATION_FAILED', rolled_back: 'ROLLED_BACK' };
  return map[s] ?? s.toUpperCase();
}

export async function auditDeployRoutes(app: FastifyInstance, ctx: AppContext) {
  /* ── SEO audit ── */
  app.get('/api/projects/:projectId/audits', async (req) => {
    const q = parse(z.object({ device, auditId: z.string().uuid().optional() }), req.query);
    return auditReport(ctx, (req.params as P).projectId, q);
  });
  app.get('/api/projects/:projectId/audits/history', async (req) => {
    const q = parse(z.object({ device }), req.query);
    return auditHistory(ctx, (req.params as P).projectId, q.device, 100);
  });
  app.get('/api/projects/:projectId/audits/compare', async (req) => {
    const q = parse(z.object({ from: z.string().uuid(), to: z.string().uuid() }), req.query);
    return compareAudits(ctx, (req.params as P).projectId, q.from, q.to);
  });
  app.get('/api/projects/:projectId/audits/:id/pdf', async (req, reply) => {
    const { projectId, id } = req.params as PI;
    const { buffer, filename } = await auditPdf(ctx, projectId, id);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${filename}"`).send(buffer);
  });

  /** Read-only share link (7 days) to an HTML version of one audit. */
  app.post('/api/projects/:projectId/audits/:id/share', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    if (!(await ctx.db.one('SELECT 1 FROM seo_audits WHERE id = $1 AND project_id = $2', [id, projectId]))) throw new AppError('Audit not found', 404, 'not_found');
    const ttl = 7 * 24 * 3600;
    const token = signJwt({ purpose: 'audit_share', projectId, auditId: id }, ctx.jwtSecret, ttl);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'audit.share', entityType: 'seo_audit', entityId: id, ...meta(req) });
    return { url: `${ctx.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/api/shared/audits/${token}`, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  });
  app.get('/api/shared/audits/:token', async (req, reply) => {
    const t = verifyJwt<{ purpose: string; projectId: string; auditId: string }>((req.params as { token: string }).token, ctx.jwtSecret);
    if (!t || t.purpose !== 'audit_share') return reply.code(404).type('text/html').send('<p>This report link is invalid or has expired.</p>');
    const { buffer } = await auditPdf(ctx, t.projectId, t.auditId);
    return reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="seo-audit.pdf"').header('cache-control', 'private, no-store').header('x-robots-tag', 'noindex').send(buffer);
  });

  /* ── Recommendations: explain, preview ── */
  app.post('/api/projects/:projectId/recommendations/:id/explain', async (req) => {
    requireRole(req, 'editor', 'service');
    const { projectId, id } = req.params as PI;
    const rec = await ctx.db.one<any>('SELECT r.*, i.rule_id, i.description AS issue_description, i.evidence AS issue_evidence FROM recommendations r LEFT JOIN seo_issues i ON i.id = r.issue_id WHERE r.id = $1 AND r.project_id = $2', [id, projectId]);
    if (!rec) throw new AppError('Recommendation not found', 404, 'not_found');
    const rule = rec.rule_id ? listRules().find((r) => r.id === rec.rule_id) : null;
    const siblings = rec.rule_id ? await ctx.db.query<any>(`SELECT url, description, evidence FROM seo_issues WHERE project_id = $1 AND rule_id = $2 AND status = 'open' LIMIT 15`, [projectId, rec.rule_id]) : [];
    const gsc = rec.page_url
      ? await ctx.db.one<any>(`SELECT SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions FROM search_console_data WHERE project_id = $1 AND page = $2 AND query <> '' AND date > (SELECT MAX(date) FROM search_console_data WHERE project_id = $1) - 28`, [projectId, rec.page_url])
      : null;
    // The evidence block is exactly what the AI sees – it is returned so the UI can show it.
    const evidence = [
      ...siblings.map((s) => `Crawler: ${s.url ?? 'site'} – ${s.description}`),
      ...(rec.current_value ? [`Current value on ${rec.page_url}: "${rec.current_value}"`] : []),
      ...(rec.proposed_value ? [`Proposed value: "${String(rec.proposed_value).slice(0, 500)}"`] : []),
      ...(gsc?.impressions ? [`Search Console (last 28 days, ${rec.page_url}): ${gsc.impressions} impressions, ${gsc.clicks} clicks`] : ['Search Console: no data for this page (not connected or no impressions)']),
      ...(Array.isArray(rec.evidence) ? rec.evidence.filter((e: any) => e?.label && e.value !== null && e.value !== undefined).map((e: any) => `${e.label}: ${e.value}`) : []),
    ];
    const profile = profileOf(await getProject(ctx, projectId));
    const r = await ctx.ai.run(
      'recommendation-explain',
      { profile: { name: profile.name, services: profile.services.map((s) => s.name), locations: profile.locations.filter((l) => l.target).map((l) => l.name) }, title: rec.title, category: rule?.category ?? rec.type, rationale: rule?.rationale ?? rec.why, action: rec.what, risk: rec.risk, evidence: evidence.join('\n') },
      { projectId, correlationId: req.correlationId },
    );
    return { explanation: r.data, evidence, model: r.model, cached: r.cached, disclaimer: '"Observed" items restate the evidence above; "Inferred" items are the model\'s reasoning.' };
  });

  /** Dry run against the real (or demo) site file: exactly what would change. Writes nothing. */
  app.get('/api/projects/:projectId/recommendations/:id/preview', async (req) => {
    const { projectId, id } = req.params as PI;
    const rec = await ctx.db.one<any>('SELECT * FROM recommendations WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!rec) throw new AppError('Recommendation not found', 404, 'not_found');
    if (!rec.page_url) return { ok: false, message: 'Site-wide recommendation – no single page to preview.', current: rec.current_value, proposed: rec.proposed_value, fileDiff: [], checks: [] };
    return previewChange(ctx, projectId, { changeType: rec.type, pageUrl: rec.page_url, newValue: rec.proposed_value, oldValue: rec.current_value });
  });

  /** Approve (optionally with an edit) and start deployment in one action – used for "Approve & deploy". */
  app.post('/api/projects/:projectId/recommendations/:id/approve-and-deploy', async (req) => {
    const a = requireRole(req, 'editor');
    const { projectId, id } = req.params as PI;
    const b = parse(z.object({ comment: z.string().max(2000).optional(), editedValue: z.string().max(50000).optional(), previewConfirmed: z.boolean().optional() }), req.body ?? {});
    const d = await decideRecommendation(ctx, projectId, id, a, { decision: 'approve', ...b }, meta(req));
    await emitEvent(ctx, projectId, 'change.approved', { changeId: d.changeId, recommendationId: id, by: a.label });
    const target = await resolveDeployment(ctx, projectId);
    if (!d.changeId || !target.fileBased) return { ...d, deployment: null, note: target.fileBased ? null : 'Approved. The configured provider does not deploy files – use Implement on the change.' };
    try {
      return { ...d, deployment: await deployChange(ctx, projectId, d.changeId, a) };
    } catch (e) {
      return { ...d, deployment: null, note: (e as Error).message };
    }
  });

  /* ── Changes (unified list) & deployments ── */
  app.get('/api/projects/:projectId/change-requests', async (req) => {
    const { projectId } = req.params as P;
    const recs = await ctx.db.query<any>(
      `SELECT r.id, r.page_url, r.type, r.current_value, r.proposed_value, r.why, r.confidence, r.risk, r.status, r.source, r.ai_generated, r.ai_model, r.created_at, r.updated_at, r.title
       FROM recommendations r WHERE r.project_id = $1 AND r.status IN ('recommended','pending_approval','rejected') AND r.proposed_value IS NOT NULL ORDER BY r.updated_at DESC LIMIT 500`,
      [projectId],
    );
    const changes = await ctx.db.query<any>(
      `SELECT c.*, u.email AS approved_by, r.title, r.source, r.ai_generated, r.ai_model,
              (SELECT row_to_json(d) FROM (SELECT id, status, verification_status, rollback_available, restored_automatically, provider, mode, deployment_completed_at FROM website_deployments WHERE change_id = c.id AND action = 'deploy' ORDER BY created_at DESC LIMIT 1) d) AS deployment,
              (SELECT row_to_json(d) FROM (SELECT id, status, deployment_completed_at FROM website_deployments WHERE change_id = c.id AND action = 'rollback' ORDER BY created_at DESC LIMIT 1) d) AS rollback
       FROM seo_changes c LEFT JOIN users u ON u.id = c.reviewer_id LEFT JOIN recommendations r ON r.id = c.recommendation_id
       WHERE c.project_id = $1 ORDER BY c.updated_at DESC LIMIT 500`,
      [projectId],
    );
    const createdBy = (x: any) => (x.ai_generated ? `AI optimization${x.ai_model ? ` (${x.ai_model})` : ''}` : x.source === 'rule' ? 'SEO rules' : x.source ? `${String(x.source).replace('_', ' ')} agent` : 'system');
    return [
      ...changes.map((c) => ({
        id: c.id,
        kind: 'change' as const,
        changeId: c.id,
        recommendationId: c.recommendation_id,
        title: c.title,
        page: c.page_url,
        changeType: c.change_type,
        oldValue: c.old_value,
        newValue: c.new_value,
        aiReason: c.reason,
        confidence: c.confidence,
        risk: c.risk,
        status: changeStatus('change', c.status),
        rawStatus: c.status,
        createdBy: createdBy(c),
        approvedBy: c.approved_by,
        approvedAt: c.approved_at,
        deployedAt: c.deployed_at,
        verifiedAt: c.verified_at,
        deployment: c.deployment,
        verificationStatus: c.deployment?.verification_status ?? (c.verified_at ? 'passed' : null),
        rollback: c.rollback ?? (c.rolled_back_at ? { status: 'done', deployment_completed_at: c.rolled_back_at } : null),
        rollbackAvailable: !!c.deployment?.rollback_available || ['implemented', 'verified', 'monitoring', 'completed', 'approved', 'deployed', 'verification_failed'].includes(c.status),
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      })),
      ...recs.map((r) => ({
        id: r.id,
        kind: 'recommendation' as const,
        changeId: null,
        recommendationId: r.id,
        title: r.title,
        page: r.page_url,
        changeType: r.type,
        oldValue: r.current_value,
        newValue: r.proposed_value,
        aiReason: r.why,
        confidence: r.confidence,
        risk: r.risk,
        status: changeStatus('recommendation', r.status),
        rawStatus: r.status,
        createdBy: createdBy(r),
        approvedBy: null,
        approvedAt: null,
        deployedAt: null,
        verifiedAt: null,
        deployment: null,
        verificationStatus: null,
        rollback: null,
        rollbackAvailable: false,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    ].sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  });

  app.post('/api/projects/:projectId/changes/:id/deploy', async (req, reply) => {
    const a = requireRole(req, 'editor', 'service');
    const { projectId, id } = req.params as PI;
    const q = parse(z.object({ wait: z.coerce.boolean().default(false) }), req.query);
    const r = await deployChange(ctx, projectId, id, a, { wait: q.wait });
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'change.deploy', entityType: 'seo_change', entityId: id, details: { deploymentId: r.deploymentId }, ...meta(req) });
    if (r.status === 'running') reply.code(202);
    return r;
  });
  app.get('/api/projects/:projectId/deployments', async (req) => {
    const q = parse(z.object({ changeId: z.string().uuid().optional() }), req.query);
    return listDeployments(ctx, (req.params as P).projectId, q.changeId);
  });
  app.get('/api/projects/:projectId/deployments/:id', async (req) => getDeployment(ctx, (req.params as PI).projectId, (req.params as PI).id));

  /* ── Deployment connection (credentials never leave the server) ── */
  app.get('/api/projects/:projectId/deployment', async (req) => deploymentStatus(ctx, (req.params as P).projectId));
  app.put('/api/projects/:projectId/deployment/connection', async (req) => {
    const a = requireRole(req, 'admin');
    const b = parse(
      z.object({
        provider: z.enum(['manual', 'git', 'wordpress', 'api', 'ftp', 'sftp']),
        host: z.string().max(253).regex(/^[a-zA-Z0-9.-]+$/, 'Host name only (no protocol or path)').optional(),
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().max(200).optional(),
        password: z.string().max(500).optional(),
        privateKey: z.string().max(20000).optional(),
        passphrase: z.string().max(500).optional(),
        remoteRoot: z.string().max(300).regex(/^\/[^\0]*$/, 'Absolute remote directory, e.g. /public_html').refine((s) => !s.split('/').includes('..'), 'No ".." in the path').optional(),
        secure: z.enum(['true', 'implicit', 'false']).optional(),
        tlsServername: z.string().max(253).optional(),
        rejectUnauthorized: z.boolean().optional(),
        hostFingerprint: z.string().max(200).regex(/^SHA256:[A-Za-z0-9+/=]+$/, 'Format SHA256:…').optional(),
        allowInsecure: z.boolean().optional(),
        verifyBaseUrl: z.string().url().optional(),
        clearSecret: z.boolean().optional(),
      }),
      req.body,
    );
    return saveConnection(ctx, (req.params as P).projectId, a, b);
  });
  app.post('/api/projects/:projectId/deployment/test', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = requireRole(req, 'admin');
    return testConnection(ctx, (req.params as P).projectId, a);
  });
  app.post('/api/projects/:projectId/deployment/live', async (req) => {
    const a = requireRole(req, 'admin');
    const b = parse(z.object({ enabled: z.boolean(), confirmDomain: z.string().max(253).optional() }), req.body);
    return setLive(ctx, (req.params as P).projectId, a, b.enabled, b.enabled ? 'Enabled from settings' : 'Disabled from settings', b.confirmDomain);
  });
}
