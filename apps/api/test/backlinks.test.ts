import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, testApp } from './helpers.js';
import { startFixtureSite } from '../../../tests/fixtures/site.js';
import { createProject } from '../src/services/projects.js';
import { syncBacklinks } from '../src/services/backlinks.js';

/**
 * Two local sites: "our" fixture site and a referring site that links to it.
 * The referring site's routes are mutable so we can remove a link between checks.
 */
let t: Awaited<ReturnType<typeof testApp>>;
let ours: Awaited<ReturnType<typeof startFixtureSite>>;
let referrer: Awaited<ReturnType<typeof startFixtureSite>>;
let projectId: string;
let admin: string;
const SERVICE = 'test-service-key-123456';
const refRoutes: Record<string, { status: number; body?: string }> = {};
const page = (body: string) => `<!DOCTYPE html><html><head><title>Referrer</title></head><body>${body}</body></html>`;

beforeAll(async () => {
  ours = await startFixtureSite();
  referrer = await startFixtureSite(refRoutes);
  const o = ours.origin;
  Object.assign(refRoutes, {
    '/live': { status: 200, body: page(`<p>Great <a href="${o}/web-design">web design team</a> in Coimbatore.</p>`) },
    '/nofollow': { status: 200, body: page(`<a rel="nofollow ugc" href="${o}/">Example IT</a>`) },
    '/to-broken': { status: 200, body: page(`<a href="${o}/gone">their old guide</a>`) },
    '/via-redirect': { status: 200, body: page(`<a href="${o}/web-design">design</a>`) },
    '/no-link': { status: 200, body: page('<p>Nothing here.</p>') },
    '/deleted': { status: 404, body: 'gone' },
  });
  t = await testApp({ BACKLINK_ALLOW_PRIVATE_HOSTS: true });
  projectId = (await createProject(t.ctx, { name: 'Backlinks', siteUrl: o + '/' })).id;
  admin = (await json(t.app, 'POST', '/api/auth/setup', { body: { email: 'admin@phoenixxit.com', name: 'Admin', password: 'correct horse battery' } })).body.token;
  expect((await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl?wait=true`, { apiKey: SERVICE, body: {} })).body.status).toBe('succeeded');
});
afterAll(async () => {
  await t.close();
  await ours.close();
  await referrer.close();
});

describe('backlink monitoring', () => {
  it('imports a CSV export (editors only) and explains skipped rows', async () => {
    const r = referrer.origin.replace('127.0.0.1', 'localhost'); // same host as ours otherwise – sites are compared by hostname
    const o = ours.origin;
    const csv = [
      'Linking page,Target page,Anchor',
      `${r}/live,${o}/web-design,web design team`,
      `${r}/nofollow,,`,
      `${r}/to-broken,${o}/gone,old guide`,
      `${r}/via-redirect,${o}/old-page,design`,
      `${r}/no-link,${o}/,`,
      `${r}/deleted,${o}/,`,
      `${o}/seo-services,${o}/,internal`,
    ].join('\n');
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/backlinks/import`, { apiKey: SERVICE, body: { csv } })).status).toBe(403);
    const imp = await json(t.app, 'POST', `/api/projects/${projectId}/backlinks/import`, { token: admin, body: { csv, fileName: 'links.csv' } });
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ inserted: 6, updated: 0, skipped: 1 });
    const again = await json(t.app, 'POST', `/api/projects/${projectId}/backlinks/import`, { token: admin, body: { csv } });
    expect(again.body).toMatchObject({ inserted: 0, updated: 6 });
    const bad = await json(t.app, 'POST', `/api/projects/${projectId}/backlinks/import`, { token: admin, body: { csv: 'Keyword,Clicks\nfoo,1' } });
    expect(bad.status).toBe(400);
  });

  it('verifies links live, follows target redirects and recommends a 301 for links to broken pages', async () => {
    const v = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/backlinks-verify?wait=true`, { apiKey: SERVICE, body: {} });
    expect(v.body.status, v.body.error).toBe('succeeded');
    expect(v.body.output).toMatchObject({ checked: 6, live: 4, lost: 2, newlyLost: 0, brokenTargets: 1, recommendations: 1 });

    const ov = await json(t.app, 'GET', `/api/projects/${projectId}/backlinks`, { token: admin });
    const by = (p: string) => ov.body.backlinks.find((b: any) => b.source_url.endsWith(p));
    expect(by('/live')).toMatchObject({ status: 'live', found_anchor: 'web design team', found_nofollow: false, target_status: 200 });
    expect(by('/nofollow')).toMatchObject({ status: 'live', found_nofollow: true, target_status: 200 });
    expect(by('/via-redirect')).toMatchObject({ status: 'live' }); // links to /web-design, which /old-page redirects to
    expect(by('/to-broken')).toMatchObject({ status: 'live', target_status: 404 });
    expect(by('/no-link')).toMatchObject({ status: 'lost' });
    expect(by('/deleted')).toMatchObject({ status: 'lost', check_error: 'Linking page returned HTTP 404' });
    expect(ov.body.summary).toMatchObject({ backlinks: 6, referringDomains: 1, live: 4, lost: 2, nofollow: 1 });
    expect(ov.body.brokenTargets).toEqual([expect.objectContaining({ status: 404, links: 1 })]);

    const recs = await json(t.app, 'GET', `/api/projects/${projectId}/recommendations?status=all&limit=200`, { token: admin });
    const rec = recs.body.items.find((x: any) => x.source === 'backlinks');
    expect(rec).toMatchObject({ type: 'redirect', risk: 'high', status: 'pending_approval', current_value: '/gone' });
    expect(rec.proposed_value).toMatch(/^Redirect 301 \/gone \//);
  });

  it('alerts when a live link disappears', async () => {
    refRoutes['/live'] = { status: 200, body: page('<p>We removed the link.</p>') };
    const v = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/backlinks-verify?wait=true`, { apiKey: SERVICE, body: {} });
    expect(v.body.output).toMatchObject({ newlyLost: 1 });
    const alerts = await json(t.app, 'GET', `/api/projects/${projectId}/alerts`, { token: admin });
    expect(alerts.body.find((a: any) => a.type === 'backlinks_lost')).toMatchObject({ severity: 'medium', title: expect.stringMatching(/1 backlink\(s\) lost/) });
  });

  it('sync is a no-op without a provider and stores provider links when one is configured', async () => {
    const none = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/backlinks-sync?wait=true`, { apiKey: SERVICE, body: {} });
    expect(none.body.output).toMatchObject({ provider: 'none', skipped: true });
    const fake = { name: 'dataforseo', fetchBacklinks: async () => [{ sourceUrl: 'https://news.example.com/story', targetUrl: ours.origin + '/seo-services', anchor: 'SEO', nofollow: false, firstSeen: null, lastSeen: null, lost: false }] };
    expect(await syncBacklinks(t.ctx, projectId, {}, fake)).toMatchObject({ provider: 'dataforseo', fetched: 1, inserted: 1 });
  });
});

describe('linking pages on private networks are refused', () => {
  it('marks them as check errors, never as lost', async () => {
    const strict = await testApp();
    try {
      const pid = (await createProject(strict.ctx, { name: 'Strict', siteUrl: 'https://www.phoenixxit.com/' })).id;
      await strict.ctx.db.query(`INSERT INTO backlinks(project_id, source_url, source_domain, target_url) VALUES ($1, 'http://127.0.0.1:9/admin', '127.0.0.1', ''), ($1, 'http://localhost/x', 'localhost', '')`, [pid]);
      const v = await json(strict.app, 'POST', `/api/projects/${pid}/jobs/backlinks-verify?wait=true`, { apiKey: SERVICE, body: {} });
      expect(v.body.output).toMatchObject({ checked: 2, errors: 2, lost: 0 });
      const rows = await strict.ctx.db.query<{ status: string; check_error: string }>('SELECT status, check_error FROM backlinks WHERE project_id = $1', [pid]);
      expect(rows.every((r) => r.status === 'error' && /Private/.test(r.check_error))).toBe(true);
    } finally {
      await strict.close();
    }
  });
});
