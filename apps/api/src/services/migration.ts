import { crawlSite } from '@phoenixx/crawler';
import { buildInlinks, compareSnapshots, redirectRules, type SnapshotPage } from '@phoenixx/seo-engine';
import { AppError, addDays, isoDate, normalizeUrl } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { latestCrawledPages, latestGscDate } from './common.js';
import { raiseAlert } from './alerts.js';
import { fingerprint, upsertRecommendation } from './recommendations.js';
import { scorePriority } from '@phoenixx/seo-engine';

/**
 * SEO Migration Monitor. Capture a BASELINE of the current site (URLs, titles, H1s, canonicals,
 * indexability, internal links, organic traffic) before the redesign, then compare it against the
 * staging or newly launched site. Paths are compared, so a staging host works.
 */
export async function createSnapshot(ctx: AppContext, projectId: string, input: { label: string; kind: 'baseline' | 'comparison'; sourceUrl?: string; maxPages?: number }) {
  let pages;
  let crawlRunId: string | null = null;
  let sourceUrl: string;
  if (input.sourceUrl) {
    const url = normalizeUrl(input.sourceUrl);
    if (!url) throw new AppError('Invalid sourceUrl', 400, 'validation');
    sourceUrl = url;
    const out = await crawlSite({ baseUrl: url, maxPages: input.maxPages ?? ctx.cfg.CRAWL_MAX_PAGES, concurrency: ctx.cfg.CRAWL_CONCURRENCY, delayMs: ctx.cfg.CRAWL_DELAY_MS, timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS, userAgent: ctx.cfg.CRAWL_USER_AGENT, respectRobots: false, logger: ctx.log.child({ snapshot: input.label }) });
    pages = out.pages;
  } else {
    const latest = await latestCrawledPages(ctx, projectId);
    if (!latest.crawlId) throw new AppError('No crawl available – run a crawl or pass sourceUrl', 400, 'no_crawl');
    pages = latest.pages;
    crawlRunId = latest.crawlId;
    sourceUrl = (await ctx.db.one<{ base_url: string }>('SELECT base_url FROM websites WHERE project_id = $1 ORDER BY is_primary DESC LIMIT 1', [projectId]))!.base_url;
  }
  const inlinks = buildInlinks(pages);
  const end = await latestGscDate(ctx.db, projectId);
  const traffic = await ctx.db.query<{ path: string; clicks: number; impressions: number }>(
    `SELECT regexp_replace(page, '^https?://[^/]+', '') AS path, SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions FROM search_console_data WHERE project_id = $1 AND page <> '' AND query <> '' AND date > $2 GROUP BY 1`,
    [projectId, isoDate(addDays(end, -90))],
  );
  const tBy = new Map(traffic.map((t) => [t.path || '/', t]));
  const topQueries = await ctx.db.query(`SELECT query, SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions FROM search_console_data WHERE project_id = $1 AND query <> '' AND date > $2 GROUP BY query ORDER BY clicks DESC, impressions DESC LIMIT 100`, [projectId, isoDate(addDays(end, -90))]);
  const snap = await ctx.db.one<{ id: string }>(`INSERT INTO migration_snapshots(project_id, label, kind, source_url, crawl_run_id, top_queries, page_count) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [projectId, input.label, input.kind, sourceUrl, crawlRunId, topQueries, pages.length]);
  for (const p of pages) {
    const path = new URL(p.url).pathname;
    const t = tBy.get(path);
    const status = p.redirectChain.length ? p.redirectChain[0]!.status : p.statusCode;
    await ctx.db.query(
      `INSERT INTO migration_snapshot_pages(snapshot_id, url, path, status_code, title, meta_description, h1, canonical, indexable, inlinks, outlinks, clicks, impressions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (snapshot_id, path) DO NOTHING`,
      [snap!.id, p.url, path, status, p.title, p.metaDescription, p.h1s[0] ?? null, p.canonical, p.indexable, inlinks.get(p.url)?.size ?? 0, JSON.stringify([...new Set(p.internalLinks.map((l) => new URL(l.href).pathname))].slice(0, 200)), t?.clicks ?? 0, t?.impressions ?? 0],
    );
  }
  return { snapshotId: snap!.id, pages: pages.length, sourceUrl };
}

async function snapshotPages(ctx: AppContext, id: string): Promise<SnapshotPage[]> {
  const rows = await ctx.db.query<any>('SELECT * FROM migration_snapshot_pages WHERE snapshot_id = $1', [id]);
  return rows.map((r) => ({ path: r.path, url: r.url, statusCode: r.status_code, title: r.title, metaDescription: r.meta_description, h1: r.h1, canonical: r.canonical, indexable: r.indexable, inlinks: r.inlinks, clicks: r.clicks, impressions: r.impressions }));
}

export async function compareMigration(ctx: AppContext, projectId: string, input: { baselineId: string; comparisonId: string }) {
  const [b, c] = await Promise.all([
    ctx.db.one<any>('SELECT * FROM migration_snapshots WHERE id = $1 AND project_id = $2', [input.baselineId, projectId]),
    ctx.db.one<any>('SELECT * FROM migration_snapshots WHERE id = $1 AND project_id = $2', [input.comparisonId, projectId]),
  ]);
  if (!b || !c) throw new AppError('Snapshot not found', 404, 'not_found');
  const result = compareSnapshots(await snapshotPages(ctx, b.id), await snapshotPages(ctx, c.id));
  const rules = redirectRules(result.redirectMap, 'apache');
  const report = await ctx.db.one<{ id: string }>(
    `INSERT INTO reports(project_id, type, title, summary, data) VALUES ($1,'migration',$2,$3,$4) RETURNING id`,
    [projectId, `Migration check: ${b.label} → ${c.label}`, `${result.summary.missing} missing URL(s), ${result.summary.critical} critical and ${result.summary.high} high findings; ${result.summary.atRiskClicks} clicks at risk.`, { baseline: { id: b.id, label: b.label, url: b.source_url }, comparison: { id: c.id, label: c.label, url: c.source_url }, ...result, apacheRules: rules }],
  );
  if (result.summary.critical) {
    await raiseAlert(ctx, projectId, { severity: 'critical', type: 'migration', title: `Redesign check: ${result.summary.critical} critical SEO regression(s)`, message: `${result.summary.missing} URL(s) from the current site are missing in "${c.label}" (${result.summary.atRiskClicks} clicks / 90d at risk). Review the migration report before launch.`, evidence: { reportId: report!.id }, fingerprint: `migration:${b.id}:${c.id}` });
  }
  // Redirect proposals are high-risk: queued for admin approval, never applied automatically.
  for (const r of result.redirectMap) {
    const f = result.findings.find((x) => x.path === r.from);
    await upsertRecommendation(ctx, {
      projectId,
      source: 'migration',
      type: 'redirect',
      pageUrl: new URL(r.from, b.source_url).toString(),
      title: `301 redirect ${r.from} → ${r.to}`,
      what: `Add a single-hop 301 redirect from ${r.from} to ${r.to} before the new site goes live.`,
      why: `${r.from} exists on the current site but not in "${c.label}". Best match by slug/title/H1 (${r.basis}).`,
      evidence: [{ label: 'Clicks (90d)', value: f?.clicks ?? 0 }, { label: 'Impressions (90d)', value: f?.impressions ?? 0 }, { label: 'Match confidence', value: r.confidence }],
      currentValue: r.from,
      proposedValue: `Redirect 301 ${r.from} ${r.to}`,
      expectedPurpose: 'Preserve rankings, backlinks and bookmarks through the redesign.',
      risk: 'high',
      confidence: r.confidence >= 0.5 ? 'medium' : 'low',
      priority: scorePriority({ impact: 4.5, effort: 1, impressions: f?.impressions, severity: f?.severity, businessRelevance: 4, confidence: r.confidence }),
      fingerprint: fingerprint('migration-redirect', projectId, b.id, r.from),
      queueForApproval: true,
    });
  }
  return { reportId: report!.id, summary: result.summary, findings: result.findings.slice(0, 200), redirectMap: result.redirectMap, apacheRules: rules };
}
