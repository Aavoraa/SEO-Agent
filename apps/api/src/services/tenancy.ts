import { AppError, orgCan, resolveEntitlements, slugify, type Entitlements, type FeatureKey, type LimitKey, type OrgPermission, type OrgRole } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import type { Actor } from './common.js';

/**
 * Tenancy + EntitlementService + usage metering + feature flags.
 * All plan checks go through here – routes never compare plan names themselves.
 */

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan_id: string;
  plan_overrides: { limits?: Record<string, unknown>; features?: Record<string, unknown>; beta?: boolean };
  billing_status: string;
  branding: Record<string, unknown>;
  is_internal: boolean;
  is_demo: boolean;
  status: string;
}

export async function getOrg(ctx: AppContext, orgId: string): Promise<OrgRow> {
  const o = await ctx.db.one<OrgRow>('SELECT * FROM organizations WHERE id = $1', [orgId]);
  if (!o) throw new AppError('Organization not found', 404, 'not_found');
  return o;
}

export async function orgOfProject(ctx: AppContext, projectId: string): Promise<OrgRow> {
  const o = await ctx.db.one<OrgRow>('SELECT o.* FROM organizations o JOIN projects p ON p.organization_id = o.id WHERE p.id = $1', [projectId]);
  if (!o) throw new AppError('Project has no organization', 500, 'no_org');
  return o;
}

export async function orgRoleOf(ctx: AppContext, orgId: string, userId: string | null): Promise<OrgRole | null> {
  if (!userId) return null;
  return (await ctx.db.one<{ role: OrgRole }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]))?.role ?? null;
}

/** Org-level permission check. Platform admins may do everything; API keys never manage orgs. */
export async function requireOrgPermission(ctx: AppContext, actor: Actor, orgId: string, permission: OrgPermission): Promise<OrgRole | 'platform_admin'> {
  const org = await getOrg(ctx, orgId);
  if (actor.type === 'user' && actor.role === 'admin') return 'platform_admin';
  if (actor.type !== 'user') throw new AppError('API keys cannot manage organizations', 403, 'forbidden');
  const role = await orgRoleOf(ctx, org.id, actor.id);
  if (!role) throw new AppError('Organization not found', 404, 'not_found');
  if (!orgCan(role, permission)) throw new AppError(`Your role (${role}) cannot ${permission.replace('.', ' ')}`, 403, 'forbidden');
  return role;
}

export async function createOrganization(ctx: AppContext, input: { name: string; ownerId: string; planId?: string; internal?: boolean; demo?: boolean }) {
  let slug = slugify(input.name) || 'org';
  if (await ctx.db.one('SELECT 1 FROM organizations WHERE slug = $1', [slug])) slug = `${slug}-${Date.now().toString(36)}`;
  const org = await ctx.db.one<OrgRow>(
    `INSERT INTO organizations(name, slug, plan_id, billing_status, is_internal, is_demo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.name, slug, input.planId ?? ctx.cfg.SIGNUP_DEFAULT_PLAN, input.internal ? 'internal' : 'trialing', !!input.internal, !!input.demo],
  );
  await ctx.db.query(`INSERT INTO organization_members(organization_id, user_id, role) VALUES ($1,$2,'owner')`, [org!.id, input.ownerId]);
  return org!;
}

/** The organization projects are created in when none is given (single-tenant installs, demo). */
export async function defaultOrganization(ctx: AppContext, opts: { demo?: boolean } = {}): Promise<OrgRow> {
  const slug = opts.demo ? 'demo' : 'internal';
  const existing = await ctx.db.one<OrgRow>('SELECT * FROM organizations WHERE slug = $1', [slug]);
  if (existing) return existing;
  const org = await ctx.db.one<OrgRow>(`INSERT INTO organizations(name, slug, plan_id, billing_status, is_internal, is_demo) VALUES ($1,$2,$3,'internal',$4,$5) RETURNING *`, [opts.demo ? 'Demo Organization' : 'Internal', slug, opts.demo ? 'agency' : 'internal', !opts.demo, !!opts.demo]);
  // Platform admins own the default organizations.
  await ctx.db.query(`INSERT INTO organization_members(organization_id, user_id, role) SELECT $1, id, 'owner' FROM users WHERE role = 'admin' ON CONFLICT DO NOTHING`, [org!.id]);
  return org!;
}

/* ───────────────────────── EntitlementService ───────────────────────── */

export async function entitlementsFor(ctx: AppContext, orgId: string): Promise<Entitlements> {
  const org = await getOrg(ctx, orgId);
  return resolveEntitlements(org.plan_id, org.plan_overrides as never);
}

export async function assertFeature(ctx: AppContext, orgId: string, feature: FeatureKey) {
  const e = await entitlementsFor(ctx, orgId);
  if (!e.features[feature]) throw new AppError(`Your ${e.planName} plan does not include ${feature.replace(/([A-Z])/g, ' $1').toLowerCase()}. Upgrade to use it.`, 402, 'feature_not_in_plan', { feature, plan: e.planId });
}

/** Throws 402 when `current + adding` would exceed the plan limit. */
export async function assertLimit(ctx: AppContext, orgId: string, limit: LimitKey, current: number, adding = 1) {
  const e = await entitlementsFor(ctx, orgId);
  const max = e.limits[limit];
  if (max !== null && typeof max === 'number' && current + adding > max) {
    throw new AppError(`Plan limit reached: ${limit.replace(/([A-Z])/g, ' $1').toLowerCase()} is ${max} on the ${e.planName} plan (currently ${current}).`, 402, 'plan_limit', { limit, max, current, plan: e.planId });
  }
}

/** Numeric limit, or `fallback` when unlimited. */
export async function limitValue(ctx: AppContext, orgId: string, limit: LimitKey, fallback: number): Promise<number> {
  const v = (await entitlementsFor(ctx, orgId)).limits[limit];
  return typeof v === 'number' ? v : fallback;
}

export async function recordUsage(ctx: AppContext, orgId: string, projectId: string | null, metric: string, quantity = 1, meta: Record<string, unknown> = {}) {
  await ctx.db.query('INSERT INTO usage_events(organization_id, project_id, metric, quantity, meta) VALUES ($1,$2,$3,$4,$5)', [orgId, projectId, metric, quantity, meta]);
}

/** Current usage vs limits (this calendar month for metered items). */
export async function usageSummary(ctx: AppContext, orgId: string) {
  const e = await entitlementsFor(ctx, orgId);
  const counts = await ctx.db.one<any>(
    `SELECT (SELECT COUNT(*) FROM projects WHERE organization_id = $1)::int AS projects,
            (SELECT COUNT(*) FROM organization_members WHERE organization_id = $1)::int AS users,
            (SELECT COALESCE(SUM(a.estimated_cost_usd),0) FROM ai_usage a JOIN projects p ON p.id = a.project_id WHERE p.organization_id = $1 AND a.created_at >= date_trunc('month', now()))::float AS ai_cost_usd,
            (SELECT COUNT(*) FROM seo_audits a JOIN projects p ON p.id = a.project_id WHERE p.organization_id = $1 AND a.created_at >= date_trunc('month', now()))::int AS audits,
            (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE organization_id = $1 AND metric = 'pages_crawled' AND created_at >= date_trunc('month', now()))::float AS pages_crawled,
            (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE organization_id = $1 AND metric = 'deployments' AND created_at >= date_trunc('month', now()))::float AS deployments,
            (SELECT COALESCE(SUM(quantity),0) FROM usage_events WHERE organization_id = $1 AND metric = 'automation_runs' AND created_at >= date_trunc('month', now()))::float AS automation_runs,
            (SELECT COUNT(*) FROM webhook_endpoints WHERE organization_id = $1)::int AS webhooks`,
    [orgId],
  );
  return {
    plan: { id: e.planId, name: e.planName },
    features: e.features,
    period: { start: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString() },
    items: [
      { key: 'projects', label: 'Projects', used: counts.projects, limit: e.limits.projects },
      { key: 'users', label: 'Users', used: counts.users, limit: e.limits.users },
      { key: 'audits', label: 'Audits this month', used: counts.audits, limit: e.limits.auditsPerMonth },
      { key: 'ai', label: 'AI spend this month (USD, estimated)', used: Math.round(counts.ai_cost_usd * 100) / 100, limit: e.limits.aiBudgetUsdMonthly },
      { key: 'webhooks', label: 'Webhook endpoints', used: counts.webhooks, limit: e.limits.webhooks },
      { key: 'pages', label: 'Pages crawled this month', used: counts.pages_crawled, limit: null },
      { key: 'deployments', label: 'Deployments this month', used: counts.deployments, limit: null },
      { key: 'automation', label: 'Autopilot runs this month', used: counts.automation_runs, limit: null },
    ],
    limits: e.limits,
  };
}

/* ───────────────────────── Feature flags ───────────────────────── */

export async function flagEnabled(ctx: AppContext, key: string, orgId: string | null): Promise<boolean> {
  const f = await ctx.db.one<{ state: string; org_ids: string[] }>('SELECT state, org_ids FROM feature_flags WHERE key = $1', [key]);
  if (!f) return true; // unknown flag → feature is not flag-gated
  if (f.state === 'public') return true;
  if (f.state === 'disabled' || !orgId) return false;
  const org = await getOrg(ctx, orgId);
  if (f.state === 'internal') return org.is_internal;
  if (f.state === 'beta') return org.is_internal || org.plan_overrides?.beta === true;
  return f.org_ids.includes(orgId);
}
