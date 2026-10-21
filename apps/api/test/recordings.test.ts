import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, testApp } from './helpers.js';
import { startFixtureSite } from '../../../tests/fixtures/site.js';
import { parseUserAgent } from '../src/services/recordings.js';
import { seedDemoRecordings } from '../src/demo/recordings.js';

/**
 * Session recordings: hm.js loads /rr.js (rrweb) when /api/collect/config says recordings are on →
 * /api/collect/rec (site key + origin + bot checks) → sessions with stats → filters → replay events.
 */
let t: Awaited<ReturnType<typeof testApp>>;
let site: Awaited<ReturnType<typeof startFixtureSite>>;
let owner: string;
let other: string;
let pid: string;
let key: string;
let recId: string;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const T0 = 1_780_000_000_000;

const send = (body: unknown, opts: { origin?: string; ua?: string } = {}) =>
  t.app.inject({ method: 'POST', url: '/api/collect/rec', headers: { 'content-type': 'text/plain;charset=UTF-8', 'user-agent': opts.ua ?? CHROME, ...(opts.origin !== undefined ? { origin: opts.origin } : { origin: site.origin }) }, payload: JSON.stringify(body) });

const page1 = [
  { type: 4, timestamp: T0, data: { href: 'https://x/', width: 1440, height: 900 } },
  { type: 2, timestamp: T0 + 5, data: { node: { type: 0, childNodes: [], id: 1 }, initialOffset: { top: 0, left: 0 } } },
  { type: 3, timestamp: T0 + 1500, data: { source: 1, positions: [{ x: 10, y: 10, id: 5, timeOffset: 0 }] } },
  { type: 3, timestamp: T0 + 3000, data: { source: 2, type: 2, id: 7, x: 100, y: 200 } },
  { type: 3, timestamp: T0 + 3100, data: { source: 2, type: 2, id: 7, x: 100, y: 200 } },
  { type: 3, timestamp: T0 + 3200, data: { source: 2, type: 2, id: 7, x: 100, y: 200 } },
  { type: 5, timestamp: T0 + 3201, data: { tag: 'rage-click', payload: { label: 'Get a quote' } } },
  { type: 5, timestamp: T0 + 6000, data: { tag: 'dead-click', payload: { label: null } } },
];
const beacon = (over: Record<string, unknown> = {}) => ({ k: key, s: 'sess00000001', v: 'view0000001', p: '/', t: 'Home', d: 'desktop', vw: 1440, vh: 900, q: 0, e: page1, ...over });

beforeAll(async () => {
  site = await startFixtureSite();
  t = await testApp({ OUTBOUND_ALLOW_PRIVATE_HOSTS: true } as never);
  await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'root@rec.example', name: 'Root', password: 'correct horse battery', organizationName: 'Ops' } });
  const a = await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'owner@rec.example', name: 'Owner', password: 'correct horse battery', organizationName: 'Rec Co' } });
  owner = a.body.token;
  pid = (await json(t.app, 'POST', '/api/onboarding/projects', { token: owner, body: { organizationId: a.body.organization.id, url: site.origin } })).body.project.id;
  key = (await json(t.app, 'GET', `/api/projects/${pid}/heatmaps/setup`, { token: owner })).body.siteKey;
  other = (await json(t.app, 'POST', '/api/auth/signup', { body: { email: 'other@rec.example', name: 'Other', password: 'correct horse battery', organizationName: 'Other Co' } })).body.token;
});
afterAll(async () => {
  await t.close();
  await site.close();
});

describe('public endpoints', () => {
  it('serves the rrweb recorder and the tracker config', async () => {
    const rr = await t.app.inject({ method: 'GET', url: '/rr.js' });
    expect(rr.statusCode).toBe(200);
    expect(rr.headers['content-type']).toContain('javascript');
    expect(rr.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(rr.body).toContain('rrwebRecord');
    expect(rr.body.trimEnd()).not.toMatch(/sourceMappingURL=\S+$/);
    expect(rr.body.length).toBeGreaterThan(70_000); // only the trailing comment was removed
    const cfg = await t.app.inject({ method: 'GET', url: `/api/collect/config?k=${key}`, headers: { 'user-agent': CHROME } });
    expect(cfg.statusCode).toBe(200);
    expect(cfg.headers['access-control-allow-origin']).toBe('*');
    expect(JSON.parse(cfg.body)).toEqual({ recordings: { enabled: true, sampleRate: 1, masking: 'balanced' } });
    const bot = await t.app.inject({ method: 'GET', url: `/api/collect/config?k=${key}`, headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
    expect(JSON.parse(bot.body).recordings.enabled).toBe(false);
    expect((await t.app.inject({ method: 'GET', url: '/api/collect/config?k=hm_000000000000000000000000' })).statusCode).toBe(404);
  });

  it('tracker masks inputs and supports block/mask attributes', async () => {
    const js = (await t.app.inject({ method: 'GET', url: '/hm.js' })).body;
    expect(js).toContain('maskAllInputs: true');
    expect(js).toContain("blockSelector: '[data-hm-block]'");
    expect(js).toContain("cfg.masking === 'strict' ? '*'");
    expect(js).toContain('sessionStorage');
    expect(js).not.toContain('document.cookie');
  });
});

describe('ingestion', () => {
  it('stores a session with stats, browser and OS, and rejects foreign origins and bots', async () => {
    expect((await send(beacon(), { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await send(beacon(), { ua: 'Mozilla/5.0 (compatible; bingbot/2.0)' })).statusCode).toBe(204);
    expect((await json(t.app, 'GET', `/api/projects/${pid}/recordings?days=365`, { token: owner })).body.total).toBe(0);
    expect((await send({ ...beacon(), e: [] })).statusCode).toBe(400);

    expect((await send(beacon())).statusCode).toBe(204);
    const list = await json(t.app, 'GET', `/api/projects/${pid}/recordings?days=365`, { token: owner });
    expect(list.body.total).toBe(1);
    const r = list.body.items[0];
    expect(r).toMatchObject({ device: 'desktop', browser: 'Chrome', os: 'Windows', entry_path: '/', exit_path: '/', page_count: 1, click_count: 3, rage_clicks: 1, dead_clicks: 1, error_count: 0, duration_ms: 6000 });
    recId = r.id;
  });

  it('adds later beacons and new page views to the same session', async () => {
    const page2 = [
      { type: 4, timestamp: T0 + 9000, data: { href: 'https://x/services', width: 1440, height: 900 } },
      { type: 2, timestamp: T0 + 9005, data: { node: { type: 0, childNodes: [], id: 1 } } },
      { type: 5, timestamp: T0 + 12000, data: { tag: 'error', payload: { message: 'TypeError: x is undefined' } } },
    ];
    expect((await send(beacon({ v: 'view0000002', p: '/services', t: 'Services', q: 0, e: page2 }))).statusCode).toBe(204);
    const d = await json(t.app, 'GET', `/api/projects/${pid}/recordings/${recId}`, { token: owner });
    expect(d.body).toMatchObject({ page_count: 2, exit_path: '/services', error_count: 1, duration_ms: 12000 });
    expect(d.body.pages.map((p: any) => p.path)).toEqual(['/', '/services']);
    expect(d.body.viewed_at).toBeNull(); // marked on this read; returned row is the pre-read state
    const ev = await json(t.app, 'GET', `/api/projects/${pid}/recordings/${recId}/events`, { token: owner });
    expect(ev.body.events).toHaveLength(page1.length + page2.length);
    expect(ev.body.events.map((e: any) => e.timestamp)).toEqual([...page1, ...page2].map((e) => e.timestamp));
  });

  it('stops storing when recording is switched off', async () => {
    expect((await json(t.app, 'PUT' as never, `/api/projects/${pid}/recordings/settings`, { token: owner, body: { enabled: false, masking: 'paranoid' } })).status).toBe(400);
    expect((await json(t.app, 'PUT' as never, `/api/projects/${pid}/recordings/settings`, { token: owner, body: { enabled: false } })).status).toBe(200);
    const cfg = await t.app.inject({ method: 'GET', url: `/api/collect/config?k=${key}`, headers: { 'user-agent': CHROME } });
    expect(JSON.parse(cfg.body).recordings.enabled).toBe(false);
    await send(beacon({ s: 'sess00000002' }));
    expect((await json(t.app, 'GET', `/api/projects/${pid}/recordings?days=365`, { token: owner })).body.total).toBe(1);
    await json(t.app, 'PUT' as never, `/api/projects/${pid}/recordings/settings`, { token: owner, body: { enabled: true, sampleRate: 0.5, masking: 'strict' } });
    expect((await json(t.app, 'GET', `/api/projects/${pid}/recordings/settings`, { token: owner })).body).toMatchObject({ enabled: true, sampleRate: 0.5, masking: 'strict' });
  });
});

describe('list, filters and management', () => {
  it('filters like Clarity: device, rage/dead/errors, page, duration, viewed', async () => {
    await send(beacon({ s: 'sess00000003', v: 'view0000003', d: 'mobile', vw: 390, p: '/web-design', e: [page1[0], page1[1], page1[2]] }), { ua: IPHONE });
    const q = async (qs: string) => (await json(t.app, 'GET', `/api/projects/${pid}/recordings?days=365&${qs}`, { token: owner })).body;
    expect((await q('')).total).toBe(2);
    expect((await q('device=mobile')).items[0]).toMatchObject({ browser: 'Safari', os: 'iOS', device: 'mobile' });
    expect((await q('rage=1')).total).toBe(1);
    expect((await q('dead=1')).total).toBe(1);
    expect((await q('errors=1')).total).toBe(1);
    expect((await q('errors=0')).total).toBe(2);
    expect((await q('page=web-des')).total).toBe(1);
    expect((await q('minDurationSec=5')).total).toBe(1);
    expect((await q('unviewed=1')).total).toBe(1); // the first one was opened above
    expect((await q('sort=pages')).items[0].page_count).toBe(2);
    expect((await q('')).summary).toMatchObject({ sessions: 2, withRageClicks: 1, withErrors: 1 });
  });

  it('favorites, prev/next and delete; other tenants see nothing', async () => {
    expect((await json(t.app, 'PATCH', `/api/projects/${pid}/recordings/${recId}`, { token: owner, body: { favorite: true } })).body).toMatchObject({ favorite: true });
    expect((await json(t.app, 'GET', `/api/projects/${pid}/recordings?days=365&favorites=1`, { token: owner })).body.total).toBe(1);
    const d = await json(t.app, 'GET', `/api/projects/${pid}/recordings/${recId}`, { token: owner });
    expect(d.body.previousId ?? d.body.nextId).toBeTruthy();
    for (const url of [`/api/projects/${pid}/recordings`, `/api/projects/${pid}/recordings/${recId}`, `/api/projects/${pid}/recordings/${recId}/events`]) {
      expect((await json(t.app, 'GET', url, { token: other })).status).toBe(404);
    }
    expect((await json(t.app, 'DELETE', `/api/projects/${pid}/recordings/${recId}`, { token: other })).status).toBe(404);
    expect((await json(t.app, 'DELETE', `/api/projects/${pid}/recordings/${recId}`, { token: owner })).status).toBe(200);
    expect((await json(t.app, 'GET', `/api/projects/${pid}/recordings/${recId}/events`, { token: owner })).status).toBe(404);
  });
});

describe('helpers & demo data', () => {
  it('names browsers and operating systems', () => {
    expect(parseUserAgent(CHROME)).toEqual({ browser: 'Chrome', os: 'Windows' });
    expect(parseUserAgent(IPHONE)).toEqual({ browser: 'Safari', os: 'iOS' });
    expect(parseUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toEqual({ browser: 'Edge', os: 'Windows' });
    expect(parseUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0')).toEqual({ browser: 'Firefox', os: 'macOS' });
    expect(parseUserAgent('Mozilla/5.0 (Linux; Android 15; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36')).toEqual({ browser: 'Samsung Internet', os: 'Android' });
  });

  it('seeds the shipped sample recordings with recent timestamps', async () => {
    const n = await seedDemoRecordings(t.ctx, (await json(t.app, 'POST', '/api/onboarding/projects', { token: other, body: { organizationId: (await json(t.app, 'GET', '/api/orgs', { token: other })).body[0].id, url: site.origin } })).body.project.id);
    expect(n).toBeGreaterThanOrEqual(5);
    const row = await t.ctx.db.one<{ id: string; first_ts: string; is_demo: boolean }>(`SELECT id, first_ts, is_demo FROM session_recordings WHERE session_key LIKE 'demo%' ORDER BY started_at DESC LIMIT 1`);
    expect(row!.is_demo).toBe(true);
    expect(Math.abs(Number(row!.first_ts) - Date.now())).toBeLessThan(3 * 86400_000);
  });
});
