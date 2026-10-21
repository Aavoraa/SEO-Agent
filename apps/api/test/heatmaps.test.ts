import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as cheerio from 'cheerio';
import { json, testApp } from './helpers.js';
import { startFixtureSite } from '../../../tests/fixtures/site.js';
import { parseClarity, sanitizeSnapshot, syncClarity } from '../src/services/heatmaps.js';
import { cssPath, prepareDemoHtml } from '../src/demo/heatmaps.js';

/**
 * Heatmaps: hm.js tracker → /api/collect (site key + origin check) → click/scroll aggregation →
 * script-free page snapshot → Microsoft Clarity Data Export (encrypted token, daily limit).
 */
let t: Awaited<ReturnType<typeof testApp>>;
let site: Awaited<ReturnType<typeof startFixtureSite>>;
let owner: string;
let other: string;
let pid: string;
let key: string;

const beacon = (body: unknown, origin?: string) =>
  t.app.inject({ method: 'POST', url: '/api/collect', headers: { 'content-type': 'text/plain;charset=UTF-8', ...(origin ? { origin } : {}) }, payload: JSON.stringify(body) });

const view = (over: Record<string, unknown> = {}) => ({ k: key, v: 'view0001aa', p: '/', t: 'Home page', d: 'desktop', vw: 1440, vh: 900, h: 4000, s: 0.4, e: [], ...over });
const click = (over: Record<string, unknown> = {}) => ({ sel: 'body>nav:nth-of-type(1)>a:nth-of-type(2)', l: 'Web Design', rx: 0.5, ry: 0.5, x: 0.3, y: 20, h: 4000, r: false, dd: false, ...over });

beforeAll(async () => {
  site = await startFixtureSite();
  t = await testApp({ OUTBOUND_ALLOW_PRIVATE_HOSTS: true, WEBHOOK_ALLOW_PRIVATE_HOSTS: true } as never);
  await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'root@hm.example', name: 'Root', password: 'correct horse battery', organizationName: 'Ops' } });
  const a = await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'owner@hm.example', name: 'Owner', password: 'correct horse battery', organizationName: 'Heat Co' } });
  owner = a.body.token;
  const p = await json(t.app, 'POST', '/api/onboarding/projects', { token: owner, body: { organizationId: a.body.organization.id, url: site.origin } });
  expect(p.status).toBe(200);
  pid = p.body.project.id;
  const b = await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'other@hm.example', name: 'Other', password: 'correct horse battery', organizationName: 'Other Co' } });
  other = b.body.token;
});
afterAll(async () => {
  await t.close();
  await site.close();
});

describe('tracker & collection', () => {
  it('serves hm.js cross-origin and gives each project a public site key + snippet', async () => {
    const js = await t.app.inject({ method: 'GET', url: '/hm.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toContain('javascript');
    expect(js.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(js.body).toContain('/api/collect');
    expect(js.body).toContain('doNotTrack');
    const s = await json(t.app, 'GET', `/api/projects/${pid}/heatmaps/setup`, { token: owner });
    expect(s.body.siteKey).toMatch(/^hm_[0-9a-f]{24}$/);
    expect(s.body.snippet).toContain(`data-key="${s.body.siteKey}"`);
    key = s.body.siteKey;
    // stable
    expect((await json(t.app, 'GET', `/api/projects/${pid}/heatmaps/setup`, { token: owner })).body.siteKey).toBe(key);
  });

  it('accepts beacons only from the project website origin', async () => {
    expect((await beacon(view(), site.origin)).statusCode).toBe(204);
    expect((await beacon(view(), 'https://evil.example')).statusCode).toBe(403);
    expect((await beacon(view())).statusCode).toBe(403);
    expect((await beacon(view({ k: 'hm_000000000000000000000000' }), site.origin)).statusCode).toBe(404);
    expect((await beacon({ ...view(), s: 7 }, site.origin)).statusCode).toBe(400);
    expect((await beacon({ ...view(), e: Array.from({ length: 101 }, () => click()) }, site.origin)).statusCode).toBe(400);
  });

  it('keeps one row per page view with its deepest scroll, and stores clicks', async () => {
    await beacon(view({ s: 0.3, e: [click(), click({ r: true }), click({ sel: 'body>h2:nth-of-type(1)', l: null, dd: true })] }), site.origin);
    await beacon(view({ s: 0.8 }), site.origin);
    await beacon(view({ v: 'view0002bb', d: 'mobile', vw: 390, s: 1, p: '/index.html', e: [click()] }), site.origin);
    const pages = await json(t.app, 'GET', `/api/projects/${pid}/heatmaps/pages?days=1`, { token: owner });
    expect(pages.status).toBe(200);
    const home = pages.body.items.find((x: any) => x.path === '/');
    expect(home).toMatchObject({ views: 2, clicks: 4, rageClicks: 1, deadClicks: 1, title: 'Home page' });
    expect(home.avgScrollDepth).toBeCloseTo(0.9, 5);
    expect(pages.body.dataLabel).toBe('verified');
  });

  it('aggregates click points, top elements and scroll reach per page and device', async () => {
    const h = await json(t.app, 'GET', `/api/projects/${pid}/heatmaps?path=/&days=1`, { token: owner });
    expect(h.body.totals).toMatchObject({ views: 2, clicks: 4, rageClicks: 1, deadClicks: 1 });
    expect(h.body.elements[0]).toMatchObject({ label: 'Web Design', clicks: 3 });
    expect(h.body.elements[0].share).toBeCloseTo(0.75);
    expect(h.body.points.reduce((a: number, p: any) => a + p.n, 0)).toBe(4);
    expect(h.body.scroll).toHaveLength(21);
    expect(h.body.scroll[0].reach).toBe(1);
    expect(h.body.scroll.find((r: any) => r.depth === 0.9).reach).toBe(0.5);
    const mobile = await json(t.app, 'GET', `/api/projects/${pid}/heatmaps?path=https://x.example/&days=1&device=mobile`, { token: owner });
    expect(mobile.body.totals).toMatchObject({ views: 1, clicks: 1 });
  });

  it("hides one tenant's heatmaps from another", async () => {
    for (const url of [`/api/projects/${pid}/heatmaps/pages`, `/api/projects/${pid}/heatmaps?path=/`, `/api/projects/${pid}/heatmaps/setup`, `/api/projects/${pid}/heatmaps/snapshot?path=/`]) {
      expect((await json(t.app, 'GET', url, { token: other })).status).toBe(404);
    }
  });
});

describe('page snapshot', () => {
  it('returns the page without scripts, with a <base> for its assets', async () => {
    const s = await json(t.app, 'GET', `/api/projects/${pid}/heatmaps/snapshot?path=/`, { token: owner });
    expect(s.status).toBe(200);
    expect(s.body.html).not.toMatch(/<script/i);
    expect(s.body.html).toContain(`<base href="${site.origin}/">`);
    expect(s.body.html).toContain('IT and Digital Services in Coimbatore');
  });

  it('strips every way of running code', () => {
    const html = sanitizeSnapshot(
      `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><script>alert(1)</script></head><body onload="x()"><img src="a.png" onerror="alert(1)"><a href="javascript:alert(1)">x</a><iframe src="https://evil.example"></iframe><form action="/login"><button formaction="javascript:y()">b</button></form><noscript>enable js</noscript><div id="preloader">loading</div></body></html>`,
      'https://site.example/page',
    );
    const $ = cheerio.load(html);
    expect($('script, iframe, noscript, meta[http-equiv]').length).toBe(0);
    expect(html).not.toMatch(/onerror|onload|javascript:/i);
    expect($('form').attr('action')).toBe('#');
    expect($('base').attr('href')).toBe('https://site.example/page');
    expect(html).toContain('[id*="preloader" i]');
  });
});

describe('Microsoft Clarity', () => {
  const payload = [
    { metricName: 'Traffic', information: [{ totalSessionCount: '386', totalBotSessionCount: '12', distantUserCount: '300', PagesPerSessionPercentage: 1.2, URL: 'https://www.phoenixxit.com/' }, { totalSessionCount: '10', URL: 'https://www.phoenixxit.com/#services' }] },
    { metricName: 'ScrollDepth', information: [{ averageScrollDepth: 41.5, URL: 'https://www.phoenixxit.com/' }] },
    { metricName: 'DeadClickCount', information: [{ sessionsCount: '7', sessionsWithMetricPercentage: 1.8, subTotal: '9', URL: 'https://www.phoenixxit.com/' }] },
    { metricName: 'RageClickCount', information: [{ sessionsCount: '2', subTotal: '3', URL: 'https://www.phoenixxit.com/' }] },
  ];

  it('turns the Data Export response into one row per URL', () => {
    const pages = parseClarity(payload);
    expect(pages[0]).toMatchObject({ url: 'https://www.phoenixxit.com/', path: '/', sessions: 386, scrollDepth: 41.5, deadClicks: 9, rageClicks: 3 });
    expect(pages[1]).toMatchObject({ path: '/#services', sessions: 10, scrollDepth: null });
  });

  it('stores the token encrypted, never returns it, syncs and respects the daily limit', async () => {
    const token = 'clarity-token-abcdefghijklmnopqrstuvwxyz';
    expect((await json(t.app, 'PUT' as never, `/api/projects/${pid}/heatmaps/clarity`, { token: owner, body: { clarityProjectId: 'bad id!' } })).status).toBe(400);
    const saved = await json(t.app, 'PUT' as never, `/api/projects/${pid}/heatmaps/clarity`, { token: owner, body: { clarityProjectId: 'yj3dehirsu', apiToken: token } });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ connected: true, clarityProjectId: 'yj3dehirsu' });
    expect(saved.body.dashboardUrl).toContain('/projects/view/yj3dehirsu/heatmaps');
    expect(JSON.stringify(saved.body)).not.toContain(token);
    const row = await t.ctx.db.one<{ secret_encrypted: string }>(`SELECT secret_encrypted FROM integrations WHERE project_id = $1 AND provider = 'microsoft_clarity'`, [pid]);
    expect(row!.secret_encrypted).not.toContain(token);

    let seen: { url: string; auth: string } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen = { url, auth: (init.headers as Record<string, string>).authorization };
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const r = await syncClarity(t.ctx, pid, { numOfDays: 3, fetchImpl: fakeFetch });
    expect(r).toMatchObject({ metrics: 4, pages: 2 });
    expect(seen!.url).toBe('https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=3&dimension1=URL');
    expect(seen!.auth).toBe(`Bearer ${token}`);
    const pages = await json(t.app, 'GET', `/api/projects/${pid}/heatmaps/pages?days=1`, { token: owner });
    expect(pages.body.clarity.pages[0]).toMatchObject({ sessions: 386 });

    // an expired token is reported, not retried
    const denied = (async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(syncClarity(t.ctx, pid, { fetchImpl: denied })).rejects.toThrow(/invalid or expired/);
    expect((await json(t.app, 'GET', `/api/projects/${pid}/heatmaps/setup`, { token: owner })).body.clarity).toMatchObject({ status: 'error' });

    for (let i = 0; i < 9; i++) await t.ctx.db.query(`INSERT INTO clarity_snapshots(project_id, num_days, dimension, payload) VALUES ($1, 1, 'URL', '[]')`, [pid]);
    await expect(syncClarity(t.ctx, pid, { fetchImpl: fakeFetch })).rejects.toThrow(/10 Data Export calls/);
  });

  it('another tenant cannot change the Clarity connection', async () => {
    expect((await json(t.app, 'PUT' as never, `/api/projects/${pid}/heatmaps/clarity`, { token: other, body: { clarityProjectId: 'abcdefgh' } })).status).toBe(404);
  });
});

describe('demo helpers', () => {
  it('builds the same element path as the tracker', () => {
    const $ = cheerio.load('<html><body><nav id="navbar"><div></div><div><a>1</a><a>2</a></div></nav><main><section><p>x</p><a>y</a></section></main></body></html>');
    expect(cssPath($, $('#navbar a').eq(1))).toBe('#navbar>div:nth-of-type(2)>a:nth-of-type(2)');
    expect(cssPath($, $('main a'))).toBe('body>main:nth-of-type(1)>section:nth-of-type(1)>a:nth-of-type(1)');
  });

  it('adds the tracker to the demo copy and removes the real site analytics tags', () => {
    const out = prepareDemoHtml('<html><body><p>x</p><script async src="https://www.clarity.ms/tag/abc"></script><script>(function(c,l,a,r,i,t,y){t=l.createElement(r);t.src="https://www.clarity.ms/tag/"+i;})(window,document,"clarity","script","yj3dehirsu")</script><script>console.log("site")</script></body></html>', '<script src="http://localhost:4000/hm.js" data-key="hm_x" defer></script>');
    expect(out).not.toContain('clarity.ms');
    expect(out).toContain('console.log("site")');
    expect(out).toMatch(/hm\.js" data-key="hm_x" defer><\/script>\n<\/body>/);
  });
});
