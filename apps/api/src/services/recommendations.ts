import { AppError, HIGH_RISK_TYPES, riskForType, riskPolicy, sha256, type Priority, type RecommendationType, type RiskLevel } from '@phoenixx/shared';
import { draftFromIssue, scorePriority, type DetectedIssue, type PriorityInput } from '@phoenixx/seo-engine';
import type { CrawledPage, BusinessProfile } from '@phoenixx/shared';
import { upsert } from '@phoenixx/database';
import type { AppContext } from '../context.js';
import { audit, getProject, profileOf, type Actor } from './common.js';

export interface NewRecommendation {
  projectId: string;
  pageUrl?: string | null;
  pageId?: string | null;
  issueId?: string | null;
  source: 'rule' | 'ai' | 'keyword' | 'internal_linking' | 'local' | 'content' | 'migration' | 'competitor' | 'backlinks' | 'manual';
  type: RecommendationType;
  title: string;
  what: string;
  why: string;
  evidence: { label: string; value: string | number | null }[];
  currentValue?: string | null;
  proposedValue?: string | null;
  expectedPurpose: string;
  risk?: RiskLevel;
  confidence?: 'low' | 'medium' | 'high';
  priority: { priority: Priority; score: number; factors: unknown[]; reasons: string[] };
  aiGenerated?: boolean;
  aiModel?: string | null;
  fingerprint: string;
  /** Send straight to the approval queue (defaults: high/critical priority or high risk). */
  queueForApproval?: boolean;
}

/**
 * Upsert keyed by fingerprint. Existing recommendations keep their workflow status (a
 * rejected recommendation is not resurrected), but evidence/priority are refreshed.
 */
export async function upsertRecommendation(ctx: AppContext, r: NewRecommendation) {
  const risk = r.risk ?? riskForType(r.type);
  const queue = r.queueForApproval ?? (r.priority.priority === 'critical' || r.priority.priority === 'high' || risk === 'high');
  const existing = await ctx.db.one<{ id: string; status: string }>('SELECT id, status FROM recommendations WHERE project_id = $1 AND fingerprint = $2', [r.projectId, r.fingerprint]);
  const row = {
    project_id: r.projectId,
    page_id: r.pageId ?? null,
    page_url: r.pageUrl ?? null,
    issue_id: r.issueId ?? null,
    source: r.source,
    type: r.type,
    title: r.title,
    what: r.what,
    why: r.why,
    evidence: r.evidence,
    current_value: r.currentValue ?? null,
    proposed_value: r.proposedValue ?? null,
    expected_purpose: r.expectedPurpose,
    risk,
    priority: r.priority.priority,
    priority_score: r.priority.score,
    score_breakdown: { factors: r.priority.factors, reasons: r.priority.reasons },
    confidence: r.confidence ?? 'medium',
    requires_approval: true,
    ai_generated: r.aiGenerated ?? false,
    ai_model: r.aiModel ?? null,
    fingerprint: r.fingerprint,
    updated_at: new Date(),
  };
  if (existing) {
    const keepStatus = !['detected', 'analyzed', 'recommended', 'pending_approval'].includes(existing.status);
    const { project_id: _p, fingerprint: _f, ...patch } = row;
    // Never overwrite a human-edited proposal on an item already in review.
    const sets = Object.keys(patch).filter((k) => !(keepStatus && (k === 'proposed_value' || k === 'current_value')));
    await ctx.db.query(`UPDATE recommendations SET ${sets.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`, [existing.id, ...sets.map((k) => (patch as Record<string, unknown>)[k])]);
    // 'completed' only ever means "the issue disappeared before anyone acted". If it is detected
    // again, the recommendation is open again (rejected/approved/verified ones are never reopened).
    if (existing.status === 'completed') await ctx.db.query('UPDATE recommendations SET status = $2 WHERE id = $1', [existing.id, queue ? 'pending_approval' : 'recommended']);
    return { id: existing.id, created: false };
  }
  const inserted = await upsert<{ id: string }>(ctx.db, 'recommendations', { ...row, status: queue ? 'pending_approval' : 'recommended' }, ['project_id', 'fingerprint']);
  return { id: inserted.id, created: true };
}

export interface PageSearchStats {
  impressions: number;
  clicks: number;
  ctr: number;
  position: number | null;
}

/** Converts detected issues into recommendations with transparent priority. */
export async function recommendationsFromIssues(
  ctx: AppContext,
  projectId: string,
  issues: (DetectedIssue & { id: string; page_id: string | null })[],
  pages: Map<string, CrawledPage>,
  profile: BusinessProfile,
  searchByPage: Map<string, PageSearchStats>,
  siteAvgCtr: number,
) {
  let created = 0;
  const importantPaths = new Set(['/', ...profile.services.filter((s) => s.path).map((s) => s.path!)]);
  for (const issue of issues) {
    if (issue.severity === 'info') continue;
    const page = issue.url ? pages.get(issue.url) : undefined;
    const draft = draftFromIssue(issue, page, profile);
    if (!draft) continue;
    const s = issue.url ? searchByPage.get(issue.url) : undefined;
    const path = issue.url ? new URL(issue.url).pathname : '/';
    const input: PriorityInput = {
      impact: draft.impact,
      effort: draft.effort,
      severity: issue.severity,
      impressions: s?.impressions,
      clicks: s?.clicks,
      position: s?.position ?? null,
      ctr: s?.ctr ?? null,
      siteAvgCtr,
      businessRelevance: importantPaths.has(path) ? 5 : /faq/.test(path) ? 3 : /privacy|terms/.test(path) ? 1 : 2.5,
      confidence: draft.confidence,
      notes: [`Rule: ${issue.ruleId}`, ...(importantPaths.has(path) ? ['Core service/home page'] : [])],
    };
    const pr = scorePriority(input);
    const evidence = [
      { label: 'Detected', value: issue.title },
      ...(issue.url ? [{ label: 'Page', value: issue.url }] : []),
      ...(s ? [{ label: 'Impressions (28d)', value: s.impressions }, { label: 'Clicks (28d)', value: s.clicks }, { label: 'Avg position', value: s.position }] : []),
      ...Object.entries(issue.evidence)
        .filter(([, v]) => ['string', 'number'].includes(typeof v))
        .slice(0, 4)
        .map(([k, v]) => ({ label: k, value: v as string | number })),
    ];
    const res = await upsertRecommendation(ctx, {
      projectId,
      pageUrl: issue.url,
      pageId: issue.page_id,
      issueId: issue.id,
      source: 'rule',
      type: draft.type,
      title: issue.url ? `${draft.title} · ${path}` : draft.title,
      what: draft.what,
      why: draft.why,
      evidence,
      currentValue: draft.currentValue,
      proposedValue: draft.proposedValue,
      expectedPurpose: draft.expectedPurpose,
      risk: draft.risk,
      confidence: draft.confidence >= 0.8 ? 'high' : draft.confidence >= 0.6 ? 'medium' : 'low',
      priority: pr,
      fingerprint: 'issue:' + issue.fingerprint,
    });
    if (res.created) created++;
  }
  return created;
}

/* ───────────────────── Human decision (approve / reject / edit) ───────────────────── */

export function canApprove(actor: Actor, risk: string, type: string): boolean {
  const policy = riskPolicy(HIGH_RISK_TYPES.includes(type as RecommendationType) && risk !== 'critical' ? 'high' : (risk as RiskLevel));
  if (!policy.executable) return false; // critical: nobody can approve execution through the platform
  if (actor.role === 'admin') return true;
  if (actor.role === 'editor') return policy.approver === 'editor';
  return false; // viewers and service accounts (n8n) can never approve
}

export async function decideRecommendation(
  ctx: AppContext,
  projectId: string,
  recId: string,
  actor: Actor,
  input: { decision: 'approve' | 'reject'; comment?: string; editedValue?: string; previewConfirmed?: boolean },
  meta: { ip?: string; requestId?: string } = {},
) {
  const rec = await ctx.db.one<any>('SELECT * FROM recommendations WHERE id = $1 AND project_id = $2', [recId, projectId]);
  if (!rec) throw new AppError('Recommendation not found', 404, 'not_found');
  if (!['recommended', 'pending_approval', 'analyzed', 'detected'].includes(rec.status)) throw new AppError(`Recommendation is already ${rec.status}`, 409, 'invalid_state');
  if (input.decision === 'approve') await (await import('./autopilot.js')).assertAutomationAllows(ctx, projectId, 'approve');
  if (input.decision === 'approve') {
    if (rec.risk === 'critical') throw new AppError('Critical changes (file deletion, auth, database, DNS, server configuration) are never executed by the platform – do them manually with your hosting provider', 403, 'forbidden');
    if (!canApprove(actor, rec.risk, rec.type)) throw new AppError(rec.risk === 'high' || HIGH_RISK_TYPES.includes(rec.type) ? 'High-risk changes require an admin reviewer' : 'Your role cannot approve changes', 403, 'forbidden');
    if (riskPolicy(rec.risk).requiresPreview && !input.previewConfirmed) throw new AppError('High-risk changes must be approved from the preview (previewConfirmed: true)', 400, 'preview_required');
  } else if (!['admin', 'editor'].includes(actor.role)) throw new AppError('Your role cannot reject changes', 403, 'forbidden');
  const reviewerId = actor.type === 'user' ? actor.id : null;

  return ctx.db.transaction(async (tx) => {
    if (input.decision === 'reject') {
      await tx.query(`UPDATE recommendations SET status = 'rejected', updated_at = now() WHERE id = $1`, [recId]);
      await tx.query(`INSERT INTO approvals(project_id, recommendation_id, decision, reviewer_id, reviewer_label, comment) VALUES ($1,$2,'rejected',$3,$4,$5)`, [projectId, recId, reviewerId, actor.label, input.comment ?? null]);
      return { status: 'rejected', changeId: null };
    }
    const finalValue = input.editedValue ?? rec.proposed_value;
    if (input.editedValue !== undefined) {
      await tx.query(`INSERT INTO approvals(project_id, recommendation_id, decision, reviewer_id, reviewer_label, comment, edited_value) VALUES ($1,$2,'edited',$3,$4,$5,$6)`, [projectId, recId, reviewerId, actor.label, input.comment ?? null, input.editedValue]);
    }
    const [change] = await tx.query<{ id: string }>(
      `INSERT INTO seo_changes(project_id, recommendation_id, page_id, page_url, change_type, old_value, new_value, reason, ai_recommendation, reviewer_id, approval_status, status, risk, confidence, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'approved','approved',$11,$12, now()) RETURNING id`,
      [projectId, recId, rec.page_id, rec.page_url, rec.type, rec.current_value, finalValue, rec.why, { title: rec.title, what: rec.what, proposed: rec.proposed_value, aiGenerated: rec.ai_generated, model: rec.ai_model }, reviewerId, rec.risk, rec.confidence],
    );
    await tx.query(`INSERT INTO approvals(project_id, recommendation_id, change_id, decision, reviewer_id, reviewer_label, comment) VALUES ($1,$2,$3,'approved',$4,$5,$6)`, [projectId, recId, change!.id, reviewerId, actor.label, input.comment ?? null]);
    await tx.query(`INSERT INTO change_events(change_id, from_status, to_status, actor, note) VALUES ($1, NULL, 'approved', $2, $3)`, [change!.id, actor.label, input.editedValue !== undefined ? 'Approved with edits' : 'Approved']);
    await tx.query(`UPDATE recommendations SET status = 'approved', proposed_value = $2, updated_at = now() WHERE id = $1`, [recId, finalValue]);
    return { status: 'approved', changeId: change!.id };
  }).then(async (res) => {
    await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: `recommendation.${res.status}`, entityType: 'recommendation', entityId: recId, details: { changeId: res.changeId, edited: input.editedValue !== undefined, comment: input.comment }, ...meta });
    return res;
  });
}

/* ───────────────────── AI copy generation for a recommendation ───────────────────── */

export async function generateProposal(ctx: AppContext, projectId: string, recId: string, correlationId?: string) {
  const rec = await ctx.db.one<any>('SELECT * FROM recommendations WHERE id = $1 AND project_id = $2', [recId, projectId]);
  if (!rec) throw new AppError('Recommendation not found', 404, 'not_found');
  if (!rec.page_url) throw new AppError('Recommendation has no page', 400, 'bad_request');
  await (await import('./autopilot.js')).assertAutomationAllows(ctx, projectId, 'generate');
  const project = await getProject(ctx, projectId);
  const profile = profileOf(project);
  const page = await ctx.db.one<any>(`SELECT cr.* FROM crawl_results cr JOIN pages p ON p.last_crawl_result_id = cr.id WHERE p.url = $1 LIMIT 1`, [rec.page_url]);
  const queries = await ctx.db.query(
    `SELECT query, SUM(impressions)::int AS impressions, SUM(clicks)::int AS clicks, ROUND((SUM(position*impressions)/NULLIF(SUM(impressions),0))::numeric,1)::float AS position
     FROM search_console_data WHERE project_id = $1 AND page = $2 AND query <> '' AND date > (SELECT MAX(date) FROM search_console_data WHERE project_id = $1) - 90
     GROUP BY query ORDER BY impressions DESC LIMIT 15`,
    [projectId, rec.page_url],
  );
  const profileFacts = { name: profile.name, description: profile.description, services: profile.services.map((s) => s.name), locations: profile.locations.filter((l) => l.target).map((l) => l.name), facts: profile.facts, ctas: profile.ctas };
  let proposed: string;
  let reason: string;
  let model: string;
  if (rec.type === 'meta_description') {
    const r = await ctx.ai.run('meta-description', { profile: profileFacts, url: rec.page_url, title: page?.title, currentDescription: page?.meta_description, content: page?.text_sample?.slice(0, 2500), queries }, { projectId, correlationId });
    proposed = r.data.recommended;
    reason = r.data.reason;
    model = r.model;
  } else if (rec.type === 'title' || rec.type === 'h1') {
    const r = await ctx.ai.run('title-optimization', { profile: profileFacts, url: rec.page_url, currentTitle: page?.title, h1: page?.h1s?.[0] ?? page?.h2s?.[0], content: page?.text_sample?.slice(0, 2500), queries }, { projectId, correlationId });
    proposed = rec.type === 'h1' ? r.data.recommended.replace(/\s*\|\s*Phoenixx IT\s*$/i, '') : r.data.recommended;
    reason = r.data.reason;
    model = r.model;
  } else {
    throw new AppError(`AI proposals are not available for ${rec.type} recommendations; use on-page optimization.`, 400, 'unsupported');
  }
  await ctx.db.query(`UPDATE recommendations SET proposed_value = $2, why = why || $3, ai_generated = true, ai_model = $4, status = CASE WHEN status = 'recommended' THEN 'pending_approval' ELSE status END, updated_at = now() WHERE id = $1`, [recId, proposed, `\n\nAI rationale: ${reason}`, model]);
  return { proposed, reason, model };
}

export function fingerprint(...parts: (string | null | undefined)[]) {
  return sha256(parts.map((p) => p ?? '').join('|')).slice(0, 40);
}
