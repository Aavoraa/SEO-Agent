import { AppError, riskPolicy, type RiskLevel } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { audit, getProject, type Actor } from './common.js';
import { decideRecommendation } from './recommendations.js';
import { assertFeature, entitlementsFor, orgOfProject, recordUsage } from './tenancy.js';

/**
 * Automation levels (per project, capped by the plan's automationLevelMax):
 *   0 Analyze only    – audits and scores; no AI fixes, no approvals
 *   1 Recommend       – recommendations and approvals; no AI-generated fixes
 *   2 Generate        – AI prepares fixes; every change needs a human approval (default)
 *   3 Autopilot (low) – LOW-risk fixes with high confidence and a concrete value are approved and
 *                       deployed by the system, up to a daily limit
 *   4 Autopilot (bounded) – level 3 + MEDIUM-risk change types the admin explicitly allowed
 * HIGH and CRITICAL changes are never approved automatically at any level.
 */
export interface AutomationSettings {
  level: 0 | 1 | 2 | 3 | 4;
  allowedMediumTypes: string[];
  dailyLimit: number;
}

export const DEFAULT_AUTOMATION: AutomationSettings = { level: 2, allowedMediumTypes: [], dailyLimit: 5 };
const AUTO_TYPES = ['title', 'meta_description', 'h1', 'schema', 'other'];

export function automationOf(settings: unknown): AutomationSettings {
  const a = ((settings as { automation?: Partial<AutomationSettings> }) ?? {}).automation ?? {};
  return { ...DEFAULT_AUTOMATION, ...a, level: (a.level ?? 2) as AutomationSettings['level'] };
}

/** Called from the approval / AI-fix paths to enforce levels 0 and 1. */
export async function assertAutomationAllows(ctx: AppContext, projectId: string, action: 'generate' | 'approve') {
  const lvl = automationOf((await getProject(ctx, projectId)).settings).level;
  if (action === 'approve' && lvl < 1) throw new AppError('This project is in "Analyze only" mode (automation level 0) – raise the level in Settings → Automation to act on recommendations.', 409, 'automation_level');
  if (action === 'generate' && lvl < 2) throw new AppError('AI-generated fixes are off for this project (automation level below 2).', 409, 'automation_level');
}

export async function validateAutomation(ctx: AppContext, projectId: string, next: AutomationSettings) {
  const org = await orgOfProject(ctx, projectId);
  const e = await entitlementsFor(ctx, org.id);
  if (next.level > e.limits.automationLevelMax) throw new AppError(`Your ${e.planName} plan allows automation up to level ${e.limits.automationLevelMax}`, 402, 'plan_limit');
  if (next.level >= 3) await assertFeature(ctx, org.id, 'autopilot');
  if (next.allowedMediumTypes.some((t) => !['h1', 'headings', 'content', 'faq', 'cta'].includes(t))) throw new AppError('Only medium-risk change types can be allowed for level 4', 400, 'validation');
}

export async function runAutopilot(ctx: AppContext, projectId: string) {
  const project = await getProject(ctx, projectId);
  const s = automationOf(project.settings);
  if (s.level < 3) return { level: s.level, skipped: true, reason: 'Autopilot runs at automation level 3 or 4' };
  const org = await orgOfProject(ctx, projectId);
  const e = await entitlementsFor(ctx, org.id);
  if (!e.features.autopilot || e.limits.automationLevelMax < 3) return { level: s.level, skipped: true, reason: `Autopilot is not included in the ${e.planName} plan` };
  const label = `Autopilot (level ${s.level})`;
  const today = (await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM approvals WHERE project_id = $1 AND reviewer_label = $2 AND decision = 'approved' AND created_at >= date_trunc('day', now())`, [projectId, label]))!.n;
  const budget = Math.max(0, s.dailyLimit - today);
  if (!budget) return { level: s.level, approved: 0, deployed: 0, reason: 'Daily autopilot limit reached' };
  const allowedRisks: RiskLevel[] = s.level === 4 ? ['low', 'medium'] : ['low'];
  const recs = await ctx.db.query<{ id: string; type: string; risk: RiskLevel; confidence: string }>(
    `SELECT id, type, risk, confidence FROM recommendations WHERE project_id = $1 AND status IN ('recommended','pending_approval') AND proposed_value IS NOT NULL AND page_url IS NOT NULL
       AND risk = ANY($2::text[]) AND type = ANY($3::text[]) ORDER BY priority_score DESC LIMIT 50`,
    [projectId, allowedRisks, [...AUTO_TYPES, ...s.allowedMediumTypes]],
  );
  // The autopilot acts with editor rights: the risk policy itself makes high/critical unapprovable.
  const actor: Actor = { type: 'system', id: null, label, role: 'editor' };
  const { resolveDeployment, deployChange, FILE_DEPLOYABLE } = await import('./deployments.js');
  const target = await resolveDeployment(ctx, projectId);
  const canDeploy = target.fileBased && target.configured && (target.mode === 'demo' || target.liveEnabled);
  const out = { level: s.level, considered: recs.length, approved: 0, deployed: 0, skipped: [] as string[] };
  for (const r of recs) {
    if (out.approved >= budget) break;
    const policy = riskPolicy(r.risk);
    const mediumAllowed = r.risk === 'medium' && s.level === 4 && s.allowedMediumTypes.includes(r.type);
    if (!policy.executable || policy.requiresPreview || (r.risk !== 'low' && !mediumAllowed)) continue;
    if (r.confidence !== 'high' && !(s.level === 4 && r.confidence === 'medium')) {
      out.skipped.push(`${r.id}: confidence ${r.confidence}`);
      continue;
    }
    const d = await decideRecommendation(ctx, projectId, r.id, actor, { decision: 'approve', comment: `Approved automatically – project automation level ${s.level}` });
    out.approved++;
    if (canDeploy && d.changeId && FILE_DEPLOYABLE.includes(r.type)) {
      const dep = await deployChange(ctx, projectId, d.changeId, actor, { wait: true }).catch((e) => ({ status: 'failed', error: (e as Error).message }));
      if (dep.status === 'verified') out.deployed++;
    }
  }
  await recordUsage(ctx, org.id, projectId, 'automation_runs', 1, { approved: out.approved, deployed: out.deployed });
  await audit(ctx, { projectId, actorType: 'system', actorLabel: label, action: 'autopilot.run', details: out });
  return out;
}
