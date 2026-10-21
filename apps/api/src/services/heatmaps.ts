import { randomBytes } from 'node:crypto';
import * as cheerio from 'cheerio';
import { AppError, decryptSecret, encryptSecret } from '@phoenixx/shared';
import { fetchWithRedirects } from '@phoenixx/crawler';
import type { AppContext } from '../context.js';
import { getProject, primaryWebsite } from './common.js';
import { assertPublicHost } from './net-guard.js';

/**
 * Heatmaps: click maps + scroll maps from the first-party tracker (hm.js), shown over a script-free
 * snapshot of the page, plus Microsoft Clarity page insights (Data Export API – Clarity itself exposes no
 * heatmap/click-coordinate data through its API, so its numbers are shown next to ours, never mixed in).
 */

export type Device = 'desktop' | 'tablet' | 'mobile';
const HOST = (h: string) => h.toLowerCase().replace(/^www\./, '');
const CLARITY_API = 'https://www.clarity.ms/export-data/api/v1/project-live-insights';
const CLARITY_DAILY_LIMIT = 10;

/* ── site key (public, like a Clarity/GA id: identifies the project, grants nothing) ── */

export async function siteKeyFor(ctx: AppContext, projectId: string): Promise<string> {
  const p = await getProject(ctx, projectId);
  const existing = (p.settings as { heatmap?: { siteKey?: string } }).heatmap?.siteKey;
  if (existing) return existing;
  const key = `hm_${randomBytes(12).toString('hex')}`;
  await ctx.db.query(`UPDATE projects SET settings = jsonb_set(settings, '{heatmap}', COALESCE(settings->'heatmap', '{}'::jsonb) || $2::jsonb) WHERE id = $1`, [projectId, { siteKey: key }]);
  return key;
}

export function trackerSnippet(ctx: AppContext, key: string) {
  return `<script src="${ctx.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/hm.js" data-key="${key}" defer></script>`;
}

/* ── collection ── */

export interface CollectPayload {
  k: string;
  v: string;
  p: string;
  t?: string;
  d: Device;
  vw: number;
  vh: number;
  h: number;
  s: number;
  e: { sel: string | null; l: string | null; rx: number; ry: number; x: number; y: number; h: number; r: boolean; dd: boolean }[];
}

export interface KeyInfo { projectId: string; isDemo: boolean; hosts: Set<string>; settings: Record<string, unknown>; at: number }
const keyCache = new Map<string, KeyInfo | null>();

export async function resolveKey(ctx: AppContext, key: string): Promise<KeyInfo | null> {
  const hit = keyCache.get(key);
  if (hit !== undefined && (!hit || Date.now() - hit.at < 60_000)) return hit;
  const row = await ctx.db.one<{ id: string; is_demo: boolean; hosts: string[]; settings: Record<string, unknown> }>(
    `SELECT p.id, p.is_demo, p.settings, COALESCE(array_agg(w.base_url) FILTER (WHERE w.base_url IS NOT NULL), '{}') AS hosts
       FROM projects p LEFT JOIN websites w ON w.project_id = p.id
      WHERE p.settings->'heatmap'->>'siteKey' = $1 GROUP BY p.id`,
    [key],
  );
  const info = row ? { projectId: row.id, isDemo: row.is_demo, settings: row.settings ?? {}, hosts: new Set(row.hosts.map((u) => HOST(new URL(u).host))), at: Date.now() } : null;
  if (row) {
    // The local demo copy of the site (demo mode only) reports into the demo project.
    if (row.is_demo && ctx.cfg.DEMO_MODE) for (const h of ['127.0.0.1', 'localhost']) info!.hosts.add(`${h}:${ctx.cfg.API_PORT + 1}`);
  }
  keyCache.set(key, info);
  return info;
}

/** Settings changes (e.g. recordings on/off) apply to the next beacon instead of after the cache expires. */
export function forgetSiteKeys() {
  keyCache.clear();
}

/** Crawlers, headless browsers and monitoring bots are not visitors. */
export const isBot = (ua: string | undefined) => !ua || /bot|crawl|spider|slurp|headless|lighthouse|pagespeed|phantom|puppeteer|playwright|preview|monitor|uptime/i.test(ua);

/** The site key must exist and the page's origin must be one of the project's websites, so a key copied to another site records nothing. */
export async function authorizeBeacon(ctx: AppContext, key: string, originHeader: string | undefined): Promise<KeyInfo> {
  const info = await resolveKey(ctx, key);
  if (!info) throw new AppError('Unknown site key', 404, 'not_found');
  let originHost: string;
  try {
    originHost = HOST(new URL(originHeader ?? '').host);
  } catch {
    throw new AppError('Origin required', 403, 'forbidden');
  }
  if (!info.hosts.has(originHost)) throw new AppError('Origin not allowed for this site key', 403, 'forbidden');
  return info;
}

/** Stores one heatmap beacon. */
export async function collect(ctx: AppContext, b: CollectPayload, originHeader: string | undefined) {
  const info = await authorizeBeacon(ctx, b.k, originHeader);
  const path = normalizePath(b.p);
  const title = b.t?.slice(0, 200) || null;
  await ctx.db.query(
    `INSERT INTO heatmap_events(project_id, page_path, page_title, kind, device, view_id, doc_height, viewport_w, viewport_h, scroll_depth, is_demo)
     VALUES ($1,$2,$3,'view',$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (project_id, view_id) WHERE kind = 'view'
     DO UPDATE SET scroll_depth = GREATEST(heatmap_events.scroll_depth, EXCLUDED.scroll_depth), doc_height = EXCLUDED.doc_height`,
    [info.projectId, path, title, b.d, b.v, b.h, b.vw, b.vh, b.s, info.isDemo],
  );
  if (b.e.length) {
    const params: unknown[] = [];
    const values = b.e.map((c) => {
      params.push(info.projectId, path, title, b.d, b.v, c.sel, c.l, c.rx, c.ry, c.x, c.y, c.h, b.vw, b.vh, c.r, c.dd, info.isDemo);
      const n = params.length - 17;
      return `(${Array.from({ length: 17 }, (_, i) => `$${n + i + 1}`).join(',')}, 'click')`;
    });
    await ctx.db.query(`INSERT INTO heatmap_events(project_id, page_path, page_title, device, view_id, selector, label, rel_x, rel_y, x, y, doc_height, viewport_w, viewport_h, rage, dead, is_demo, kind) VALUES ${values.join(',')}`, params);
  }
  if (Math.random() < 0.005) await pruneHeatmaps(ctx).catch(() => undefined);
  return { ok: true };
}

export async function pruneHeatmaps(ctx: AppContext) {
  return ctx.db.query(`DELETE FROM heatmap_events WHERE created_at < now() - ($1 || ' days')::interval`, [String(ctx.cfg.HEATMAP_RETENTION_DAYS)]);
}

export function normalizePath(p: string) {
  let path = p || '/';
  if (/^https?:\/\//i.test(path)) {
    try {
      path = new URL(path).pathname;
    } catch {
      /* treat as a path */
    }
  }
  path = path.split(/[?#]/)[0]!;
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/index\.html?$/i, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : '/';
}

/* ── reading ── */

interface Filter { days: number; device?: Device | 'all' }
const where = (f: Filter, first = 2) => {
  const parts = [`created_at >= now() - ($${first} || ' days')::interval`];
  const params: unknown[] = [String(f.days)];
  if (f.device && f.device !== 'all') {
    parts.push(`device = $${first + 1}`);
    params.push(f.device);
  }
  return { sql: parts.join(' AND '), params };
};

export async function heatmapSetup(ctx: AppContext, projectId: string) {
  const key = await siteKeyFor(ctx, projectId);
  const p = await getProject(ctx, projectId);
  const last = await ctx.db.one<{ last_at: string | null; live_views: number }>(
    `SELECT MAX(created_at) AS last_at, COUNT(*) FILTER (WHERE NOT is_demo AND kind = 'view' AND created_at > now() - interval '7 days')::int AS live_views FROM heatmap_events WHERE project_id = $1`,
    [projectId],
  );
  return {
    siteKey: key,
    snippet: trackerSnippet(ctx, key),
    isDemo: p.is_demo,
    lastEventAt: last?.last_at ?? null,
    liveViews7d: last?.live_views ?? 0,
    retentionDays: ctx.cfg.HEATMAP_RETENTION_DAYS,
    clarity: await clarityStatus(ctx, projectId),
  };
}

export async function heatmapPages(ctx: AppContext, projectId: string, f: Filter) {
  const w = where(f);
  const rows = await ctx.db.query<{ path: string; title: string | null; views: number; clicks: number; avg_depth: number | null; rage: number; dead: number; demo: boolean }>(
    `SELECT page_path AS path, (ARRAY_AGG(page_title ORDER BY created_at DESC) FILTER (WHERE page_title IS NOT NULL))[1] AS title,
            COUNT(*) FILTER (WHERE kind = 'view')::int AS views,
            COUNT(*) FILTER (WHERE kind = 'click')::int AS clicks,
            AVG(scroll_depth) FILTER (WHERE kind = 'view')::float AS avg_depth,
            COUNT(*) FILTER (WHERE rage)::int AS rage, COUNT(*) FILTER (WHERE dead)::int AS dead,
            BOOL_AND(is_demo) AS demo
       FROM heatmap_events WHERE project_id = $1 AND ${w.sql}
      GROUP BY page_path ORDER BY views DESC, clicks DESC LIMIT 200`,
    [projectId, ...w.params],
  );
  const clarity = await clarityPages(ctx, projectId);
  const site = await primaryWebsite(ctx, projectId);
  return {
    siteUrl: site.base_url,
    dataLabel: rows.length && rows.every((r) => r.demo) ? 'demo' : 'verified',
    items: rows.map((r) => ({ path: r.path, title: r.title, views: r.views, clicks: r.clicks, avgScrollDepth: r.avg_depth, rageClicks: r.rage, deadClicks: r.dead })),
    clarity,
  };
}

export async function heatmapData(ctx: AppContext, projectId: string, path: string, f: Filter) {
  const w = where(f, 3);
  const args = [projectId, normalizePath(path), ...w.params];
  const base = `project_id = $1 AND page_path = $2 AND ${w.sql}`;
  const [points, elements, views, totals] = await Promise.all([
    ctx.db.query<{ selector: string | null; rx: number; ry: number; x: number; yr: number; n: number }>(
      `SELECT selector, ROUND(rel_x::numeric, 2)::float AS rx, ROUND(rel_y::numeric, 2)::float AS ry, ROUND(x::numeric, 3)::float AS x,
              ROUND((y::float / GREATEST(doc_height, 1))::numeric, 3)::float AS yr, COUNT(*)::int AS n
         FROM heatmap_events WHERE kind = 'click' AND ${base} GROUP BY 1,2,3,4,5 ORDER BY n DESC LIMIT 5000`,
      args,
    ),
    ctx.db.query<{ selector: string | null; label: string | null; n: number; rage: number; dead: number }>(
      `SELECT selector, MAX(label) AS label, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE rage)::int AS rage, COUNT(*) FILTER (WHERE dead)::int AS dead
         FROM heatmap_events WHERE kind = 'click' AND ${base} GROUP BY selector ORDER BY n DESC LIMIT 30`,
      args,
    ),
    ctx.db.query<{ d: number; fold: number | null }>(`SELECT scroll_depth::float AS d, (viewport_h::float / GREATEST(doc_height, 1)) AS fold FROM heatmap_events WHERE kind = 'view' AND ${base}`, args),
    ctx.db.one<{ clicks: number; rage: number; dead: number; title: string | null; demo: boolean | null }>(
      `SELECT COUNT(*) FILTER (WHERE kind = 'click')::int AS clicks, COUNT(*) FILTER (WHERE rage)::int AS rage, COUNT(*) FILTER (WHERE dead)::int AS dead, (ARRAY_AGG(page_title ORDER BY created_at DESC) FILTER (WHERE page_title IS NOT NULL))[1] AS title, BOOL_AND(is_demo) AS demo
         FROM heatmap_events WHERE ${base}`,
      args,
    ),
  ]);
  const depths = views.map((v) => Math.min(1, Math.max(0, v.d ?? 0)));
  const scroll = Array.from({ length: 21 }, (_, i) => {
    const at = i / 20;
    // within 1% of a depth counts as reaching it (the last pixel row is rarely hit exactly)
    return { depth: at, reach: depths.length ? depths.filter((d) => d >= at - 0.01).length / depths.length : 0 };
  });
  const folds = views.map((v) => v.fold).filter((x): x is number => x != null && x > 0);
  const clicks = totals?.clicks ?? 0;
  return {
    path: normalizePath(path),
    title: totals?.title ?? null,
    dataLabel: views.length && totals?.demo ? 'demo' : 'verified',
    totals: { views: views.length, clicks, rageClicks: totals?.rage ?? 0, deadClicks: totals?.dead ?? 0, avgScrollDepth: depths.length ? depths.reduce((a, b) => a + b, 0) / depths.length : null, avgFold: folds.length ? folds.reduce((a, b) => a + b, 0) / folds.length : null },
    points: points.map((p) => ({ selector: p.selector, rx: p.rx, ry: p.ry, x: p.x, yr: p.yr, n: p.n })),
    elements: elements.map((e) => ({ selector: e.selector, label: e.label, clicks: e.n, share: clicks ? e.n / clicks : 0, rageClicks: e.rage, deadClicks: e.dead })),
    scroll,
  };
}

/* ── page snapshot (background of the heatmap) ── */

const snapCache = new Map<string, { at: number; value: { html: string; url: string; fetchedAt: string } }>();

/**
 * Fetches the page and returns it without scripts, event handlers, frames or refreshes, with a <base> so
 * CSS and images load from the site. The dashboard shows it in a sandboxed iframe (scripts disabled).
 */
export async function pageSnapshot(ctx: AppContext, projectId: string, path: string) {
  const cacheKey = `${projectId}:${normalizePath(path)}`;
  const hit = snapCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const p = await getProject(ctx, projectId);
  const site = new URL((await primaryWebsite(ctx, projectId)).base_url);
  const pagePath = normalizePath(path);
  const real = new URL(pagePath, site);
  let fetchUrl = real.toString();
  if (p.is_demo && ctx.cfg.DEMO_MODE) {
    const { demoSiteOrigin } = await import('../demo/site.js');
    fetchUrl = new URL(pagePath, demoSiteOrigin(ctx)).toString();
  } else {
    await assertPublicHost(fetchUrl, ctx.cfg.OUTBOUND_ALLOW_PRIVATE_HOSTS);
  }
  const r = await fetchWithRedirects(fetchUrl, { userAgent: ctx.cfg.CRAWL_USER_AGENT, timeoutMs: 15_000, maxBytes: 3_000_000, maxRedirects: 5 });
  if (!r.body || !r.status || r.status >= 400) throw new AppError(`Could not load ${real.toString()} (${r.status ?? r.error ?? 'no response'})`, 502, 'snapshot_failed');
  if (!(p.is_demo && ctx.cfg.DEMO_MODE) && HOST(new URL(r.finalUrl).host) !== HOST(site.host)) throw new AppError('The page redirected to another website', 502, 'snapshot_failed');
  const value = { html: sanitizeSnapshot(r.body, real.toString()), url: real.toString(), fetchedAt: new Date().toISOString() };
  snapCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export function sanitizeSnapshot(html: string, baseUrl: string) {
  const $ = cheerio.load(html);
  $('script, noscript, iframe, frame, frameset, object, embed, base, meta[http-equiv], link[rel="manifest"], link[rel="serviceworker"]').remove();
  $('*').each((_, el) => {
    const attribs = (el as { attribs?: Record<string, string> }).attribs ?? {};
    for (const name of Object.keys(attribs)) {
      const v = attribs[name] ?? '';
      if (/^on/i.test(name) || (/^(href|src|action|formaction|xlink:href)$/i.test(name) && /^\s*(javascript|data:text\/html)/i.test(v))) $(el).removeAttr(name);
    }
  });
  $('form').attr('action', '#');
  $('head').prepend(
    `<base href="${baseUrl.replace(/"/g, '&quot;')}"><style data-heatmap>*,*::before,*::after{animation:none!important;transition:none!important}` +
      `[data-aos],.aos-init,.wow,.reveal,.fade-in,.animate__animated{opacity:1!important;transform:none!important;visibility:visible!important}html{scroll-behavior:auto!important;overflow-y:auto!important}body{overflow:visible!important}` +
      // preloaders/splash screens are removed by the site's JavaScript, which doesn't run in the snapshot
      `#loading,#loader,#preloader,#page-loader,#splash,.preloader,.page-loader,.loader-wrapper,.loading-screen,.splash-screen,[id*="preloader" i],[class*="preloader" i]{display:none!important}</style>`,
  );
  return $.html();
}

/* ── Microsoft Clarity (Data Export API) ── */

interface ClarityConfig { clarityProjectId?: string | null }

async function clarityRow(ctx: AppContext, projectId: string) {
  return ctx.db.one<{ config: ClarityConfig; secret_encrypted: string | null; status: string; last_sync_at: string | null; last_error: string | null }>(
    `SELECT config, secret_encrypted, status, last_sync_at, last_error FROM integrations WHERE project_id = $1 AND provider = 'microsoft_clarity'`,
    [projectId],
  );
}

export async function clarityStatus(ctx: AppContext, projectId: string) {
  const row = await clarityRow(ctx, projectId);
  const calls = await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM clarity_snapshots WHERE project_id = $1 AND fetched_at > now() - interval '24 hours'`, [projectId]);
  const clarityProjectId = row?.config.clarityProjectId ?? null;
  return {
    connected: !!row?.secret_encrypted,
    status: row?.status ?? 'disconnected',
    clarityProjectId,
    lastSyncAt: row?.last_sync_at ?? null,
    lastError: row?.last_error ?? null,
    callsLast24h: calls?.n ?? 0,
    dailyLimit: CLARITY_DAILY_LIMIT,
    dashboardUrl: clarityProjectId ? `https://clarity.microsoft.com/projects/view/${encodeURIComponent(clarityProjectId)}/heatmaps?date=Last%203%20days` : null,
  };
}

/** Saves the Clarity project id and (optionally) a Data Export API token. The token is encrypted and never returned. */
export async function saveClarity(ctx: AppContext, projectId: string, b: { clarityProjectId: string; apiToken?: string | null }) {
  const row = await clarityRow(ctx, projectId);
  const secret = b.apiToken ? encryptSecret(JSON.stringify({ token: b.apiToken }), ctx.encryptionKey) : b.apiToken === null ? null : (row?.secret_encrypted ?? null);
  await ctx.db.query(
    `INSERT INTO integrations(project_id, provider, status, config, secret_encrypted, connected_at) VALUES ($1,'microsoft_clarity','disconnected',$2,$3,now())
     ON CONFLICT (project_id, provider) DO UPDATE SET config = EXCLUDED.config, secret_encrypted = EXCLUDED.secret_encrypted, last_error = NULL`,
    [projectId, { clarityProjectId: b.clarityProjectId }, secret],
  );
  return clarityStatus(ctx, projectId);
}

export async function disconnectClarity(ctx: AppContext, projectId: string) {
  await ctx.db.query(`DELETE FROM integrations WHERE project_id = $1 AND provider = 'microsoft_clarity'`, [projectId]);
  return clarityStatus(ctx, projectId);
}

/** One Data Export call (dimension URL). Clarity allows 10 per project per day, so this is never automatic more than once a day. */
export async function syncClarity(ctx: AppContext, projectId: string, opts: { numOfDays?: number; fetchImpl?: typeof fetch } = {}) {
  const row = await clarityRow(ctx, projectId);
  if (!row?.secret_encrypted) throw new AppError('Add a Clarity Data Export API token first (Clarity → Settings → Data Export → Generate new API token)', 400, 'integration_required');
  const status = await clarityStatus(ctx, projectId);
  if (status.callsLast24h >= CLARITY_DAILY_LIMIT) throw new AppError(`Clarity allows ${CLARITY_DAILY_LIMIT} Data Export calls per project per day – try again later`, 429, 'rate_limited');
  const { token } = JSON.parse(decryptSecret(row.secret_encrypted, ctx.encryptionKey)) as { token: string };
  const numOfDays = Math.min(3, Math.max(1, opts.numOfDays ?? 3));
  const url = `${CLARITY_API}?numOfDays=${numOfDays}&dimension1=URL`;
  const res = await (opts.fetchImpl ?? fetch)(url, { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) }).catch((e: Error) => {
    throw new AppError(`Clarity request failed: ${e.message}`, 502, 'clarity_failed');
  });
  if (!res.ok) {
    const msg = res.status === 401 ? 'token missing, invalid or expired' : res.status === 403 ? 'token not authorised for this project' : res.status === 429 ? 'daily limit reached' : `HTTP ${res.status}`;
    await ctx.db.query(`UPDATE integrations SET status = 'error', last_error = $2 WHERE project_id = $1 AND provider = 'microsoft_clarity'`, [projectId, `Clarity: ${msg}`]);
    throw new AppError(`Clarity: ${msg}`, res.status === 429 ? 429 : 502, 'clarity_failed');
  }
  const payload = (await res.json()) as unknown;
  if (!Array.isArray(payload)) throw new AppError('Clarity returned an unexpected response', 502, 'clarity_failed');
  await ctx.db.query(`INSERT INTO clarity_snapshots(project_id, num_days, dimension, payload) VALUES ($1,$2,'URL',$3)`, [projectId, numOfDays, JSON.stringify(payload)]);
  await ctx.db.query(`UPDATE integrations SET status = 'connected', last_sync_at = now(), last_error = NULL WHERE project_id = $1 AND provider = 'microsoft_clarity'`, [projectId]);
  return { metrics: payload.length, pages: parseClarity(payload as ClarityMetric[]).length };
}

interface ClarityMetric { metricName?: string; information?: Record<string, unknown>[] }
export interface ClarityPage { url: string; path: string; sessions: number | null; scrollDepth: number | null; engagementSec: number | null; deadClicks: number | null; rageClicks: number | null; quickbacks: number | null; excessiveScroll: number | null; scriptErrors: number | null; errorClicks: number | null }

const num = (v: unknown) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
/** First numeric field of a metric row, trying the known Clarity field names first. */
function pick(row: Record<string, unknown> | undefined, prefer: string[]): number | null {
  if (!row) return null;
  for (const k of prefer) if (num(row[k]) != null) return num(row[k]);
  for (const [k, v] of Object.entries(row)) if (k !== 'URL' && num(v) != null) return num(v);
  return null;
}
const METRIC_KEY: Record<string, keyof Omit<ClarityPage, 'url' | 'path'>> = {
  traffic: 'sessions', scrolldepth: 'scrollDepth', engagementtime: 'engagementSec', deadclickcount: 'deadClicks', rageclickcount: 'rageClicks',
  quickbackclick: 'quickbacks', excessivescroll: 'excessiveScroll', scripterrorcount: 'scriptErrors', errorclickcount: 'errorClicks',
};
const PREFER: Record<string, string[]> = {
  sessions: ['totalSessionCount'], scrollDepth: ['averageScrollDepth'], engagementSec: ['activeTime', 'totalTime'],
  deadClicks: ['subTotal', 'sessionsCount'], rageClicks: ['subTotal', 'sessionsCount'], quickbacks: ['subTotal', 'sessionsCount'],
  excessiveScroll: ['subTotal', 'sessionsCount'], scriptErrors: ['subTotal', 'sessionsCount'], errorClicks: ['subTotal', 'sessionsCount'],
};

/** Clarity's response is one entry per metric, each with rows per URL. Turned into one row per URL. */
export function parseClarity(payload: ClarityMetric[]): ClarityPage[] {
  const pages = new Map<string, ClarityPage>();
  for (const m of payload) {
    const field = METRIC_KEY[(m.metricName ?? '').toLowerCase().replace(/[^a-z]/g, '')];
    if (!field) continue;
    for (const row of m.information ?? []) {
      const url = typeof row.URL === 'string' ? row.URL : typeof row.Url === 'string' ? row.Url : null;
      if (!url) continue;
      let path = url;
      try {
        const u = new URL(url);
        path = normalizePath(u.pathname) + (u.hash && u.hash.length > 1 ? u.hash : '');
      } catch {
        /* keep as is */
      }
      const page = pages.get(url) ?? { url, path, sessions: null, scrollDepth: null, engagementSec: null, deadClicks: null, rageClicks: null, quickbacks: null, excessiveScroll: null, scriptErrors: null, errorClicks: null };
      page[field] = pick(row, PREFER[field] ?? []);
      pages.set(url, page);
    }
  }
  return [...pages.values()].sort((a, b) => (b.sessions ?? 0) - (a.sessions ?? 0));
}

async function clarityPages(ctx: AppContext, projectId: string) {
  const snap = await ctx.db.one<{ payload: ClarityMetric[]; num_days: number; fetched_at: string }>(`SELECT payload, num_days, fetched_at FROM clarity_snapshots WHERE project_id = $1 ORDER BY fetched_at DESC LIMIT 1`, [projectId]);
  if (!snap) return null;
  const payload = typeof snap.payload === 'string' ? (JSON.parse(snap.payload) as ClarityMetric[]) : snap.payload;
  return { fetchedAt: snap.fetched_at, numDays: snap.num_days, pages: parseClarity(payload) };
}
