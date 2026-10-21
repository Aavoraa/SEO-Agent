import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, encryptSecret, generateApiKey, hashApiKey, hashPassword, loadPlans, ORG_ROLES, sha256, signJwt } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { meta, parse, requireActor, requireRole } from '../http.js';
import { audit } from '../services/common.js';
import { organizationsOf } from '../services/access.js';
import { assertFeature, assertLimit, createOrganization, entitlementsFor, getOrg, requireOrgPermission, usageSummary } from '../services/tenancy.js';
import { sendWebhookTest } from '../services/webhooks.js';
import { PLATFORM_EVENTS } from '../services/events.js';

type O = { orgId: string };
const orgRole = z.enum(ORG_ROLES);
const password = z.string().min(10).max(200);

/**
 * Organizations (tenants): sign-up, members & invitations, usage/entitlements, org API keys,
 * webhooks, branding; plus the platform-admin console (/api/admin/*).
 */
export async function orgRoutes(app: FastifyInstance, ctx: AppContext) {
  const issue = (u: { id: string; email: string; name: string; role: string }) => ({ token: signJwt({ sub: u.id, role: u.role }, ctx.jwtSecret), user: { id: u.id, email: u.email, name: u.name, role: u.role } });

  /* ── Self-service sign-up: user + organization (owner) ── */
  app.post('/api/auth/signup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    if (!ctx.cfg.SIGNUP_ENABLED || ctx.cfg.DEMO_MODE) throw new AppError('Sign-up is disabled on this installation', 403, 'signup_disabled');
    const b = parse(z.object({ email: z.string().email(), name: z.string().min(1).max(120), password, organizationName: z.string().min(1).max(120) }), req.body);
    if (await ctx.db.one('SELECT 1 FROM users WHERE lower(email) = lower($1)', [b.email])) throw new AppError('An account with this email already exists – sign in instead', 409, 'exists');
    const users = await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
    // The very first account of an installation becomes the platform admin; everyone else is a tenant user.
    const role = (users?.n ?? 0) === 0 ? 'admin' : 'viewer';
    const u = await ctx.db.one<any>(`INSERT INTO users(email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING *`, [b.email.toLowerCase(), b.name, hashPassword(b.password), role]);
    const org = await createOrganization(ctx, { name: b.organizationName, ownerId: u.id });
    await audit(ctx, { actorType: 'user', actorId: u.id, actorLabel: u.email, action: 'auth.signup', entityType: 'organization', entityId: org.id, details: { plan: org.plan_id }, ...meta(req) });
    return { ...issue(u), organization: { id: org.id, name: org.name, slug: org.slug, planId: org.plan_id } };
  });

  /* ── Invitations ── */
  app.post('/api/auth/accept-invite', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(z.object({ token: z.string().min(20).max(200), name: z.string().min(1).max(120).optional(), password: password.optional() }), req.body);
    const inv = await ctx.db.one<any>('SELECT * FROM organization_invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()', [sha256(b.token)]);
    if (!inv) throw new AppError('This invitation is invalid or has expired', 404, 'invalid_invite');
    let u = await ctx.db.one<any>('SELECT * FROM users WHERE lower(email) = lower($1)', [inv.email]);
    if (!u) {
      if (!b.name || !b.password) throw new AppError('Choose a name and password to create your account', 400, 'validation');
      u = await ctx.db.one<any>(`INSERT INTO users(email, name, password_hash, role) VALUES ($1,$2,$3,'viewer') RETURNING *`, [inv.email.toLowerCase(), b.name, hashPassword(b.password)]);
    }
    await ctx.db.query(`INSERT INTO organization_members(organization_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [inv.organization_id, u.id, inv.role]);
    await ctx.db.query('UPDATE organization_invitations SET accepted_at = now() WHERE id = $1', [inv.id]);
    await audit(ctx, { actorType: 'user', actorId: u.id, actorLabel: u.email, action: 'org.invite_accepted', entityType: 'organization', entityId: inv.organization_id, ...meta(req) });
    return issue(u);
  });

  /* ── Organizations ── */
  app.get('/api/orgs', async (req) => {
    const a = requireActor(req);
    if (a.type !== 'user') throw new AppError('Users only', 403, 'forbidden');
    return organizationsOf(ctx, a.id!);
  });

  app.post('/api/orgs', async (req) => {
    const a = requireActor(req);
    if (a.type !== 'user') throw new AppError('Users only', 403, 'forbidden');
    const b = parse(z.object({ name: z.string().min(1).max(120) }), req.body);
    const org = await createOrganization(ctx, { name: b.name, ownerId: a.id! });
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'org.create', entityType: 'organization', entityId: org.id, ...meta(req) });
    return org;
  });

  app.get('/api/orgs/:orgId', async (req) => {
    const a = requireActor(req);
    const { orgId } = req.params as O;
    const role = await requireOrgPermission(ctx, a, orgId, 'usage.view').catch(async (e) => {
      // Any member may see the organization basics; usage details need usage.view.
      if ((e as AppError).statusCode === 403) return null;
      throw e;
    });
    const org = await getOrg(ctx, orgId);
    const e = await entitlementsFor(ctx, orgId);
    const projects = await ctx.db.query(`SELECT p.id, p.name, p.is_demo, w.base_url FROM projects p LEFT JOIN websites w ON w.project_id = p.id AND w.is_primary WHERE p.organization_id = $1 ORDER BY p.created_at`, [orgId]);
    return { id: org.id, name: org.name, slug: org.slug, branding: org.branding, billingStatus: org.billing_status, isDemo: org.is_demo, entitlements: e, projects, usage: role ? await usageSummary(ctx, orgId) : null };
  });

  app.patch('/api/orgs/:orgId', async (req) => {
    const a = requireActor(req);
    const { orgId } = req.params as O;
    await requireOrgPermission(ctx, a, orgId, 'org.update');
    const b = parse(
      z.object({
        name: z.string().min(1).max(120).optional(),
        branding: z.object({ name: z.string().max(120).optional(), logoUrl: z.string().url().max(500).optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), reportFooter: z.string().max(500).optional() }).optional(),
      }),
      req.body,
    );
    if (b.branding && Object.keys(b.branding).length) await assertFeature(ctx, orgId, 'whiteLabel');
    const org = await getOrg(ctx, orgId);
    await ctx.db.query('UPDATE organizations SET name = COALESCE($2, name), branding = $3, updated_at = now() WHERE id = $1', [orgId, b.name ?? null, { ...org.branding, ...(b.branding ?? {}) }]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'org.update', entityType: 'organization', entityId: orgId, details: { keys: Object.keys(b) }, ...meta(req) });
    return { ok: true };
  });

  app.get('/api/orgs/:orgId/usage', async (req) => {
    const { orgId } = req.params as O;
    await requireOrgPermission(ctx, requireActor(req), orgId, 'usage.view');
    return usageSummary(ctx, orgId);
  });

  /* ── Members & invitations ── */
  app.get('/api/orgs/:orgId/members', async (req) => {
    const { orgId } = req.params as O;
    await requireOrgPermission(ctx, requireActor(req), orgId, 'members.manage');
    const members = await ctx.db.query(`SELECT u.id AS "userId", u.email, u.name, u.is_active AS "isActive", m.role, m.created_at AS "addedAt" FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 ORDER BY m.created_at`, [orgId]);
    const invitations = await ctx.db.query(`SELECT id, email, role, invited_by AS "invitedBy", expires_at AS "expiresAt", created_at AS "createdAt" FROM organization_invitations WHERE organization_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [orgId]);
    return { members, invitations };
  });

  app.post('/api/orgs/:orgId/invitations', async (req) => {
    const a = requireActor(req);
    const { orgId } = req.params as O;
    const actorRole = await requireOrgPermission(ctx, a, orgId, 'members.manage');
    const b = parse(z.object({ email: z.string().email(), role: orgRole }), req.body);
    if (b.role === 'owner' && actorRole !== 'owner' && actorRole !== 'platform_admin') throw new AppError('Only an owner can invite another owner', 403, 'forbidden');
    const members = (await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM organization_members WHERE organization_id = $1', [orgId]))!.n;
    await assertLimit(ctx, orgId, 'users', members);
    const token = randomBytes(24).toString('base64url');
    const inv = await ctx.db.one<{ id: string; expires_at: string }>(`INSERT INTO organization_invitations(organization_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING id, expires_at`, [orgId, b.email.toLowerCase(), b.role, sha256(token), a.label]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'org.invite', entityType: 'organization', entityId: orgId, details: { email: b.email, role: b.role }, ...meta(req) });
    // No email is sent from here: the inviter shares the link (email delivery uses the org's own channel).
    return { id: inv!.id, url: `${ctx.cfg.FRONTEND_URL.split(',')[0]!.replace(/\/$/, '')}/invite/${token}`, expiresAt: inv!.expires_at };
  });

  app.delete('/api/orgs/:orgId/invitations/:id', async (req) => {
    const { orgId, id } = req.params as O & { id: string };
    await requireOrgPermission(ctx, requireActor(req), orgId, 'members.manage');
    await ctx.db.query('DELETE FROM organization_invitations WHERE id = $1 AND organization_id = $2', [id, orgId]);
    return { ok: true };
  });

  app.patch('/api/orgs/:orgId/members/:userId', async (req) => {
    const a = requireActor(req);
    const { orgId, userId } = req.params as O & { userId: string };
    const actorRole = await requireOrgPermission(ctx, a, orgId, 'members.manage');
    const b = parse(z.object({ role: orgRole }), req.body);
    const target = await ctx.db.one<{ role: string }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
    if (!target) throw new AppError('Member not found', 404, 'not_found');
    if ((b.role === 'owner' || target.role === 'owner') && actorRole !== 'owner' && actorRole !== 'platform_admin') throw new AppError('Only an owner can change owners', 403, 'forbidden');
    if (target.role === 'owner' && b.role !== 'owner') {
      const owners = (await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'owner'`, [orgId]))!.n;
      if (owners <= 1) throw new AppError('An organization needs at least one owner', 400, 'last_owner');
    }
    await ctx.db.query('UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2', [orgId, userId, b.role]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'org.member_role', entityType: 'user', entityId: userId, details: { orgId, role: b.role }, ...meta(req) });
    return { ok: true };
  });

  app.delete('/api/orgs/:orgId/members/:userId', async (req) => {
    const a = requireActor(req);
    const { orgId, userId } = req.params as O & { userId: string };
    const actorRole = await requireOrgPermission(ctx, a, orgId, 'members.manage');
    const target = await ctx.db.one<{ role: string }>('SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
    if (!target) return { ok: true };
    if (target.role === 'owner') {
      if (actorRole !== 'owner' && actorRole !== 'platform_admin') throw new AppError('Only an owner can remove an owner', 403, 'forbidden');
      const owners = (await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'owner'`, [orgId]))!.n;
      if (owners <= 1) throw new AppError('An organization needs at least one owner', 400, 'last_owner');
    }
    await ctx.db.query('DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2', [orgId, userId]);
    await ctx.db.query('DELETE FROM project_members WHERE user_id = $1 AND project_id IN (SELECT id FROM projects WHERE organization_id = $2)', [userId, orgId]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'org.member_remove', entityType: 'user', entityId: userId, details: { orgId }, ...meta(req) });
    return { ok: true };
  });

  /* ── Organization API keys (scoped to this tenant) ── */
  app.get('/api/orgs/:orgId/api-keys', async (req) => {
    const { orgId } = req.params as O;
    await requireOrgPermission(ctx, requireActor(req), orgId, 'apikeys.manage');
    return ctx.db.query('SELECT id, name, role, project_id, created_at, last_used_at, revoked_at FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC', [orgId]);
  });
  app.post('/api/orgs/:orgId/api-keys', async (req) => {
    const a = requireActor(req);
    const { orgId } = req.params as O;
    await requireOrgPermission(ctx, a, orgId, 'apikeys.manage');
    await assertFeature(ctx, orgId, 'apiAccess');
    const b = parse(z.object({ name: z.string().min(1).max(80), role: z.enum(['service', 'viewer']).default('viewer'), projectId: z.string().uuid().optional() }), req.body);
    if (b.projectId && !(await ctx.db.one('SELECT 1 FROM projects WHERE id = $1 AND organization_id = $2', [b.projectId, orgId]))) throw new AppError('Project not found in this organization', 400, 'validation');
    const key = generateApiKey();
    const row = await ctx.db.one<any>('INSERT INTO api_keys(name, key_hash, role, created_by, project_id, organization_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, role, project_id, created_at', [b.name, hashApiKey(key), b.role, a.type === 'user' ? a.id : null, b.projectId ?? null, orgId]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'api_key.create', entityType: 'api_key', entityId: row.id, details: { orgId }, ...meta(req) });
    return { ...row, key, note: 'Store this key now – it is shown only once.' };
  });
  app.delete('/api/orgs/:orgId/api-keys/:id', async (req) => {
    const a = requireActor(req);
    const { orgId, id } = req.params as O & { id: string };
    await requireOrgPermission(ctx, a, orgId, 'apikeys.manage');
    await ctx.db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND organization_id = $2', [id, orgId]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'api_key.revoke', entityId: id, details: { orgId }, ...meta(req) });
    return { ok: true };
  });

  /* ── Webhooks ── */
  app.get('/api/orgs/:orgId/webhooks', async (req) => {
    const { orgId } = req.params as O;
    await requireOrgPermission(ctx, requireActor(req), orgId, 'webhooks.manage');
    const hooks = await ctx.db.query('SELECT id, url, events, active, failures, last_delivery_at, created_at FROM webhook_endpoints WHERE organization_id = $1 ORDER BY created_at', [orgId]);
    const deliveries = await ctx.db.query(`SELECT d.id, d.endpoint_id, d.event, d.status_code, d.success, d.error, d.duration_ms, d.created_at FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id = d.endpoint_id WHERE w.organization_id = $1 ORDER BY d.created_at DESC LIMIT 50`, [orgId]);
    return { endpoints: hooks, deliveries, events: PLATFORM_EVENTS };
  });
  app.post('/api/orgs/:orgId/webhooks', async (req) => {
    const a = requireActor(req);
    const { orgId } = req.params as O;
    await requireOrgPermission(ctx, a, orgId, 'webhooks.manage');
    await assertFeature(ctx, orgId, 'webhooks');
    const b = parse(z.object({ url: z.string().url().max(500).refine((u) => u.startsWith('https://') || ctx.cfg.NODE_ENV !== 'production', 'Webhook URLs must use https'), events: z.array(z.enum(PLATFORM_EVENTS)).min(1) }), req.body);
    const n = (await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM webhook_endpoints WHERE organization_id = $1', [orgId]))!.n;
    await assertLimit(ctx, orgId, 'webhooks', n);
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const row = await ctx.db.one<any>('INSERT INTO webhook_endpoints(organization_id, url, secret_encrypted, events) VALUES ($1,$2,$3,$4) RETURNING id, url, events, active, created_at', [orgId, b.url, encryptSecret(secret, ctx.encryptionKey), b.events]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'webhook.create', entityType: 'webhook', entityId: row.id, details: { url: b.url, events: b.events }, ...meta(req) });
    return { ...row, secret, note: 'Store the signing secret now – it is shown only once.' };
  });
  app.delete('/api/orgs/:orgId/webhooks/:id', async (req) => {
    const a = requireActor(req);
    const { orgId, id } = req.params as O & { id: string };
    await requireOrgPermission(ctx, a, orgId, 'webhooks.manage');
    await ctx.db.query('DELETE FROM webhook_endpoints WHERE id = $1 AND organization_id = $2', [id, orgId]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'webhook.delete', entityId: id, ...meta(req) });
    return { ok: true };
  });
  app.post('/api/orgs/:orgId/webhooks/:id/test', async (req) => {
    const { orgId, id } = req.params as O & { id: string };
    await requireOrgPermission(ctx, requireActor(req), orgId, 'webhooks.manage');
    return sendWebhookTest(ctx, orgId, id);
  });

  /* ── Projects in an organization ── */
  app.get('/api/plans', async () => Object.entries(loadPlans()).filter(([id]) => id !== 'internal').map(([id, p]) => ({ id, name: p.name, limits: p.limits, features: p.features })));

  /* ── Platform admin console ── */
  app.get('/api/admin/overview', async (req) => {
    requireRole(req, 'admin');
    const a = requireActor(req);
    if (a.type !== 'user') throw new AppError('Platform admins only', 403, 'forbidden');
    const totals = await ctx.db.one(
      `SELECT (SELECT COUNT(*) FROM organizations)::int AS organizations, (SELECT COUNT(*) FROM users)::int AS users, (SELECT COUNT(*) FROM projects)::int AS projects,
              (SELECT COUNT(*) FROM job_runs WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed_jobs_24h,
              (SELECT COUNT(*) FROM job_runs WHERE status = 'running')::int AS running_jobs,
              (SELECT COUNT(*) FROM crawl_runs WHERE started_at > now() - interval '24 hours')::int AS crawls_24h,
              (SELECT COUNT(*) FROM website_deployments WHERE status IN ('failed','restored','verification_failed') AND created_at > now() - interval '7 days')::int AS deployment_failures_7d,
              (SELECT COALESCE(SUM(estimated_cost_usd),0) FROM ai_usage WHERE created_at >= date_trunc('month', now()))::float AS ai_cost_month,
              (SELECT COUNT(*) FROM audit_logs WHERE action = 'auth.login_failed' AND created_at > now() - interval '24 hours')::int AS failed_logins_24h`,
    );
    const orgs = await ctx.db.query(
      `SELECT o.id, o.name, o.slug, o.plan_id, o.billing_status, o.status, o.is_internal, o.is_demo, o.created_at,
              (SELECT COUNT(*) FROM projects p WHERE p.organization_id = o.id)::int AS projects,
              (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id)::int AS users,
              (SELECT COALESCE(SUM(a.estimated_cost_usd),0) FROM ai_usage a JOIN projects p ON p.id = a.project_id WHERE p.organization_id = o.id AND a.created_at >= date_trunc('month', now()))::float AS ai_cost_month,
              (SELECT COALESCE(SUM(u.quantity),0) FROM usage_events u WHERE u.organization_id = o.id AND u.metric = 'pages_crawled' AND u.created_at >= date_trunc('month', now()))::float AS pages_crawled_month
       FROM organizations o ORDER BY o.created_at DESC LIMIT 500`,
    );
    const failedJobs = await ctx.db.query(`SELECT j.id, j.job_type, j.error, j.created_at, p.name AS project FROM job_runs j LEFT JOIN projects p ON p.id = j.project_id WHERE j.status = 'failed' ORDER BY j.created_at DESC LIMIT 20`);
    const securityEvents = await ctx.db.query(`SELECT action, actor_label, ip, created_at FROM audit_logs WHERE action IN ('auth.login_failed','deployment.live_enabled','deployment.connection_saved','api_key.create','org.member_role','webhook.create') ORDER BY created_at DESC LIMIT 30`);
    const flags = await ctx.db.query('SELECT key, state, org_ids, description, updated_at FROM feature_flags ORDER BY key');
    return { totals, orgs, failedJobs, securityEvents, flags, plans: Object.keys(loadPlans()) };
  });

  app.patch('/api/admin/orgs/:orgId', async (req) => {
    const a = requireRole(req, 'admin');
    if (a.type !== 'user') throw new AppError('Platform admins only', 403, 'forbidden');
    const { orgId } = req.params as O;
    const b = parse(z.object({ planId: z.string().refine((p) => !!loadPlans()[p], 'Unknown plan').optional(), status: z.enum(['active', 'suspended']).optional(), billingStatus: z.enum(['trialing', 'active', 'past_due', 'canceled', 'internal']).optional(), planOverrides: z.record(z.string(), z.unknown()).optional() }), req.body);
    await getOrg(ctx, orgId);
    await ctx.db.query('UPDATE organizations SET plan_id = COALESCE($2, plan_id), status = COALESCE($3, status), billing_status = COALESCE($4, billing_status), plan_overrides = COALESCE($5, plan_overrides), updated_at = now() WHERE id = $1', [orgId, b.planId ?? null, b.status ?? null, b.billingStatus ?? null, b.planOverrides ?? null]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'admin.org_update', entityType: 'organization', entityId: orgId, details: b, ...meta(req) });
    return { ok: true };
  });

  app.put('/api/admin/feature-flags/:key', async (req) => {
    const a = requireRole(req, 'admin');
    if (a.type !== 'user') throw new AppError('Platform admins only', 403, 'forbidden');
    const key = (req.params as { key: string }).key;
    if (!/^[a-z0-9_.-]{2,60}$/.test(key)) throw new AppError('Invalid flag key', 400, 'validation');
    const b = parse(z.object({ state: z.enum(['disabled', 'internal', 'beta', 'orgs', 'public']), orgIds: z.array(z.string().uuid()).max(1000).default([]), description: z.string().max(300).optional() }), req.body);
    await ctx.db.query(`INSERT INTO feature_flags(key, state, org_ids, description, updated_at) VALUES ($1,$2,$3,$4, now()) ON CONFLICT (key) DO UPDATE SET state = EXCLUDED.state, org_ids = EXCLUDED.org_ids, description = COALESCE(EXCLUDED.description, feature_flags.description), updated_at = now()`, [key, b.state, b.orgIds, b.description ?? null]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'admin.feature_flag', entityType: 'feature_flag', entityId: key, details: b, ...meta(req) });
    return { ok: true };
  });
}
