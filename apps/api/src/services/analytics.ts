import { comparePeriods, dailySeries, aggregate } from '@phoenixx/keyword-engine';
import { addDays, isoDate, round } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { latestCrawl, latestGscDate, primaryWebsite } from './common.js';
import { loadGscRows } from './alerts.js';

/** Site totals for a window (prefers the site-level total rows, which include anonymised queries). */
export async function siteTotals(ctx: AppContext, projectId: string, start: string, end: string) {
  const totals = await loadGscRows(ctx, projectId, start, end, { withQuery: false });
  const rows = totals.length ? totals : await loadGscRows(ctx, projectId, start, end);
  const a = aggregate(rows);
  return { clicks: a.clicks, impressions: a.impressions, ctr: a.ctr, position: a.position, source: totals.length ? 'site_totals' : 'query_rows' };
}

export async function kpiWindow(ctx: AppContext, projectId: string, days: number) {
  const end = await latestGscDate(ctx.db, projectId);
  const start = isoDate(addDays(end, -(days - 1)));
  const prevEnd = isoDate(addDays(start, -1));
  const prevStart = isoDate(addDays(prevEnd, -(days - 1)));
  const [current, previous] = await Promise.all([siteTotals(ctx, projectId, start, end), siteTotals(ctx, projectId, prevStart, prevEnd)]);
  return { start, end, prevStart, prevEnd, current, previous };
}

export async function overview(ctx: AppContext, projectId: string, days = 28) {
  const website = await primaryWebsite(ctx, projectId);
  const crawl = await latestCrawl(ctx, website.id);
  const prevCrawl = crawl ? await ctx.db.one<{ health_score: number }>(`SELECT health_score FROM crawl_runs WHERE website_id = $1 AND status = 'completed' AND started_at < $2 ORDER BY started_at DESC LIMIT 1`, [website.id, crawl.started_at]) : null;
  const k = await kpiWindow(ctx, projectId, days);
  const seriesStart = isoDate(addDays(k.end, -89));
  const totals = await loadGscRows(ctx, projectId, seriesStart, k.end, { withQuery: false });
  const series = dailySeries(totals.length ? totals : await loadGscRows(ctx, projectId, seriesStart, k.end), seriesStart, k.end).map((d) => ({ ...d, ctr: round(d.ctr, 4) }));
  const dist = await ctx.db.query<{ bucket: string; n: number }>(
    `WITH q AS (SELECT query, SUM(position*impressions)/NULLIF(SUM(impressions),0) AS pos FROM search_console_data WHERE project_id = $1 AND query <> '' AND date BETWEEN $2 AND $3 GROUP BY query)
     SELECT CASE WHEN pos <= 3 THEN '1-3' WHEN pos <= 10 THEN '4-10' WHEN pos <= 20 THEN '11-20' WHEN pos <= 50 THEN '21-50' ELSE '50+' END AS bucket, COUNT(*)::int AS n FROM q WHERE pos IS NOT NULL GROUP BY 1`,
    [projectId, k.start, k.end],
  );
  const counts = await ctx.db.one<any>(
    `SELECT
       (SELECT COUNT(*)::int FROM seo_issues WHERE project_id = $1 AND status = 'open' AND severity = 'critical') AS critical,
       (SELECT COUNT(*)::int FROM seo_issues WHERE project_id = $1 AND status = 'open' AND severity = 'high') AS high,
       (SELECT COUNT(*)::int FROM seo_issues WHERE project_id = $1 AND status = 'open') AS open_issues,
       (SELECT COUNT(*)::int FROM recommendations WHERE project_id = $1 AND status = 'pending_approval') AS pending_approvals,
       (SELECT COUNT(*)::int FROM content_briefs WHERE project_id = $1 AND status = 'pending_approval') + (SELECT COUNT(*)::int FROM content_drafts WHERE project_id = $1 AND status = 'pending_approval') AS pending_content,
       (SELECT COUNT(*)::int FROM alerts WHERE project_id = $1 AND status = 'open') AS open_alerts`,
    [projectId],
  );
  const topOpportunities = await ctx.db.query(`SELECT id, title, type, priority, priority_score, page_url, status FROM recommendations WHERE project_id = $1 AND status IN ('recommended','pending_approval') ORDER BY priority_score DESC LIMIT 6`, [projectId]);
  const alerts = await ctx.db.query(`SELECT id, severity, title, created_at FROM alerts WHERE project_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 5`, [projectId]);
  const indexable = crawl?.stats?.indexablePages ?? null;
  return {
    period: k,
    health: crawl ? { score: crawl.health_score, previous: prevCrawl?.health_score ?? null, crawledAt: crawl.started_at, grade: crawl.stats?.health?.grade, breakdown: crawl.stats?.health?.breakdown ?? [], disclaimer: crawl.stats?.health?.disclaimer } : null,
    kpis: { clicks: [k.current.clicks, k.previous.clicks], impressions: [k.current.impressions, k.previous.impressions], ctr: [k.current.ctr, k.previous.ctr], position: [k.current.position, k.previous.position], indexedPages: indexable },
    counts,
    series,
    rankingDistribution: ['1-3', '4-10', '11-20', '21-50', '50+'].map((b) => ({ bucket: b, queries: dist.find((d) => d.bucket === b)?.n ?? 0 })),
    topOpportunities,
    alerts,
    aiSummary: crawl?.stats?.aiSummary ?? null,
    hasSearchData: series.some((s) => s.impressions > 0),
  };
}

export async function performance(ctx: AppContext, projectId: string, days = 28) {
  const end = await latestGscDate(ctx.db, projectId);
  const rows = await loadGscRows(ctx, projectId, isoDate(addDays(end, -(days * 2 - 1))), end);
  const queries = comparePeriods(rows, 'query', days, end);
  const pages = comparePeriods(rows, 'page', days, end);
  const ga = await ctx.db.query(
    `SELECT landing_page, SUM(sessions)::int AS sessions, SUM(users)::int AS users, SUM(engaged_sessions)::int AS engaged, SUM(conversions)::float AS conversions
     FROM analytics_data WHERE project_id = $1 AND channel_group = 'Organic Search' AND date BETWEEN $2 AND $3 GROUP BY landing_page`,
    [projectId, isoDate(addDays(end, -(days - 1))), end],
  );
  const gaBy = new Map(ga.map((g: any) => [g.landing_page, g]));
  const k = await kpiWindow(ctx, projectId, days);
  const organic = await ctx.db.one<any>(`SELECT COALESCE(SUM(sessions),0)::int AS sessions, COALESCE(SUM(users),0)::int AS users, COALESCE(SUM(conversions),0)::float AS conversions, COALESCE(SUM(engaged_sessions),0)::int AS engaged FROM analytics_data WHERE project_id = $1 AND channel_group = 'Organic Search' AND date BETWEEN $2 AND $3`, [projectId, k.start, k.end]);
  const channels = await ctx.db.query(`SELECT channel_group, SUM(sessions)::int AS sessions FROM analytics_data WHERE project_id = $1 AND date BETWEEN $2 AND $3 GROUP BY channel_group ORDER BY 2 DESC`, [projectId, k.start, k.end]);
  const mapRow = (c: (typeof queries)[number]) => ({ key: c.key, clicks: c.current.clicks, impressions: c.current.impressions, ctr: round(c.current.ctr, 4), position: c.current.position, prevClicks: c.previous.clicks, prevImpressions: c.previous.impressions, prevPosition: c.previous.position, clicksChangePct: c.clicksChangePct, positionChange: c.positionChange, trend: c.trend, topPage: c.topPage });
  return {
    period: k,
    topQueries: queries.slice(0, 50).map(mapRow),
    risingQueries: queries.filter((q) => q.trend === 'rising' || q.trend === 'new').sort((a, b) => b.current.impressions - b.previous.impressions - (a.current.impressions - a.previous.impressions)).slice(0, 20).map(mapRow),
    decliningQueries: queries.filter((q) => q.trend === 'declining' || q.trend === 'lost').sort((a, b) => a.current.clicks - a.previous.clicks - (b.current.clicks - b.previous.clicks)).slice(0, 20).map(mapRow),
    topPages: pages.slice(0, 50).map((p) => ({ ...mapRow(p), analytics: gaBy.get(p.key) ?? null })),
    decliningPages: pages.filter((p) => p.trend === 'declining').slice(0, 20).map(mapRow),
    analytics: { organic, channels, connected: ga.length > 0 || Number(organic?.sessions) > 0 },
    windows: await Promise.all([7, 28, 90].map(async (w) => ({ days: w, ...(await kpiWindow(ctx, projectId, w)) }))),
  };
}
