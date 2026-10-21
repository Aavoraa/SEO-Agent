import { deterministicExecutive, renderReportHtml, renderReportMarkdown, type Kpi, type ReportData, type ReportSection } from '@phoenixx/reporting-engine';
import { dispatch } from '@phoenixx/integrations';
import { round } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestCrawl, primaryWebsite } from './common.js';
import { kpiWindow, performance } from './analytics.js';

async function commonCounts(ctx: AppContext, projectId: string, since: string) {
  return ctx.db.one<any>(
    `SELECT (SELECT COUNT(*)::int FROM seo_issues WHERE project_id = $1 AND status = 'open' AND severity = 'critical') AS critical,
            (SELECT COUNT(*)::int FROM seo_issues WHERE project_id = $1 AND status = 'resolved' AND resolved_at >= $2) AS resolved,
            (SELECT COUNT(*)::int FROM recommendations WHERE project_id = $1 AND created_at >= $2) AS new_recs,
            (SELECT COUNT(*)::int FROM content_opportunities WHERE project_id = $1 AND created_at >= $2) AS new_content,
            (SELECT COUNT(*)::int FROM seo_changes WHERE project_id = $1 AND implemented_at >= $2) AS implemented`,
    [projectId, since],
  );
}

async function issueSection(ctx: AppContext, projectId: string): Promise<ReportSection> {
  const bySev = await ctx.db.query<{ severity: string; n: number }>(`SELECT severity, COUNT(*)::int AS n FROM seo_issues WHERE project_id = $1 AND status = 'open' GROUP BY severity`, [projectId]);
  const top = await ctx.db.query<any>(`SELECT rule_id, severity, MIN(title) AS title, COUNT(*)::int AS n FROM seo_issues WHERE project_id = $1 AND status = 'open' AND severity IN ('critical','high','medium') GROUP BY rule_id, severity ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, n DESC LIMIT 10`, [projectId]);
  return {
    title: 'Technical SEO',
    intro: `Open issues – ${['critical', 'high', 'medium', 'low'].map((s) => `${s}: ${bySev.find((b) => b.severity === s)?.n ?? 0}`).join(', ')}.`,
    columns: ['Issue', 'Severity', 'Pages'],
    rows: top.map((t) => ({ label: t.title, values: [t.severity.toUpperCase(), t.n] })),
  };
}

/** Weekly SEO Report (workflow 8). Written for a business owner; AI drafts the summary only from the numbers shown. */
export async function generateWeeklyReport(ctx: AppContext, projectId: string, input: { send?: boolean; correlationId?: string } = {}) {
  const project = await getProject(ctx, projectId);
  const website = await primaryWebsite(ctx, projectId);
  const k = await kpiWindow(ctx, projectId, 7);
  const perf = await performance(ctx, projectId, 7);
  const crawl = await latestCrawl(ctx, website.id);
  const prevCrawl = crawl ? await ctx.db.one<{ health_score: number; stats: any }>(`SELECT health_score, stats FROM crawl_runs WHERE website_id = $1 AND status = 'completed' AND started_at < now() - interval '6 days' ORDER BY started_at DESC LIMIT 1`, [website.id]) : null;
  const counts = await commonCounts(ctx, projectId, k.start);
  const kpis: Kpi[] = [
    { label: 'Organic clicks', current: k.current.clicks, previous: k.previous.clicks, format: 'int' },
    { label: 'Impressions', current: k.current.impressions, previous: k.previous.impressions, format: 'int' },
    { label: 'CTR', current: k.current.ctr, previous: k.previous.ctr, format: 'pct' },
    { label: 'Average position', current: k.current.position, previous: k.previous.position, format: 'pos', lowerIsBetter: true },
    { label: 'Indexable pages', current: crawl?.stats?.indexablePages ?? null, previous: prevCrawl?.stats?.indexablePages ?? null, format: 'int' },
    { label: 'SEO health (internal)', current: crawl?.health_score ?? null, previous: prevCrawl?.health_score ?? null, format: 'score' },
    { label: 'Critical issues', current: counts.critical, previous: null, format: 'int', lowerIsBetter: true },
    { label: 'Resolved issues', current: counts.resolved, previous: null, format: 'int' },
  ];
  const changes = await ctx.db.query<any>(`SELECT change_type, page_url, status, implemented_at FROM seo_changes WHERE project_id = $1 AND implemented_at >= $2 ORDER BY implemented_at`, [projectId, k.start]);
  const recs = await ctx.db.query<any>(`SELECT title, priority, page_url FROM recommendations WHERE project_id = $1 AND status IN ('recommended','pending_approval') ORDER BY priority_score DESC LIMIT 8`, [projectId]);
  const content = await ctx.db.query<any>(`SELECT title, type, priority FROM content_opportunities WHERE project_id = $1 AND status = 'open' ORDER BY score DESC LIMIT 6`, [projectId]);
  const q = (r: any) => ({ label: r.key, values: [r.clicks, r.impressions, `${round(r.ctr * 100, 1)}%`, r.position ?? '—'] });
  const sections: ReportSection[] = [
    { title: 'Top pages', columns: ['Page', 'Clicks', 'Impressions', 'CTR', 'Position'], rows: perf.topPages.slice(0, 8).map((p) => ({ ...q(p), label: new URL(p.key).pathname, url: p.key })) },
    { title: 'Top search queries', columns: ['Query', 'Clicks', 'Impressions', 'CTR', 'Position'], rows: perf.topQueries.slice(0, 10).map(q) },
    { title: 'Rising queries', intro: 'Queries gaining impressions or clicks vs the previous week.', columns: ['Query', 'Clicks', 'Impressions', 'CTR', 'Position'], rows: perf.risingQueries.slice(0, 8).map(q) },
    { title: 'Declining queries', intro: 'Queries losing clicks vs the previous week – check the landing page if the drop persists.', columns: ['Query', 'Clicks', 'Impressions', 'CTR', 'Position'], rows: perf.decliningQueries.slice(0, 8).map(q) },
    await issueSection(ctx, projectId),
    { title: 'Content', intro: 'Pages needing updates and new content opportunities (evidence-based; volumes from Search Console impressions only).', columns: ['Opportunity', 'Type', 'Priority'], rows: content.map((c) => ({ label: c.title, values: [c.type.replace(/_/g, ' '), c.priority] })) },
    { title: 'Changes implemented this week', bullets: changes.map((c) => `${c.change_type.replace('_', ' ')} on ${c.page_url ? new URL(c.page_url).pathname : 'site'} (${c.status})`) },
    { title: 'Highest-priority recommendations', bullets: recs.map((r) => `[${r.priority.toUpperCase()}] ${r.title}`) },
  ];
  let executive = deterministicExecutive(kpis, { criticalIssues: counts.critical, resolvedIssues: counts.resolved, newOpportunities: counts.new_recs + counts.new_content, changesImplemented: counts.implemented });
  executive.nextActions = recs.slice(0, 5).map((r) => r.title);
  if (ctx.ai.enabled && perf.topQueries.length) {
    try {
      const r = await ctx.ai.run(
        'weekly-report',
        { period: `${k.start} to ${k.end}`, kpis: kpis.map((x) => ({ label: x.label, current: x.current, previous: x.previous })), movers: { rising: perf.risingQueries.slice(0, 5), declining: perf.decliningQueries.slice(0, 5) }, issues: sections[4], changes, recommendations: recs },
        { projectId, correlationId: input.correlationId },
      );
      executive = { ...r.data, aiGenerated: true };
    } catch (e) {
      ctx.log.warn('report.ai_failed', { error: (e as Error).message });
    }
  }
  const data: ReportData = {
    title: `Weekly SEO report · ${k.start} – ${k.end}`,
    siteUrl: website.base_url,
    periodLabel: `${k.start} to ${k.end} vs ${k.prevStart} to ${k.prevEnd}`,
    generatedAt: new Date().toISOString(),
    isDemo: project.is_demo,
    dataNotes: [
      'Search Console data lags 2–3 days; anonymised queries are included in totals but not in query tables.',
      'Search volume is not shown because Search Console does not provide it; impressions are used as the demand signal.',
      'The SEO health score is an internal diagnostic, not a Google metric. Ranking changes after site changes are correlations, not proof of cause.',
    ],
    executive,
    kpis,
    sections,
    dashboardUrl: ctx.cfg.FRONTEND_URL,
  };
  const html = renderReportHtml(data);
  const markdown = renderReportMarkdown(data);
  const row = await ctx.db.one<{ id: string }>(`INSERT INTO reports(project_id, type, title, period_start, period_end, summary, data, html, markdown, ai_generated) VALUES ($1,'weekly',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [projectId, data.title, k.start, k.end, executive.summary, data, html, markdown, executive.aiGenerated]);
  let sent: unknown[] = [];
  if (input.send !== false) {
    const email = ctx.notifiers.filter((n) => n.channel === 'email');
    if (email.length) {
      sent = await dispatch(email, { severity: 'info', title: data.title, message: executive.headline, html }, { email: 'info' });
      await ctx.db.query('UPDATE reports SET sent_to = $2 WHERE id = $1', [row!.id, sent]);
    }
  }
  return { reportId: row!.id, title: data.title, sent, aiGenerated: executive.aiGenerated };
}

/** Initial SEO report after the first crawl (first-run experience). */
export async function generateInitialReport(ctx: AppContext, projectId: string) {
  const project = await getProject(ctx, projectId);
  const website = await primaryWebsite(ctx, projectId);
  const crawl = await latestCrawl(ctx, website.id);
  if (!crawl) throw new Error('Run the initial crawl first');
  const byCat = await ctx.db.query<any>(`SELECT category, severity, COUNT(*)::int AS n FROM seo_issues WHERE project_id = $1 AND status = 'open' GROUP BY 1,2`, [projectId]);
  const cat = (c: string) => byCat.filter((b) => b.category === c).reduce((s, b) => s + b.n, 0);
  const topIssues = (c: string[]) => ctx.db.query<any>(`SELECT MIN(title) AS title, severity, COUNT(*)::int AS n FROM seo_issues WHERE project_id = $1 AND status = 'open' AND category = ANY($2::text[]) AND severity <> 'info' GROUP BY rule_id, severity ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, n DESC LIMIT 8`, [projectId, c]);
  const recs = (source: string[]) => ctx.db.query<any>(`SELECT title, priority FROM recommendations WHERE project_id = $1 AND source = ANY($2::text[]) AND status IN ('recommended','pending_approval') ORDER BY priority_score DESC LIMIT 8`, [projectId, source]);
  const kw = await ctx.db.query<any>(`SELECT keyword, opportunity_score FROM keywords WHERE project_id = $1 AND source = 'gsc' ORDER BY opportunity_score DESC LIMIT 8`, [projectId]);
  const priority = await ctx.db.query<any>(`SELECT title, priority, why FROM recommendations WHERE project_id = $1 AND status IN ('recommended','pending_approval') ORDER BY priority_score DESC LIMIT 10`, [projectId]);
  const toRows = (xs: any[]) => xs.map((x) => ({ label: x.title, values: [x.severity?.toUpperCase() ?? x.priority?.toUpperCase(), x.n ?? ''] }));
  const ai = crawl.stats?.aiSummary && !crawl.stats.aiSummary.error ? crawl.stats.aiSummary : null;
  const data: ReportData = {
    title: 'Initial SEO health report',
    siteUrl: website.base_url,
    periodLabel: `Crawl of ${new Date(crawl.started_at).toISOString().slice(0, 10)} · ${crawl.stats?.pagesCrawled ?? '?'} URLs`,
    generatedAt: new Date().toISOString(),
    isDemo: project.is_demo,
    dataNotes: [crawl.stats?.health?.disclaimer ?? 'The SEO health score is an internal diagnostic score, not a Google ranking metric.', 'Keyword and local opportunities appear once Search Console data is connected.'],
    executive: ai ? { headline: `SEO health (internal diagnostic): ${crawl.health_score}/100`, summary: ai.summary, wins: [], concerns: (ai.watchouts ?? []).slice(0, 5), nextActions: (ai.topPriorities ?? []).map((p: any) => p.what).slice(0, 5), aiGenerated: true } : { headline: `SEO health (internal diagnostic): ${crawl.health_score}/100`, summary: `The crawl found ${cat('technical')} technical, ${cat('content')} content, ${cat('schema')} structured-data, ${cat('internal_linking')} internal-linking and ${cat('local')} local SEO issues. Fix high-severity items first; most are quick, low-risk edits.`, wins: [], concerns: [], nextActions: priority.slice(0, 5).map((p) => p.title), aiGenerated: false },
    kpis: [
      { label: 'SEO health (internal)', current: crawl.health_score, previous: null, format: 'score' },
      { label: 'URLs crawled', current: crawl.stats?.pagesCrawled ?? null, previous: null, format: 'int' },
      { label: 'Indexable pages', current: crawl.stats?.indexablePages ?? null, previous: null, format: 'int' },
      { label: 'Critical + high issues', current: byCat.filter((b) => ['critical', 'high'].includes(b.severity)).reduce((s, b) => s + b.n, 0), previous: null, format: 'int', lowerIsBetter: true },
    ],
    sections: [
      { title: 'Technical issues', columns: ['Issue', 'Severity', 'Count'], rows: toRows(await topIssues(['technical', 'performance'])) },
      { title: 'Content issues', columns: ['Issue', 'Severity', 'Count'], rows: toRows(await topIssues(['content', 'schema'])) },
      { title: 'Keyword opportunities', intro: kw.length ? 'Queries with the best opportunity score (from Search Console).' : 'Connect Search Console to discover keyword opportunities from real search data.', columns: ['Query', 'Opportunity score'], rows: kw.map((k) => ({ label: k.keyword, values: [k.opportunity_score] })) },
      { title: 'Local SEO opportunities', rows: toRows([...(await topIssues(['local'])), ...(await recs(['local']))]) },
      { title: 'Internal linking opportunities', rows: toRows([...(await topIssues(['internal_linking'])), ...(await recs(['internal_linking']))]) },
      { title: 'Priority actions', bullets: priority.map((p) => `[${p.priority.toUpperCase()}] ${p.title}`) },
    ],
    dashboardUrl: ctx.cfg.FRONTEND_URL,
  };
  const row = await ctx.db.one<{ id: string }>(`INSERT INTO reports(project_id, type, title, summary, data, html, markdown, ai_generated) VALUES ($1,'initial',$2,$3,$4,$5,$6,$7) RETURNING id`, [projectId, data.title, data.executive.summary, data, renderReportHtml(data), renderReportMarkdown(data), data.executive.aiGenerated]);
  await ctx.db.query(`UPDATE projects SET onboarding = onboarding || '{"initialReport": true}'::jsonb WHERE id = $1`, [projectId]);
  return { reportId: row!.id };
}
