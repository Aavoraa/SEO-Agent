import { addDays, isoDate } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestGscDate } from './common.js';
import { listOpportunities, nextBestAction } from './opportunities.js';

/**
 * Command Center: "what should I do next?" Every metric carries its source, freshness and data
 * label; anything without a connected source is returned as unavailable, never as a number.
 */
export interface Metric {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  unit: string;
  source: string;
  updatedAt: string | null;
  dataLabel: 'verified' | 'modeled' | 'unavailable' | 'demo';
  note?: string;
  href?: string;
}

export async function commandCenter(ctx: AppContext, projectId: string) {
  const project = await getProject(ctx, projectId);
  const label = <T extends Metric['dataLabel']>(l: T) => (project.is_demo && l !== 'unavailable' ? 'demo' : l);
  const audit = await ctx.db.one<any>(`SELECT id, overall_score, categories, created_at FROM seo_audits WHERE project_id = $1 AND device = 'desktop' ORDER BY created_at DESC LIMIT 1`, [projectId]);
  const prevAudit = audit ? await ctx.db.one<any>(`SELECT overall_score, categories FROM seo_audits WHERE project_id = $1 AND device = 'desktop' AND created_at < $2 ORDER BY created_at DESC LIMIT 1`, [projectId, audit.created_at]) : null;
  const cat = (a: any, id: string) => (a?.categories as { id: string; score: number | null }[] | undefined)?.find((c) => c.id === id)?.score ?? null;
  const auditMetric = (key: string, lbl: string, id: string | null, note?: string): Metric => ({
    key,
    label: lbl,
    value: audit ? (id ? cat(audit, id) : audit.overall_score) : null,
    previous: prevAudit ? (id ? cat(prevAudit, id) : prevAudit.overall_score) : null,
    unit: '/100',
    source: 'Site crawler (SEO audit)',
    updatedAt: audit?.created_at ?? null,
    dataLabel: audit ? label('modeled') : 'unavailable',
    note: audit ? note : 'Run an audit',
    href: '/audit',
  });

  // Search Console (28 days vs previous 28).
  const end = await latestGscDate(ctx.db, projectId);
  const gsc = await ctx.db.one<any>(
    `SELECT COALESCE(SUM(clicks) FILTER (WHERE date > $2),0)::int AS clicks, COALESCE(SUM(clicks) FILTER (WHERE date <= $2),0)::int AS prev_clicks, MAX(fetched_at) AS fetched, COUNT(*)::int AS rows
     FROM search_console_data WHERE project_id = $1 AND date > $3 AND query <> ''`,
    [projectId, isoDate(addDays(end, -28)), isoDate(addDays(end, -56))],
  );
  const hasGsc = (gsc?.rows ?? 0) > 0;
  const kv = await ctx.db.one<any>(
    `SELECT COUNT(*) FILTER (WHERE m.position <= 10)::int AS top10, COUNT(*) FILTER (WHERE m.prev_position <= 10)::int AS prev_top10, MAX(m.computed_at) AS at
     FROM keywords k JOIN LATERAL (SELECT * FROM keyword_metrics km WHERE km.keyword_id = k.id AND km.window_days = 28 ORDER BY period_end DESC LIMIT 1) m ON true WHERE k.project_id = $1`,
    [projectId],
  );
  const ga = await ctx.db.one<any>(
    `SELECT COALESCE(SUM(sessions) FILTER (WHERE date > $2),0)::int AS sessions, COALESCE(SUM(sessions) FILTER (WHERE date <= $2),0)::int AS prev_sessions,
            COALESCE(SUM(conversions) FILTER (WHERE date > $2),0)::float AS conv, COALESCE(SUM(conversions) FILTER (WHERE date <= $2),0)::float AS prev_conv, MAX(fetched_at) AS fetched, COUNT(*)::int AS rows
     FROM analytics_data WHERE project_id = $1 AND channel_group = 'Organic Search' AND date > $3`,
    [projectId, isoDate(addDays(new Date(), -29)), isoDate(addDays(new Date(), -57))],
  );
  const hasGa = (ga?.rows ?? 0) > 0;
  const bl = await ctx.db.one<any>(`SELECT COUNT(DISTINCT source_domain) FILTER (WHERE status = 'live')::int AS live, COUNT(*) FILTER (WHERE status = 'lost')::int AS lost, COUNT(*)::int AS total, MAX(last_checked_at) AS at FROM backlinks WHERE project_id = $1`, [projectId]);

  const metrics: Metric[] = [
    auditMetric('seo_health', 'SEO Health', null),
    auditMetric('ai_readiness', 'AI Search readiness', 'ai_search', 'Crawler access & structure. AI mentions/citations need the AI visibility integration.'),
    { key: 'organic_clicks', label: 'Organic clicks (28d)', value: hasGsc ? gsc.clicks : null, previous: hasGsc ? gsc.prev_clicks : null, unit: '', source: 'Google Search Console', updatedAt: gsc?.fetched ?? null, dataLabel: hasGsc ? label('verified') : 'unavailable', note: hasGsc ? undefined : 'Connect Search Console', href: '/performance' },
    { key: 'keyword_visibility', label: 'Queries in top 10', value: kv?.at ? kv.top10 : null, previous: kv?.at ? kv.prev_top10 : null, unit: '', source: 'Google Search Console (avg. position)', updatedAt: kv?.at ?? null, dataLabel: kv?.at ? label('verified') : 'unavailable', note: kv?.at ? undefined : 'Connect Search Console and run keyword discovery', href: '/keywords' },
    { key: 'organic_sessions', label: 'Organic sessions (28d)', value: hasGa ? ga.sessions : null, previous: hasGa ? ga.prev_sessions : null, unit: '', source: 'Google Analytics 4', updatedAt: ga?.fetched ?? null, dataLabel: hasGa ? label('verified') : 'unavailable', note: hasGa ? undefined : 'Connect GA4', href: '/performance' },
    { key: 'conversions', label: 'Organic conversions (28d)', value: hasGa ? Math.round(ga.conv) : null, previous: hasGa ? Math.round(ga.prev_conv) : null, unit: '', source: 'Google Analytics 4', updatedAt: ga?.fetched ?? null, dataLabel: hasGa ? label('verified') : 'unavailable', note: hasGa ? undefined : 'Connect GA4', href: '/performance' },
    auditMetric('technical', 'Technical health', 'technical'),
    auditMetric('content', 'Content health', 'content'),
    { key: 'backlinks', label: 'Live referring domains', value: bl?.total ? bl.live : null, previous: null, unit: '', source: 'Backlink import / provider, verified live', updatedAt: bl?.at ?? null, dataLabel: bl?.total ? label('verified') : 'unavailable', note: bl?.total ? `${bl.lost} lost` : 'Import your Search Console links export', href: '/backlinks' },
    auditMetric('local', 'Local visibility', 'local', 'On-site local signals. Map rankings need a local rank provider.'),
  ];

  const counts = await ctx.db.query<{ category: string; n: number }>(`SELECT category, COUNT(*)::int AS n FROM opportunities WHERE project_id = $1 AND status = 'open' GROUP BY category`, [projectId]);
  const loop = await ctx.db.one<any>(
    `SELECT (SELECT COUNT(*) FROM opportunities WHERE project_id = $1 AND status = 'open')::int AS opportunities,
            (SELECT COUNT(*) FROM recommendations WHERE project_id = $1 AND status IN ('recommended','pending_approval'))::int AS awaiting_decision,
            (SELECT COUNT(*) FROM seo_changes WHERE project_id = $1 AND status IN ('approved','deploying'))::int AS approved,
            (SELECT COUNT(*) FROM seo_changes WHERE project_id = $1 AND (deployed_at IS NOT NULL OR implemented_at IS NOT NULL))::int AS deployed,
            (SELECT COUNT(*) FROM seo_changes WHERE project_id = $1 AND verified_at IS NOT NULL)::int AS verified,
            (SELECT COUNT(*) FROM experiments WHERE project_id = $1 AND status IN ('completed','inconclusive'))::int AS measured,
            (SELECT COUNT(*) FROM opportunities WHERE project_id = $1 AND status = 'done')::int AS resolved`,
    [projectId],
  );
  return {
    project: { id: project.id, name: project.name, isDemo: project.is_demo, automationLevel: (project.settings as { automation?: { level?: number } }).automation?.level ?? 2 },
    metrics,
    nextBestAction: await nextBestAction(ctx, projectId),
    opportunities: await listOpportunities(ctx, projectId, { limit: 10 }),
    categoryCounts: Object.fromEntries(counts.map((c) => [c.category, c.n])),
    loop,
  };
}
