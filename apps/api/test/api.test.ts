import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { bulkInsert } from '@phoenixx/database';
import { addDays, isoDate } from '@phoenixx/shared';
import { json, testApp } from './helpers.js';
import { startFixtureSite } from '../../../tests/fixtures/site.js';
import { createProject } from '../src/services/projects.js';
import { sampleSearchConsoleRows } from '../src/demo/seed.js';

let t: Awaited<ReturnType<typeof testApp>>;
let site: Awaited<ReturnType<typeof startFixtureSite>>;
let admin: string;
let editor: string;
let viewer: string;
let projectId: string;
const SERVICE = 'test-service-key-123456';

beforeAll(async () => {
  site = await startFixtureSite();
  t = await testApp();
  projectId = (await createProject(t.ctx, { name: 'Fixture', siteUrl: site.origin + '/' })).id;
});
afterAll(async () => {
  await t.close();
  await site.close();
});

describe('health & system', () => {
  it('serves health/ready and system status', async () => {
    expect((await json(t.app, 'GET', '/health')).status).toBe(200);
    expect((await json(t.app, 'GET', '/ready')).body.db).toBe('pglite');
    const s = await json(t.app, 'GET', '/api/system/status');
    expect(s.body.needsSetup).toBe(true);
    expect(s.body.ai.provider).toBe('mock');
  });
});

describe('authentication & roles', () => {
  it('creates the first admin once, then refuses setup', async () => {
    const r = await json(t.app, 'POST', '/api/auth/setup', { body: { email: 'admin@phoenixxit.com', name: 'Admin', password: 'correct horse battery' } });
    expect(r.status).toBe(200);
    admin = r.body.token;
    expect((await json(t.app, 'POST', '/api/auth/setup', { body: { email: 'x@y.com', name: 'X', password: 'another password 1' } })).status).toBe(409);
  });
  it('logs in, rejects bad credentials, validates input', async () => {
    expect((await json(t.app, 'POST', '/api/auth/login', { body: { email: 'admin@phoenixxit.com', password: 'nope' } })).status).toBe(401);
    expect((await json(t.app, 'POST', '/api/auth/login', { body: { email: 'not-an-email', password: 'x' } })).body.error.code).toBe('validation');
    const ok = await json(t.app, 'POST', '/api/auth/login', { body: { email: 'ADMIN@phoenixxit.com', password: 'correct horse battery' } });
    expect(ok.status).toBe(200);
    expect((await json(t.app, 'GET', '/api/auth/me', { token: ok.body.token })).body.user.role).toBe('admin');
  });
  it('requires auth for project data and rejects forged tokens', async () => {
    expect((await json(t.app, 'GET', `/api/projects/${projectId}/overview`)).status).toBe(401);
    expect((await json(t.app, 'GET', `/api/projects/${projectId}/overview`, { token: admin + 'x' })).status).toBe(401);
    expect((await json(t.app, 'GET', `/api/projects/${projectId}/overview`, { apiKey: 'wrong' })).status).toBe(401);
  });
  it('admin can create editor/viewer users', async () => {
    for (const role of ['editor', 'viewer'] as const) {
      const c = await json(t.app, 'POST', '/api/auth/users', { token: admin, body: { email: `${role}@phoenixxit.com`, name: role, password: 'password-long-enough', role, projects: [{ projectId, role }] } });
      expect(c.status).toBe(200);
      const l = await json(t.app, 'POST', '/api/auth/login', { body: { email: `${role}@phoenixxit.com`, password: 'password-long-enough' } });
      if (role === 'editor') editor = l.body.token;
      else viewer = l.body.token;
    }
    expect((await json(t.app, 'POST', '/api/auth/users', { token: editor, body: { email: 'z@z.com', name: 'z', password: 'password-long-enough' } })).status).toBe(403);
  });
  it('demo login is disabled outside demo mode', async () => {
    expect((await json(t.app, 'POST', '/api/auth/demo-login')).status).toBe(404);
  });
});

describe('crawl job via service API key (n8n path)', () => {
  it('rejects unknown jobs and runs a synchronous crawl', async () => {
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/jobs/nope?wait=true`, { apiKey: SERVICE })).status).toBe(404);
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl?wait=true`, { apiKey: SERVICE, body: {} });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('succeeded');
    expect(r.body.output.pagesCrawled).toBeGreaterThan(5);
    expect(r.body.correlationId).toBeTruthy();
    const jobs = await json(t.app, 'GET', `/api/projects/${projectId}/jobs`, { token: viewer });
    expect(jobs.body[0].status).toBe('succeeded');
    expect(jobs.body[0].trigger).toBe('n8n');
  });
  it('viewers cannot run jobs', async () => {
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl`, { token: viewer })).status).toBe(403);
  });
  it('stores issues with filters and CSV export', async () => {
    const all = await json(t.app, 'GET', `/api/projects/${projectId}/issues?limit=500`, { token: viewer });
    expect(all.body.items.length).toBeGreaterThan(10);
    const high = await json(t.app, 'GET', `/api/projects/${projectId}/issues?severity=high,critical`, { token: viewer });
    expect(high.body.items.every((i: any) => ['high', 'critical'].includes(i.severity))).toBe(true);
    const h1 = await json(t.app, 'GET', `/api/projects/${projectId}/issues?rule=missing_h1`, { token: viewer });
    expect(h1.body.items[0].recommendation_id).toBeTruthy();
    const csv = await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/issues?format=csv`, headers: { authorization: `Bearer ${viewer}` } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[0]).toContain('severity');
  });
  it('re-crawling resolves fixed issues and keeps fingerprints stable', async () => {
    const before = await json(t.app, 'GET', `/api/projects/${projectId}/issues?limit=500`, { token: viewer });
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl?wait=true`, { token: editor, body: {} });
    expect(r.body.output.resolvedIssues).toBe(0);
    const after = await json(t.app, 'GET', `/api/projects/${projectId}/issues?limit=500`, { token: viewer });
    expect(after.body.items.length).toBe(before.body.items.length);
  });
});

describe('approval workflow & change management', () => {
  let recId: string;
  it('lists the approval queue with WHAT/WHY/EVIDENCE/RISK', async () => {
    const q = await json(t.app, 'GET', `/api/projects/${projectId}/approvals`, { token: viewer });
    expect(q.body.total).toBeGreaterThan(0);
    const r = q.body.recommendations[0];
    for (const k of ['what', 'why', 'evidence', 'risk', 'expected_purpose', 'priority', 'score_breakdown']) expect(r).toHaveProperty(k);
  });
  it('viewers cannot approve; editors cannot approve high-risk items', async () => {
    const recs = await json(t.app, 'GET', `/api/projects/${projectId}/recommendations?status=all&limit=500`, { token: viewer });
    const low = recs.body.items.find((r: any) => r.type === 'h1' && r.proposed_value);
    recId = low.id;
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${recId}/decision`, { token: viewer, body: { decision: 'approve' } })).status).toBe(403);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${recId}/decision`, { apiKey: SERVICE, body: { decision: 'approve' } })).status).toBe(403);
    const high = recs.body.items.find((r: any) => r.risk === 'high');
    expect(high).toBeTruthy();
    const d = await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${high.id}/decision`, { token: editor, body: { decision: 'approve' } });
    expect(d.status).toBe(403);
    expect(d.body.error.message).toMatch(/admin/i);
  });
  it('editor approves with an edit → change record with old/new values and reviewer', async () => {
    const d = await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${recId}/decision`, { token: editor, body: { decision: 'approve', editedValue: 'Website Design Services', comment: 'Tweaked wording' } });
    expect(d.status).toBe(200);
    expect(d.body.changeId).toBeTruthy();
    const c = await json(t.app, 'GET', `/api/projects/${projectId}/changes/${d.body.changeId}`, { token: viewer });
    expect(c.body.new_value).toBe('Website Design Services');
    expect(c.body.reviewer_email).toBe('editor@phoenixxit.com');
    expect(c.body.events[0].to_status).toBe('approved');
    // cannot decide twice
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${recId}/decision`, { token: editor, body: { decision: 'reject' } })).status).toBe(409);
    // approvals audit trail
    const q = await json(t.app, 'GET', `/api/projects/${projectId}/approvals`, { token: viewer });
    expect(q.body.recentDecisions.map((r: any) => r.decision)).toEqual(expect.arrayContaining(['edited', 'approved']));
  });
  it('implementation exports files (manual adapter), verification detects not-live, rollback is admin-only', async () => {
    const changes = await json(t.app, 'GET', `/api/projects/${projectId}/changes`, { token: viewer });
    const id = changes.body[0].id;
    const imp = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/implement`, { token: editor });
    expect(imp.body.ok).toBe(true);
    expect(imp.body.applied).toBe(false);
    expect(existsSync(path.join(t.exportDir, id, 'apply.md'))).toBe(true);
    const v = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/verify`, { token: editor });
    expect(v.body.verified).toBe(false);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/rollback`, { token: editor })).status).toBe(403);
    const rb = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/rollback`, { token: admin, body: { reason: 'test' } });
    expect(rb.body.ok).toBe(true);
    expect(readdirSync(path.join(t.exportDir, id))).toContain('rollback.md');
    const md = await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/changes/${id}?format=md`, headers: { authorization: `Bearer ${viewer}` } });
    expect(md.body).toContain('rolled_back');
    const log = await json(t.app, 'GET', `/api/projects/${projectId}/changelog`, { token: viewer });
    expect(log.body.some((e: any) => e.changeId === id)).toBe(true);
  });
  it('audit log records sensitive actions', async () => {
    const a = await json(t.app, 'GET', `/api/projects/${projectId}/audit-logs`, { token: viewer });
    const actions = a.body.map((x: any) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['recommendation.approved', 'change.implement', 'change.rollback', 'auth.login', 'user.create']));
  });
});

describe('search data driven features', () => {
  beforeAll(async () => {
    const end = isoDate(addDays(new Date(), -3));
    const rows = sampleSearchConsoleRows(projectId, end, 120).map((r) => ({ ...r, page: typeof r.page === 'string' && r.page ? String(r.page).replace('https://www.phoenixxit.com', site.origin) : r.page }));
    await bulkInsert(t.ctx.db, 'search_console_data', rows, { chunkSize: 1000 });
  });
  it('keyword discovery classifies, scores and clusters (no fabricated volume)', async () => {
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/keywords?wait=true`, { apiKey: SERVICE, body: {} });
    expect(r.body.status).toBe('succeeded');
    expect(r.body.output.clusters).toBeGreaterThan(3);
    const k = await json(t.app, 'GET', `/api/projects/${projectId}/keywords?intent=local&limit=200`, { token: viewer });
    expect(k.body.items.length).toBeGreaterThan(5);
    expect(k.body.items.every((i: any) => i.search_volume === null && i.search_volume_source === 'unavailable')).toBe(true);
    const filtered = await json(t.app, 'GET', `/api/projects/${projectId}/keywords?minPos=4&maxPos=20&service=digital-marketing`, { token: viewer });
    expect(filtered.body.items.every((i: any) => i.position >= 4 && i.position <= 20 && i.services.includes('digital-marketing'))).toBe(true);
    const clusters = await json(t.app, 'GET', `/api/projects/${projectId}/keyword-clusters`, { token: viewer });
    expect(clusters.body.some((c: any) => c.cannibalization.length >= 2)).toBe(true);
  });
  it('overview & performance compute KPIs and trends', async () => {
    const o = await json(t.app, 'GET', `/api/projects/${projectId}/overview`, { token: viewer });
    expect(o.body.kpis.clicks[0]).toBeGreaterThan(0);
    expect(o.body.series.length).toBe(90);
    expect(o.body.rankingDistribution).toHaveLength(5);
    const p = await json(t.app, 'GET', `/api/projects/${projectId}/performance?days=28`, { token: viewer });
    expect(p.body.windows.map((w: any) => w.days)).toEqual([7, 28, 90]);
    expect(p.body.decliningQueries.length + p.body.risingQueries.length).toBeGreaterThan(0);
  });
  it('content, local, internal links jobs and weekly report', async () => {
    for (const job of ['content-opportunities', 'local-seo', 'internal-links', 'weekly-report', 'initial-report']) {
      const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/${job}?wait=true`, { apiKey: SERVICE, body: { send: false } });
      expect(r.body.status, `${job}: ${r.body.error}`).toBe('succeeded');
    }
    const rep = await json(t.app, 'GET', `/api/projects/${projectId}/reports`, { token: viewer });
    const weekly = rep.body.find((r: any) => r.type === 'weekly');
    const html = await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/reports/${weekly.id}?format=html`, headers: { authorization: `Bearer ${viewer}` } });
    expect(html.body).toContain('Executive summary');
    expect(html.body).toContain('not a Google metric');
    const content = await json(t.app, 'GET', `/api/projects/${projectId}/content`, { token: viewer });
    expect(content.body.opportunities.length).toBeGreaterThan(0);
  });
  it('content brief → approval → draft → quality gate', async () => {
    const content = await json(t.app, 'GET', `/api/projects/${projectId}/content`, { token: viewer });
    const opp = content.body.opportunities[0];
    const b = await json(t.app, 'POST', `/api/projects/${projectId}/content/opportunities/${opp.id}/brief`, { token: editor });
    expect(b.status).toBe(200);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/content/briefs/${b.body.briefId}/draft`, { token: editor })).status).toBe(409); // must approve brief first
    await json(t.app, 'POST', `/api/projects/${projectId}/content/briefs/${b.body.briefId}/decision`, { token: editor, body: { decision: 'approve' } });
    const d = await json(t.app, 'POST', `/api/projects/${projectId}/content/briefs/${b.body.briefId}/draft`, { token: editor });
    expect(d.status).toBe(200);
    expect(d.body.quality.checks.length).toBeGreaterThan(8);
    expect(d.body.quality.verdict).not.toBe('ready_for_review'); // mock draft contains [NEEDS INPUT] placeholders
    const approve = await json(t.app, 'POST', `/api/projects/${projectId}/content/drafts/${d.body.draftId}/decision`, { token: editor, body: { decision: 'approve' } });
    expect(approve.status).toBe(409);
    expect(approve.body.error.code).toBe('placeholders');
  });
  it('AI usage is tracked', async () => {
    const u = await json(t.app, 'GET', `/api/projects/${projectId}/ai-usage`, { token: viewer });
    expect(u.body.totals.calls).toBeGreaterThan(0);
  });
});

describe('settings & competitors validation', () => {
  it('validates settings and applies rule overrides on the next crawl', async () => {
    expect((await json(t.app, 'PATCH', `/api/projects/${projectId}`, { token: admin, body: { settings: { ga4PropertyId: 'G-7Z9VDR6JRF' } } })).status).toBe(400);
    expect((await json(t.app, 'PATCH', `/api/projects/${projectId}`, { token: editor, body: { settings: {} } })).status).toBe(403);
    const ok = await json(t.app, 'PATCH', `/api/projects/${projectId}`, { token: admin, body: { settings: { rules: { multiple_h1: { enabled: false } } } } });
    expect(ok.status).toBe(200);
    await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl?wait=true`, { token: admin, body: {} });
    const issues = await json(t.app, 'GET', `/api/projects/${projectId}/issues?rule=multiple_h1`, { token: viewer });
    expect(issues.body.items).toHaveLength(0);
  });
  it('rejects invalid competitor URLs and accepts valid ones', async () => {
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/competitors`, { token: editor, body: { name: 'x', baseUrl: 'ftp://nope' } })).status).toBe(400);
    const c = await json(t.app, 'POST', `/api/projects/${projectId}/competitors`, { token: editor, body: { name: 'Fixture competitor', baseUrl: site.origin + '/web-design' } });
    expect(c.body.base_url).toBe(site.origin + '/');
  });
  it('returns 404 for unknown projects and 400 for malformed ids', async () => {
    expect((await json(t.app, 'GET', `/api/projects/00000000-0000-0000-0000-000000000000/overview`, { token: viewer })).status).toBe(404);
    expect((await json(t.app, 'GET', `/api/projects/not-a-uuid/overview`, { token: viewer })).status).toBe(400);
  });
});

describe('regressions', () => {
  it('a stale/invalid token does not block public endpoints (login, status)', async () => {
    const bad = 'Bearer not.a.valid-token';
    const s = await t.app.inject({ method: 'GET', url: '/api/system/status', headers: { authorization: bad } });
    expect(s.statusCode).toBe(200);
    const l = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { authorization: bad, 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'admin@phoenixxit.com', password: 'correct horse battery' }) });
    expect(l.statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/overview`, headers: { authorization: bad } })).statusCode).toBe(401);
  });

  it('instruction-only changes export instructions and need human confirmation', async () => {
    const recs = await json(t.app, 'GET', `/api/projects/${projectId}/recommendations?status=recommended,pending_approval&limit=500`, { token: viewer });
    const rec = recs.body.items.find((r: any) => !r.proposed_value && r.risk !== 'high' && r.page_url);
    expect(rec).toBeTruthy();
    const d = await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${rec.id}/decision`, { token: editor, body: { decision: 'approve' } });
    const imp = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${d.body.changeId}/implement`, { token: editor });
    expect(imp.body.ok).toBe(true);
    expect(imp.body.adapter).toBe('manual');
    const auto = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${d.body.changeId}/verify`, { token: editor, body: {} });
    expect(auto.body.verified).toBe(false);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/changes/${d.body.changeId}/verify`, { apiKey: SERVICE, body: { manualConfirm: true } })).status).toBe(403);
    const ok = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${d.body.changeId}/verify`, { token: editor, body: { manualConfirm: true, note: 'Deployed by dev' } });
    expect(ok.body.verified).toBe(true);
  });

  it('page detail lists issues by severity rank', async () => {
    const pages = await json(t.app, 'GET', `/api/projects/${projectId}/pages`, { token: viewer });
    const p = pages.body.find((x: any) => x.open_issues > 2);
    const d = await json(t.app, 'GET', `/api/projects/${projectId}/pages/${p.id}`, { token: viewer });
    const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    const r = d.body.issues.map((i: any) => rank[i.severity]);
    expect(r).toEqual([...r].sort((a, b) => a - b));
  });
});
