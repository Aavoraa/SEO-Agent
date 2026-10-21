import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import { json, testApp } from './helpers.js';
import { startFixtureSite } from '../../../tests/fixtures/site.js';
import { dbAIStore } from '../src/context.js';
import { flagEnabled } from '../src/services/tenancy.js';

/**
 * Multi-tenant SaaS foundation, end to end over the HTTP API:
 * sign-up → organization → project (plan limits) → invitations/roles → isolation between tenants →
 * audit → Opportunity Engine / Next Best Action / Command Center → webhooks → automation levels → admin console.
 */
let t: Awaited<ReturnType<typeof testApp>>;
let site: Awaited<ReturnType<typeof startFixtureSite>>;
let hook: { url: string; received: { headers: http.IncomingHttpHeaders; body: string }[]; close: () => Promise<void> };
let platformAdmin: string;
let aliceToken: string; // owner of Acme
let acmeOrg: string;
let acmeProject: string;
let bobToken: string; // owner of Beta (other tenant)
let betaOrg: string;
const SERVICE = 'test-service-key-123456';

async function startHook() {
  const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: b });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(srv.address() as any).port}/hook`, received, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

beforeAll(async () => {
  site = await startFixtureSite();
  hook = await startHook();
  t = await testApp({ WEBHOOK_ALLOW_PRIVATE_HOSTS: true, OUTBOUND_ALLOW_PRIVATE_HOSTS: true } as never);
});
afterAll(async () => {
  await t.close();
  await site.close();
  await hook.close();
});

describe('sign-up & organizations', () => {
  it('first sign-up becomes platform admin; later sign-ups are tenant owners only', async () => {
    const first = await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'root@platform.example', name: 'Root', password: 'correct horse battery', organizationName: 'Platform Ops' } });
    expect(first.status).toBe(200);
    expect(first.body.user.role).toBe('admin');
    platformAdmin = first.body.token;
    const alice = await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'alice@acme.example', name: 'Alice', password: 'correct horse battery', organizationName: 'Acme Plumbing' } });
    expect(alice.body.user.role).toBe('viewer'); // not a platform admin
    expect(alice.body.organization).toMatchObject({ name: 'Acme Plumbing', planId: 'starter' });
    aliceToken = alice.body.token;
    acmeOrg = alice.body.organization.id;
    const bob = await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'bob@beta.example', name: 'Bob', password: 'correct horse battery', organizationName: 'Beta Dental' } });
    bobToken = bob.body.token;
    betaOrg = bob.body.organization.id;
    expect((await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'ALICE@acme.example', name: 'A', password: 'correct horse battery', organizationName: 'X' } })).status).toBe(409);
    const me = await json(t.app, 'GET', '/api/auth/me', { token: aliceToken });
    expect(me.body.organizations).toEqual([expect.objectContaining({ id: acmeOrg, role: 'owner', planId: 'starter' })]);
  });

  it('creates projects inside the organization and enforces the plan limit', async () => {
    const p = await json(t.app, 'POST', '/api/projects', { token: aliceToken, body: { name: 'Acme site', siteUrl: site.origin + '/', organizationId: acmeOrg } });
    expect(p.status).toBe(200);
    acmeProject = p.body.id;
    const second = await json(t.app, 'POST', '/api/projects', { token: aliceToken, body: { name: 'Second', siteUrl: 'https://second.example/', organizationId: acmeOrg } });
    expect(second.status).toBe(402);
    expect(second.body.error.code).toBe('plan_limit');
    // Customer projects start with an empty business profile (no Phoenixx services/locations).
    const proj = await json(t.app, 'GET', `/api/projects/${acmeProject}`, { token: aliceToken });
    expect(proj.body.businessProfile.services).toEqual([]);
    expect(proj.body.myRole).toBe('admin');
    // Bob can't create projects in Acme.
    expect((await json(t.app, 'POST', '/api/projects', { token: bobToken, body: { name: 'x', siteUrl: 'https://x.example/', organizationId: acmeOrg } })).status).toBe(404);
  });

  it('keeps tenants isolated', async () => {
    expect((await json(t.app, 'GET', '/api/projects', { token: bobToken })).body).toEqual([]);
    for (const path of ['', '/overview', '/command-center', '/opportunities', '/search?q=web']) {
      expect((await json(t.app, 'GET', `/api/projects/${acmeProject}${path}`, { token: bobToken })).status, path).toBe(404);
    }
    expect((await json(t.app, 'GET', `/api/orgs/${acmeOrg}`, { token: bobToken })).status).toBe(404);
    expect((await json(t.app, 'GET', `/api/orgs/${acmeOrg}/members`, { token: bobToken })).status).toBe(404);
  });
});

describe('invitations & organization roles', () => {
  const invite = async (email: string, role: string) => (await json(t.app, 'POST', `/api/orgs/${acmeOrg}/invitations`, { token: aliceToken, body: { email, role } })).body;
  const accept = async (url: string, email: string) => (await json(t.app, 'POST', '/api/auth/accept-invite', { body: { token: url.split('/invite/')[1], name: email, password: 'password-long-enough' } })).body.token as string;

  it('invites, enforces the user limit, and maps roles onto project permissions', async () => {
    const inv = await invite('sam@acme.example', 'seo_specialist');
    expect(inv.url).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);
    const sam = await accept(inv.url, 'sam@acme.example');
    expect((await json(t.app, 'GET', '/api/projects', { token: sam })).body.map((p: any) => p.id)).toEqual([acmeProject]);
    expect((await json(t.app, 'GET', `/api/projects/${acmeProject}`, { token: sam })).body.myRole).toBe('editor');
    // Starter plan: 2 users → a third member is refused.
    const third = await json(t.app, 'POST', `/api/orgs/${acmeOrg}/invitations`, { token: aliceToken, body: { email: 'carl@acme.example', role: 'client' } });
    expect(third.status).toBe(402);
    // Specialists can't manage members.
    expect((await json(t.app, 'POST', `/api/orgs/${acmeOrg}/invitations`, { token: sam, body: { email: 'x@acme.example', role: 'viewer' } })).status).toBe(403);
    // Invitation tokens are single-use.
    expect((await json(t.app, 'POST', '/api/auth/accept-invite', { body: { token: inv.url.split('/invite/')[1] } })).status).toBe(404);
  });

  it('protects the last owner', async () => {
    const members = (await json(t.app, 'GET', `/api/orgs/${acmeOrg}/members`, { token: aliceToken })).body.members;
    const aliceId = members.find((m: any) => m.email === 'alice@acme.example').userId;
    expect((await json(t.app, 'PATCH', `/api/orgs/${acmeOrg}/members/${aliceId}`, { token: aliceToken, body: { role: 'admin' } })).body.error.code).toBe('last_owner');
  });
});

describe('plans, admin console & feature flags', () => {
  it('gates features by plan and lets the platform admin change plans', async () => {
    const denied = await json(t.app, 'POST', `/api/orgs/${acmeOrg}/webhooks`, { token: aliceToken, body: { url: hook.url, events: ['audit.completed'] } });
    expect(denied.status).toBe(402);
    expect(denied.body.error.code).toBe('feature_not_in_plan');
    expect((await json(t.app, 'GET', '/api/admin/overview', { token: aliceToken })).status).toBe(403);
    expect((await json(t.app, 'PATCH', `/api/admin/orgs/${acmeOrg}`, { token: platformAdmin, body: { planId: 'growth', billingStatus: 'active' } })).status).toBe(200);
    const usage = await json(t.app, 'GET', `/api/orgs/${acmeOrg}/usage`, { token: aliceToken });
    expect(usage.body.plan.id).toBe('growth');
    expect(usage.body.items.find((i: any) => i.key === 'projects')).toMatchObject({ used: 1, limit: 5 });
    const admin = await json(t.app, 'GET', '/api/admin/overview', { token: platformAdmin });
    expect(admin.body.orgs.find((o: any) => o.id === acmeOrg)).toMatchObject({ plan_id: 'growth', projects: 1, users: 2 });
  });

  it('feature flags: disabled / internal / selected organizations / public', async () => {
    expect(await flagEnabled(t.ctx, 'unknown-flag', acmeOrg)).toBe(true);
    await json(t.app, 'PUT', '/api/admin/feature-flags/ai-visibility', { token: platformAdmin, body: { state: 'orgs', orgIds: [acmeOrg] } });
    expect(await flagEnabled(t.ctx, 'ai-visibility', acmeOrg)).toBe(true);
    expect(await flagEnabled(t.ctx, 'ai-visibility', betaOrg)).toBe(false);
    await json(t.app, 'PUT', '/api/admin/feature-flags/ai-visibility', { token: platformAdmin, body: { state: 'disabled' } });
    expect(await flagEnabled(t.ctx, 'ai-visibility', acmeOrg)).toBe(false);
  });
});

describe('webhooks', () => {
  it('delivers HMAC-signed events for subscribed types and records deliveries', async () => {
    const created = await json(t.app, 'POST', `/api/orgs/${acmeOrg}/webhooks`, { token: aliceToken, body: { url: hook.url, events: ['audit.completed', 'approval.required'] } });
    expect(created.status).toBe(200);
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^whsec_/);
    const list = await json(t.app, 'GET', `/api/orgs/${acmeOrg}/webhooks`, { token: aliceToken });
    expect(JSON.stringify(list.body)).not.toContain(secret);
    const r = await json(t.app, 'POST', `/api/projects/${acmeProject}/jobs/seo-audit?wait=true`, { token: aliceToken, body: {} });
    expect(r.body.status, r.body.error).toBe('succeeded');
    const got = hook.received.find((h) => JSON.parse(h.body).event === 'audit.completed')!;
    expect(got).toBeTruthy();
    const [tPart, vPart] = String(got.headers['x-webhook-signature']).split(',');
    expect(vPart!.slice(3)).toBe(createHmac('sha256', secret).update(`${tPart!.slice(2)}.${got.body}`).digest('hex'));
    expect(JSON.parse(got.body)).toMatchObject({ event: 'audit.completed', organizationId: acmeOrg, projectId: acmeProject, data: { auditId: r.body.output.auditId } });
    expect(hook.received.some((h) => JSON.parse(h.body).event === 'approval.required')).toBe(true);
    const deliveries = (await json(t.app, 'GET', `/api/orgs/${acmeOrg}/webhooks`, { token: aliceToken })).body.deliveries;
    expect(deliveries.every((d: any) => d.success)).toBe(true);
  });

  it('refuses private webhook targets unless explicitly allowed', async () => {
    const strict = await testApp();
    try {
      const u = await json(strict.app, 'POST', '/api/auth/signup', { body: { email: 'o@o.example', name: 'O', password: 'correct horse battery', organizationName: 'O' } });
      await json(strict.app, 'PATCH', `/api/admin/orgs/${u.body.organization.id}`, { token: u.body.token, body: { planId: 'growth' } });
      const w = await json(strict.app, 'POST', `/api/orgs/${u.body.organization.id}/webhooks`, { token: u.body.token, body: { url: 'http://127.0.0.1:9/x', events: ['alert.created'] } });
      const test = await json(strict.app, 'POST', `/api/orgs/${u.body.organization.id}/webhooks/${w.body.id}/test`, { token: u.body.token });
      expect(test.body).toMatchObject({ success: false, error: 'Private address not allowed' });
    } finally {
      await strict.close();
    }
  });
});

describe('Opportunity Engine, Next Best Action & Command Center', () => {
  it('scores opportunities with the documented formula and ranks the next best action', async () => {
    const r = await json(t.app, 'GET', `/api/projects/${acmeProject}/opportunities`, { token: aliceToken });
    expect(r.body.items.length).toBeGreaterThan(3);
    expect(r.body.formula.weights).toEqual({ impact: 0.3, businessValue: 0.2, confidence: 0.15, ease: 0.15, timeSensitivity: 0.1, safety: 0.1 });
    for (const o of r.body.items) {
      const f = Object.fromEntries(o.factors.map((x: any) => [x.name, x.value]));
      const expected = 100 * (0.3 * f.impact + 0.2 * f.businessValue + 0.15 * f.confidence + 0.15 * f.ease + 0.1 * f.timeSensitivity + 0.1 * f.safety) * f.memory;
      expect(o.priority_score).toBeCloseTo(Math.min(100, expected), 0);
      expect(o.data_sources.length).toBeGreaterThan(0);
    }
    const scores = r.body.items.map((o: any) => o.priority_score);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
    const nba = (await json(t.app, 'GET', `/api/projects/${acmeProject}/next-best-action`, { token: aliceToken })).body.nextBestAction;
    expect(nba.id).toBe(r.body.items[0].id);
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(nba.expectedOpportunity);
  });

  it('keeps dismissals across refreshes', async () => {
    const top = (await json(t.app, 'GET', `/api/projects/${acmeProject}/opportunities`, { token: aliceToken })).body.items[0];
    await json(t.app, 'PATCH', `/api/projects/${acmeProject}/opportunities/${top.id}`, { token: aliceToken, body: { status: 'dismissed' } });
    await json(t.app, 'POST', `/api/projects/${acmeProject}/opportunities/refresh`, { token: aliceToken });
    const after = (await json(t.app, 'GET', `/api/projects/${acmeProject}/opportunities?status=all`, { token: aliceToken })).body.items.find((o: any) => o.id === top.id);
    expect(after.status).toBe('dismissed');
  });

  it('Command Center labels every metric with its source and never invents missing data', async () => {
    const cc = await json(t.app, 'GET', `/api/projects/${acmeProject}/command-center`, { token: aliceToken });
    const m = Object.fromEntries(cc.body.metrics.map((x: any) => [x.key, x]));
    expect(m.seo_health).toMatchObject({ dataLabel: 'modeled', source: 'Site crawler (SEO audit)' });
    expect(typeof m.seo_health.value).toBe('number');
    for (const k of ['organic_clicks', 'organic_sessions', 'conversions', 'backlinks']) expect(m[k]).toMatchObject({ value: null, dataLabel: 'unavailable' });
    expect(cc.body.nextBestAction).toBeTruthy();
    expect(cc.body.loop.opportunities).toBeGreaterThan(0);
  });

  it('global search finds pages and issues within the project', async () => {
    const s = await json(t.app, 'GET', `/api/projects/${acmeProject}/search?q=web-design`, { token: aliceToken });
    expect(s.body.groups.map((g: any) => g.type)).toContain('pages');
  });
});

describe('website detection & onboarding', () => {
  it('detects the stack and recommends a connection without guessing the host', async () => {
    const d = await json(t.app, 'POST', '/api/onboarding/detect', { token: bobToken, body: { url: site.origin } });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ rendering: 'static-html', cms: null, robots: { found: true }, sitemap: { found: true } });
    expect(d.body.recommendedConnection.method).toBe('sftp');
    expect(d.body.connectionOptions.at(-1).method).toBe('manual');
    expect(d.body.hostingNote).toMatch(/not inferred/);
  });

  it('creates a project from onboarding and tracks the checklist', async () => {
    const p = await json(t.app, 'POST', '/api/onboarding/projects', { token: bobToken, body: { organizationId: betaOrg, url: site.origin } });
    expect(p.status).toBe(200);
    const o = await json(t.app, 'GET', `/api/projects/${p.body.project.id}/onboarding`, { token: bobToken });
    expect(o.body.detection.rendering).toBe('static-html');
    expect(o.body.steps.find((s: any) => s.id === 'audit').done).toBe(false);
  });

  it('refuses private addresses in production mode', async () => {
    const strict = await testApp();
    try {
      const u = await json(strict.app, 'POST', '/api/auth/signup', { body: { email: 'p@p.example', name: 'P', password: 'correct horse battery', organizationName: 'P' } });
      expect((await json(strict.app, 'POST', '/api/onboarding/detect', { token: u.body.token, body: { url: 'http://127.0.0.1:9' } })).status).toBe(400);
    } finally {
      await strict.close();
    }
  });
});

describe('automation levels', () => {
  it('level 0 blocks approvals; level 3 needs the plan; autopilot approves only low-risk, high-confidence fixes', async () => {
    const put = (level: number, token = aliceToken) => json(t.app, 'PUT', `/api/projects/${acmeProject}/automation`, { token, body: { level } });
    expect((await put(0)).status).toBe(200);
    const rec = await t.ctx.db.one<any>(`SELECT id FROM recommendations WHERE project_id = $1 AND status IN ('recommended','pending_approval') AND risk <> 'high' LIMIT 1`, [acmeProject]);
    expect((await json(t.app, 'POST', `/api/projects/${acmeProject}/recommendations/${rec.id}/decision`, { token: aliceToken, body: { decision: 'approve' } })).body.error.code).toBe('automation_level');
    expect((await put(4)).status).toBe(402); // growth allows up to 3
    expect((await put(3)).status).toBe(200);
    // Seed candidates: one low-risk/high-confidence title fix, one high-risk canonical.
    await t.ctx.db.query(`UPDATE recommendations SET proposed_value = 'Autopilot title', confidence = 'high', status = 'pending_approval' WHERE id = (SELECT id FROM recommendations WHERE project_id = $1 AND type = 'title' AND page_url IS NOT NULL LIMIT 1)`, [acmeProject]);
    await t.ctx.db.query(`UPDATE recommendations SET proposed_value = 'https://x/', confidence = 'high', status = 'pending_approval' WHERE project_id = $1 AND risk = 'high'`, [acmeProject]);
    const run = await json(t.app, 'POST', `/api/projects/${acmeProject}/jobs/autopilot?wait=true`, { apiKey: SERVICE, body: {} });
    expect(run.body.status, run.body.error).toBe('succeeded');
    expect(run.body.output.approved).toBeGreaterThanOrEqual(1);
    const approvals = await t.ctx.db.query<any>(`SELECT r.risk FROM approvals a JOIN recommendations r ON r.id = a.recommendation_id WHERE a.project_id = $1 AND a.reviewer_label = 'Autopilot (level 3)'`, [acmeProject]);
    expect(approvals.every((a: any) => a.risk === 'low')).toBe(true);
    expect(await t.ctx.db.one(`SELECT 1 FROM approvals a JOIN recommendations r ON r.id = a.recommendation_id WHERE a.project_id = $1 AND r.risk = 'high' AND a.decision = 'approved'`, [acmeProject])).toBeNull();
  });
});

describe('AI cost control', () => {
  it('reports each organization’s monthly AI spend against its plan budget', async () => {
    await t.ctx.db.query(`INSERT INTO ai_usage(project_id, provider, model, prompt_name, input_tokens, output_tokens, cached, estimated_cost_usd, duration_ms, success) VALUES ($1,'claude','m','x',1,1,false,50,1,true)`, [acmeProject]);
    const b = await dbAIStore(t.ctx.db).tenantBudget!(acmeProject);
    expect(b).toMatchObject({ limitUsd: 40, planName: 'Growth' });
    expect(b!.spentUsd).toBeGreaterThanOrEqual(50);
  });
});
