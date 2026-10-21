import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Where } from '@phoenixx/database';
import { AppError, addDays, isoDate } from '@phoenixx/shared';
import { listRules } from '@phoenixx/seo-engine';
import type { AppContext } from '../context.js';
import { pageQuery, parse, requireActor, sendCsv } from '../http.js';
import { getProject, latestGscDate, primaryWebsite, profileOf } from '../services/common.js';
import { overview, performance } from '../services/analytics.js';
import { localOverview } from '../services/local.js';
import { competitorComparison } from '../services/competitors.js';
import { backlinkOverview } from '../services/backlinks.js';
import { actorForProject, visibleProjectIds } from '../services/access.js';
import { aiReadiness, integrationCatalog } from '../services/integrations.js';
import { setupStatus } from '../services/projects.js';
import { loadGscRows } from '../services/alerts.js';
import { comparePeriods } from '@phoenixx/keyword-engine';

type P = { projectId: string };

export async function dataRoutes(app: FastifyInstance, ctx: AppContext) {
  // Every project route requires an authenticated actor and an existing project.
  app.addHook('preHandler', async (req) => {
    const pid = (req.params as Partial<P>)?.projectId;
    if (pid && req.routeOptions.url?.startsWith('/api/projects/:projectId')) {
      const actor = requireActor(req);
      if (!/^[0-9a-f-]{36}$/i.test(pid)) throw new AppError('Invalid project id', 400, 'validation');
      // From here on the actor's role is its role in THIS project (see services/access.ts).
      req.actor = await actorForProject(ctx, actor, pid);
      await getProject(ctx, pid);
    }
  });

  app.get('/api/projects', async (req) => {
    const ids = await visibleProjectIds(ctx, requireActor(req));
    return ctx.db.query(
      `SELECT p.id, p.name, p.slug, p.is_demo, p.created_at, w.base_url, p.organization_id, o.name AS organization_name, o.branding AS organization_branding FROM projects p LEFT JOIN websites w ON w.project_id = p.id AND w.is_primary LEFT JOIN organizations o ON o.id = p.organization_id
       WHERE $1::uuid[] IS NULL OR p.id = ANY($1::uuid[]) ORDER BY p.created_at`,
      [ids],
    );
  });

  app.get('/api/projects/:projectId', async (req) => {
    const { projectId } = req.params as P;
    const p = await getProject(ctx, projectId);
    const websites = await ctx.db.query('SELECT * FROM websites WHERE project_id = $1 ORDER BY is_primary DESC', [projectId]);
    return { ...p, businessProfile: profileOf(p), websites, myRole: req.actor!.role };
  });

  app.get('/api/projects/:projectId/setup-status', async (req) => setupStatus(ctx, (req.params as P).projectId));

  app.get('/api/projects/:projectId/overview', async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(7).max(180).default(28) }), req.query);
    return overview(ctx, (req.params as P).projectId, q.days);
  });

  app.get('/api/projects/:projectId/performance', async (req) => {
    const q = parse(z.object({ days: z.coerce.number().int().min(7).max(180).default(28) }), req.query);
    return performance(ctx, (req.params as P).projectId, q.days);
  });

  /* ── Issues ── */
  app.get('/api/projects/:projectId/issues', async (req, reply) => {
    const { projectId } = req.params as P;
    const q = parse(
      pageQuery.extend({
        severity: z.string().optional(),
        category: z.string().optional(),
        status: z.string().default('open'),
        rule: z.string().optional(),
        page: z.string().optional(),
        q: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        format: z.enum(['json', 'csv']).default('json'),
      }),
      req.query,
    );
    const w = new Where(['i.project_id = ?', projectId]);
    if (q.status !== 'all') w.add('i.status = ANY(?::text[])', q.status.split(','));
    if (q.severity) w.add('i.severity = ANY(?::text[])', q.severity.split(','));
    if (q.category) w.add('i.category = ANY(?::text[])', q.category.split(','));
    w.addIf(q.rule, 'i.rule_id = ?', q.rule);
    w.addIf(q.page, 'i.url ILIKE ?', `%${q.page}%`);
    w.addIf(q.q, '(i.title ILIKE ? OR i.description ILIKE ?)', `%${q.q}%`, `%${q.q}%`);
    w.addIf(q.from, 'i.last_detected_at >= ?::date', q.from);
    w.addIf(q.to, 'i.first_detected_at < (?::date + 1)', q.to);
    const rows = await ctx.db.query(
      `SELECT i.*, r.id AS recommendation_id, r.status AS recommendation_status, r.proposed_value, r.current_value, r.risk
       FROM seo_issues i LEFT JOIN LATERAL (SELECT * FROM recommendations r WHERE r.issue_id = i.id ORDER BY r.created_at DESC LIMIT 1) r ON true
       ${w} ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, i.last_detected_at DESC
       LIMIT ${q.format === 'csv' ? 10000 : q.limit} OFFSET ${q.offset}`,
      w.params,
    );
    const summary = await ctx.db.query(`SELECT severity, category, COUNT(*)::int AS n FROM seo_issues WHERE project_id = $1 AND status = 'open' GROUP BY 1,2`, [projectId]);
    if (q.format === 'csv') return sendCsv(reply, 'seo-issues.csv', rows.map((r: any) => ({ severity: r.severity, category: r.category, rule: r.rule_id, title: r.title, url: r.url, description: r.description, recommendation: r.recommendation, status: r.status, first_detected: r.first_detected_at })));
    return { items: rows, summary, rules: listRules((await getProject(ctx, projectId)).settings?.rules).map((r) => ({ id: r.id, title: r.title, category: r.category })) };
  });

  app.get('/api/projects/:projectId/crawls', async (req) => {
    const site = await primaryWebsite(ctx, (req.params as P).projectId);
    return ctx.db.query(`SELECT id, status, trigger, started_at, finished_at, pages_crawled, pages_failed, health_score, error, stats->'issues' AS issues, stats->'aiSummary' AS ai_summary FROM crawl_runs WHERE website_id = $1 ORDER BY started_at DESC LIMIT 30`, [site.id]);
  });

  /* ── Pages ── */
  app.get('/api/projects/:projectId/pages', async (req) => {
    const { projectId } = req.params as P;
    const end = await latestGscDate(ctx.db, projectId);
    return ctx.db.query(
      `SELECT p.id, p.url, p.path, p.page_type, p.is_important, p.status_code, p.title, p.meta_description, p.h1, p.word_count, p.indexable, p.in_sitemap, p.inlinks, p.last_seen_at, p.removed_at,
         (SELECT COUNT(*)::int FROM seo_issues i WHERE i.page_id = p.id AND i.status = 'open') AS open_issues,
         (SELECT COUNT(*)::int FROM seo_issues i WHERE i.page_id = p.id AND i.status = 'open' AND i.severity IN ('critical','high')) AS serious_issues,
         g.clicks, g.impressions, g.position
       FROM pages p JOIN websites w ON w.id = p.website_id
       LEFT JOIN LATERAL (SELECT SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions, ROUND((SUM(position*impressions)/NULLIF(SUM(impressions),0))::numeric,1)::float AS position
                          FROM search_console_data s WHERE s.project_id = w.project_id AND s.page = p.url AND s.query <> '' AND s.date > $2::date - 28) g ON true
       WHERE w.project_id = $1 ORDER BY p.removed_at NULLS FIRST, p.is_important DESC, g.clicks DESC NULLS LAST, p.path`,
      [projectId, end],
    );
  });

  app.get('/api/projects/:projectId/pages/:pageId', async (req) => {
    const { projectId, pageId } = req.params as P & { pageId: string };
    const page = await ctx.db.one<any>(`SELECT p.* FROM pages p JOIN websites w ON w.id = p.website_id WHERE w.project_id = $1 AND p.id = $2`, [projectId, pageId]);
    if (!page) throw new AppError('Page not found', 404, 'not_found');
    const latest = page.last_crawl_result_id ? await ctx.db.one('SELECT * FROM crawl_results WHERE id = $1', [page.last_crawl_result_id]) : null;
    const end = await latestGscDate(ctx.db, projectId);
    const [issues, recs, queries, changes, history, analytics] = await Promise.all([
      ctx.db.query(`SELECT * FROM seo_issues WHERE page_id = $1 AND status <> 'resolved' ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`, [pageId]),
      ctx.db.query(`SELECT * FROM recommendations WHERE project_id = $1 AND page_url = $2 ORDER BY priority_score DESC`, [projectId, page.url]),
      ctx.db.query(`SELECT query, SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions, ROUND((SUM(position*impressions)/NULLIF(SUM(impressions),0))::numeric,1)::float AS position FROM search_console_data WHERE project_id = $1 AND page = $2 AND query <> '' AND date > $3::date - 90 GROUP BY query ORDER BY impressions DESC LIMIT 50`, [projectId, page.url, end]),
      ctx.db.query(`SELECT * FROM seo_changes WHERE project_id = $1 AND page_url = $2 ORDER BY created_at DESC`, [projectId, page.url]),
      ctx.db.query(`SELECT date::text, SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions FROM search_console_data WHERE project_id = $1 AND page = $2 AND query <> '' AND date > $3::date - 90 GROUP BY date ORDER BY date`, [projectId, page.url, end]),
      ctx.db.query(`SELECT SUM(sessions)::int AS sessions, SUM(engaged_sessions)::int AS engaged, SUM(conversions)::float AS conversions FROM analytics_data WHERE project_id = $1 AND landing_page = $2 AND channel_group = 'Organic Search' AND date > $3::date - 28`, [projectId, page.url, end]),
    ]);
    return { page, latest, issues, recommendations: recs, queries, changes, history, analytics: analytics[0] ?? null };
  });

  /* ── Keywords ── */
  app.get('/api/projects/:projectId/keywords', async (req, reply) => {
    const { projectId } = req.params as P;
    const q = parse(
      pageQuery.extend({
        intent: z.string().optional(),
        service: z.string().optional(),
        location: z.string().optional(),
        type: z.string().optional(),
        source: z.string().default('gsc'),
        minPos: z.coerce.number().optional(),
        maxPos: z.coerce.number().optional(),
        minOpportunity: z.coerce.number().optional(),
        trend: z.string().optional(),
        q: z.string().optional(),
        clusterId: z.string().uuid().optional(),
        sort: z.enum(['opportunity', 'impressions', 'clicks', 'position']).default('opportunity'),
        window: z.coerce.number().int().refine((v) => [7, 28, 90].includes(v)).default(28),
        format: z.enum(['json', 'csv']).default('json'),
      }),
      req.query,
    );
    const w = new Where(['k.project_id = ?', projectId]);
    if (q.source !== 'all') w.add('k.source = ANY(?::text[])', q.source.split(','));
    if (q.intent) w.add('k.intent = ANY(?::text[])', q.intent.split(','));
    if (q.type) w.add('k.keyword_type = ANY(?::text[])', q.type.split(','));
    w.addIf(q.service, '? = ANY(k.services)', q.service);
    w.addIf(q.location, '? = ANY(k.locations)', q.location);
    w.addIf(q.minPos, 'm.position >= ?', q.minPos);
    w.addIf(q.maxPos, 'm.position <= ?', q.maxPos);
    w.addIf(q.minOpportunity, 'k.opportunity_score >= ?', q.minOpportunity);
    w.addIf(q.trend, 'm.trend = ?', q.trend);
    w.addIf(q.q, 'k.keyword ILIKE ?', `%${q.q}%`);
    w.addIf(q.clusterId, 'k.cluster_id = ?', q.clusterId);
    const order = { opportunity: 'k.opportunity_score DESC', impressions: 'm.impressions DESC NULLS LAST', clicks: 'm.clicks DESC NULLS LAST', position: 'm.position ASC NULLS LAST' }[q.sort];
    const win = w.next(q.window);
    const rows = await ctx.db.query(
      `SELECT k.id, k.keyword, k.intent, k.intent_confidence, k.intent_source, k.keyword_type, k.services, k.locations, k.source, k.search_volume, k.search_volume_source, k.target_page_url, k.is_branded,
              k.user_problem, k.expected_content, k.recommended_page_type, k.recommended_cta, k.opportunity_score, k.opportunity_reasons, k.cluster_id, c.name AS cluster_name,
              m.clicks, m.impressions, m.ctr, m.position, m.prev_clicks, m.prev_impressions, m.prev_position, m.trend, m.top_page
       FROM keywords k LEFT JOIN keyword_clusters c ON c.id = k.cluster_id
       LEFT JOIN LATERAL (SELECT * FROM keyword_metrics km WHERE km.keyword_id = k.id AND km.window_days = ${win} ORDER BY period_end DESC LIMIT 1) m ON true
       ${w} ORDER BY ${order} LIMIT ${q.format === 'csv' ? 20000 : q.limit} OFFSET ${q.offset}`,
      w.params,
    );
    if (q.format === 'csv') return sendCsv(reply, 'keywords.csv', rows.map((r: any) => ({ keyword: r.keyword, intent: r.intent, type: r.keyword_type, position: r.position, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, trend: r.trend, target_page: r.target_page_url, opportunity: r.opportunity_score, cluster: r.cluster_name, search_volume: r.search_volume ?? 'unavailable' })));
    const total = await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM keywords k LEFT JOIN LATERAL (SELECT * FROM keyword_metrics km WHERE km.keyword_id = k.id AND km.window_days = ${win} ORDER BY period_end DESC LIMIT 1) m ON true ${w}`, w.params);
    const profile = profileOf(await getProject(ctx, projectId));
    return { items: rows, total: total?.n ?? 0, filters: { services: profile.services.map((s) => ({ id: s.id, name: s.name })), locations: profile.locations.map((l) => ({ id: l.id, name: l.name })) }, note: 'Search volume is unavailable from Search Console; impressions are the demand signal.' };
  });

  app.get('/api/projects/:projectId/keyword-clusters', async (req) => {
    const { projectId } = req.params as P;
    return ctx.db.query(`SELECT c.*, (SELECT COUNT(*)::int FROM keywords k WHERE k.cluster_id = c.id) AS keyword_count, (SELECT array_agg(keyword ORDER BY opportunity_score DESC) FROM (SELECT keyword, opportunity_score FROM keywords k WHERE k.cluster_id = c.id ORDER BY opportunity_score DESC LIMIT 6) t) AS top_keywords FROM keyword_clusters c WHERE c.project_id = $1 ORDER BY c.opportunity_score DESC LIMIT 200`, [projectId]);
  });

  /* ── Content ── */
  app.get('/api/projects/:projectId/content', async (req) => {
    const { projectId } = req.params as P;
    const [opportunities, briefs, drafts, refresh] = await Promise.all([
      ctx.db.query(`SELECT * FROM content_opportunities WHERE project_id = $1 AND status <> 'dismissed' ORDER BY score DESC LIMIT 200`, [projectId]),
      ctx.db.query(`SELECT b.id, b.target_keyword, b.status, b.created_at, b.ai_model, b.opportunity_id, b.brief FROM content_briefs b WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, [projectId]),
      ctx.db.query(`SELECT id, brief_id, title, slug, status, quality_score, quality_report->>'verdict' AS verdict, version, created_at, ai_model FROM content_drafts WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, [projectId]),
      ctx.db.query(`SELECT * FROM content_opportunities WHERE project_id = $1 AND type IN ('refresh','declining') AND status = 'open' ORDER BY score DESC`, [projectId]),
    ]);
    return { opportunities, briefs, drafts, needsRefresh: refresh.filter((r: any) => r.type === 'refresh'), declining: refresh.filter((r: any) => r.type === 'declining'), published: drafts.filter((d: any) => d.status === 'published') };
  });

  app.get('/api/projects/:projectId/content/drafts/:id', async (req) => {
    const { projectId, id } = req.params as P & { id: string };
    const d = await ctx.db.one('SELECT * FROM content_drafts WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!d) throw new AppError('Draft not found', 404, 'not_found');
    return d;
  });

  app.get('/api/projects/:projectId/content/briefs/:id', async (req) => {
    const { projectId, id } = req.params as P & { id: string };
    const b = await ctx.db.one('SELECT * FROM content_briefs WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!b) throw new AppError('Brief not found', 404, 'not_found');
    return b;
  });

  /* ── Internal links / local / competitors ── */
  app.get('/api/projects/:projectId/internal-links', async (req) => {
    const { projectId } = req.params as P;
    const site = await primaryWebsite(ctx, projectId);
    const [opps, pages] = await Promise.all([
      ctx.db.query(`SELECT * FROM internal_link_opportunities WHERE project_id = $1 AND status <> 'dismissed' ORDER BY score DESC LIMIT 300`, [projectId]),
      ctx.db.query(`SELECT url, path, title, inlinks, is_important, indexable, page_type FROM pages WHERE website_id = $1 AND removed_at IS NULL AND status_code = 200 ORDER BY inlinks`, [site.id]),
    ]);
    return { opportunities: opps, pages, orphans: pages.filter((p: any) => p.inlinks === 0 && p.path !== '/' && p.indexable), weak: pages.filter((p: any) => p.is_important && p.inlinks > 0 && p.inlinks < 3) };
  });

  app.get('/api/projects/:projectId/local', async (req) => localOverview(ctx, (req.params as P).projectId));

  app.get('/api/projects/:projectId/competitors', async (req) => {
    const { projectId } = req.params as P;
    return ctx.db.query(`SELECT c.*, (SELECT COUNT(*)::int FROM competitor_pages cp WHERE cp.competitor_id = c.id) AS pages FROM competitors c WHERE project_id = $1 ORDER BY created_at`, [projectId]);
  });

  app.get('/api/projects/:projectId/backlinks', async (req) => backlinkOverview(ctx, (req.params as P).projectId));
  app.get('/api/projects/:projectId/integrations/catalog', async (req) => integrationCatalog(ctx, (req.params as P).projectId));
  app.get('/api/projects/:projectId/ai-readiness', async (req) => aiReadiness(ctx, (req.params as P).projectId));

  app.get('/api/projects/:projectId/competitors/comparison', async (req) => competitorComparison(ctx, (req.params as P).projectId));

  /* ── Recommendations & approvals ── */
  app.get('/api/projects/:projectId/recommendations', async (req) => {
    const { projectId } = req.params as P;
    const q = parse(pageQuery.extend({ status: z.string().default('recommended,pending_approval'), type: z.string().optional(), priority: z.string().optional(), source: z.string().optional(), risk: z.string().optional(), page: z.string().optional() }), req.query);
    const w = new Where(['project_id = ?', projectId]);
    if (q.status !== 'all') w.add('status = ANY(?::text[])', q.status.split(','));
    if (q.type) w.add('type = ANY(?::text[])', q.type.split(','));
    if (q.priority) w.add('priority = ANY(?::text[])', q.priority.split(','));
    if (q.source) w.add('source = ANY(?::text[])', q.source.split(','));
    if (q.risk) w.add('risk = ANY(?::text[])', q.risk.split(','));
    w.addIf(q.page, 'page_url ILIKE ?', `%${q.page}%`);
    const items = await ctx.db.query(`SELECT * FROM recommendations ${w} ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, priority_score DESC LIMIT ${q.limit} OFFSET ${q.offset}`, w.params);
    const counts = await ctx.db.query(`SELECT status, COUNT(*)::int AS n FROM recommendations WHERE project_id = $1 GROUP BY status`, [projectId]);
    return { items, counts };
  });

  app.get('/api/projects/:projectId/recommendations/:id', async (req) => {
    const { projectId, id } = req.params as P & { id: string };
    const r = await ctx.db.one('SELECT * FROM recommendations WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!r) throw new AppError('Recommendation not found', 404, 'not_found');
    const approvals = await ctx.db.query('SELECT * FROM approvals WHERE recommendation_id = $1 ORDER BY created_at', [id]);
    const changes = await ctx.db.query('SELECT * FROM seo_changes WHERE recommendation_id = $1 ORDER BY created_at', [id]);
    return { ...r, approvals, changes };
  });

  app.get('/api/projects/:projectId/approvals', async (req) => {
    const { projectId } = req.params as P;
    const [recs, briefs, drafts, recent] = await Promise.all([
      ctx.db.query(`SELECT * FROM recommendations WHERE project_id = $1 AND status = 'pending_approval' ORDER BY CASE risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, priority_score DESC`, [projectId]),
      ctx.db.query(`SELECT id, target_keyword, brief, created_at, ai_model FROM content_briefs WHERE project_id = $1 AND status = 'pending_approval' ORDER BY created_at`, [projectId]),
      ctx.db.query(`SELECT id, title, quality_score, quality_report, created_at, ai_model FROM content_drafts WHERE project_id = $1 AND status = 'pending_approval' ORDER BY created_at`, [projectId]),
      ctx.db.query(`SELECT a.*, r.title AS recommendation_title FROM approvals a LEFT JOIN recommendations r ON r.id = a.recommendation_id WHERE a.project_id = $1 ORDER BY a.created_at DESC LIMIT 30`, [projectId]),
    ]);
    return { recommendations: recs, briefs, drafts, recentDecisions: recent, total: recs.length + briefs.length + drafts.length };
  });

  /* ── Changes, change log, experiments ── */
  app.get('/api/projects/:projectId/changes', async (req) => {
    const { projectId } = req.params as P;
    const q = parse(z.object({ status: z.string().optional() }), req.query);
    const w = new Where(['c.project_id = ?', projectId]);
    if (q.status) w.add('c.status = ANY(?::text[])', q.status.split(','));
    return ctx.db.query(`SELECT c.*, u.email AS reviewer_email, r.title AS recommendation_title FROM seo_changes c LEFT JOIN users u ON u.id = c.reviewer_id LEFT JOIN recommendations r ON r.id = c.recommendation_id ${w} ORDER BY c.created_at DESC LIMIT 300`, w.params);
  });

  app.get('/api/projects/:projectId/changes/:id', async (req, reply) => {
    const { projectId, id } = req.params as P & { id: string };
    const q = parse(z.object({ format: z.enum(['json', 'csv', 'md']).default('json') }), req.query);
    const c = await ctx.db.one<any>(`SELECT c.*, u.email AS reviewer_email FROM seo_changes c LEFT JOIN users u ON u.id = c.reviewer_id WHERE c.id = $1 AND c.project_id = $2`, [id, projectId]);
    if (!c) throw new AppError('Change not found', 404, 'not_found');
    const events = await ctx.db.query('SELECT * FROM change_events WHERE change_id = $1 ORDER BY created_at', [id]);
    const experiment = await ctx.db.one('SELECT * FROM experiments WHERE change_id = $1 ORDER BY created_at DESC LIMIT 1', [id]);
    if (q.format === 'csv') return sendCsv(reply, `change-${id}.csv`, [{ change_id: c.id, page: c.page_url, type: c.change_type, old_value: c.old_value, new_value: c.new_value, reason: c.reason, reviewer: c.reviewer_email, status: c.status, implemented_at: c.implemented_at }]);
    if (q.format === 'md') {
      reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="change-${id}.md"`);
      return `# SEO change ${c.id}\n\n- **Page:** ${c.page_url}\n- **Type:** ${c.change_type}\n- **Status:** ${c.status}\n- **Approved by:** ${c.reviewer_email ?? 'n/a'}\n\n## Reason\n${c.reason ?? ''}\n\n## Old value\n\`\`\`\n${c.old_value ?? '(none)'}\n\`\`\`\n\n## New value\n\`\`\`\n${c.new_value ?? ''}\n\`\`\`\n\n## History\n${events.map((e: any) => `- ${new Date(e.created_at).toISOString()} ${e.from_status ?? '—'} → ${e.to_status} (${e.actor}) ${e.note ?? ''}`).join('\n')}\n`;
    }
    return { ...c, events, experiment };
  });

  app.get('/api/projects/:projectId/changelog', async (req) => {
    const { projectId } = req.params as P;
    const q = parse(z.object({ page: z.string().optional(), type: z.string().optional(), from: z.string().optional(), to: z.string().optional(), user: z.string().optional(), includeTraffic: z.coerce.boolean().default(true) }), req.query);
    const w = new Where(['c.project_id = ?', projectId]);
    w.addIf(q.page, 'c.page_url ILIKE ?', `%${q.page}%`);
    w.addIf(q.type, 'c.change_type = ?', q.type);
    w.addIf(q.from, 'e.created_at >= ?::date', q.from);
    w.addIf(q.to, 'e.created_at < (?::date + 1)', q.to);
    w.addIf(q.user, 'e.actor ILIKE ?', `%${q.user}%`);
    const events = await ctx.db.query<any>(`SELECT e.id, e.created_at AS at, e.to_status, e.from_status, e.actor, e.note, c.id AS change_id, c.change_type, c.page_url, c.result FROM change_events e JOIN seo_changes c ON c.id = e.change_id ${w} ORDER BY e.created_at DESC LIMIT 500`, w.params);
    const timeline: any[] = events.map((e) => ({ kind: 'change', at: e.at, title: `${e.change_type.replace(/_/g, ' ')} ${e.to_status.replace(/_/g, ' ')}`, detail: e.note, page: e.page_url, actor: e.actor, changeId: e.change_id, impact: e.result?.direction ?? null }));
    if (q.includeTraffic && !q.page && !q.type && !q.user) {
      // Weekly organic traffic markers so changes can be read against performance (correlation only).
      const end = await latestGscDate(ctx.db, projectId);
      const rows = await loadGscRows(ctx, projectId, isoDate(addDays(end, -83)), end, { withQuery: false });
      for (let wk = 0; wk < 11; wk++) {
        const wEnd = isoDate(addDays(end, -7 * wk));
        const c = comparePeriods(rows.map((r) => ({ ...r, query: 'site' })), 'query', 7, wEnd)[0];
        if (c && c.previous.clicks >= 10 && Math.abs(c.clicksChangePct ?? 0) >= 20) timeline.push({ kind: 'traffic', at: wEnd, title: `Organic clicks ${c.clicksChangePct! > 0 ? 'increased' : 'decreased'} ${Math.abs(c.clicksChangePct!)}% week-over-week`, detail: `${c.previous.clicks} → ${c.current.clicks} clicks`, page: null, actor: 'Search Console', impact: c.clicksChangePct! > 0 ? 'improved' : 'worsened' });
      }
    }
    return timeline.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  });

  app.get('/api/projects/:projectId/experiments', async (req) => {
    const { projectId } = req.params as P;
    return ctx.db.query(`SELECT e.*, c.change_type, c.old_value, c.new_value FROM experiments e LEFT JOIN seo_changes c ON c.id = e.change_id WHERE e.project_id = $1 ORDER BY e.created_at DESC`, [projectId]);
  });

  /* ── Alerts, reports, AI usage, audit ── */
  app.get('/api/projects/:projectId/alerts', async (req) => {
    const { projectId } = req.params as P;
    const q = parse(z.object({ status: z.string().default('open,acknowledged') }), req.query);
    return ctx.db.query(`SELECT * FROM alerts WHERE project_id = $1 AND ($2 = 'all' OR status = ANY(string_to_array($2, ','))) ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, last_seen_at DESC LIMIT 200`, [projectId, q.status]);
  });

  app.get('/api/projects/:projectId/reports', async (req) => {
    const { projectId } = req.params as P;
    return ctx.db.query(`SELECT id, type, title, period_start, period_end, summary, ai_generated, sent_to, created_at FROM reports WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, [projectId]);
  });

  app.get('/api/projects/:projectId/reports/:id', async (req, reply) => {
    const { projectId, id } = req.params as P & { id: string };
    const q = parse(z.object({ format: z.enum(['json', 'html', 'md']).default('json') }), req.query);
    const r = await ctx.db.one<any>('SELECT * FROM reports WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!r) throw new AppError('Report not found', 404, 'not_found');
    if (q.format === 'html') return reply.header('content-type', 'text/html; charset=utf-8').send(r.html ?? '<p>No HTML for this report.</p>');
    if (q.format === 'md') return reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="report-${id}.md"`).send(r.markdown ?? '');
    return r;
  });

  app.get('/api/projects/:projectId/migration', async (req) => {
    const { projectId } = req.params as P;
    const [snapshots, reports] = await Promise.all([
      ctx.db.query(`SELECT * FROM migration_snapshots WHERE project_id = $1 ORDER BY created_at DESC`, [projectId]),
      ctx.db.query(`SELECT id, title, summary, data, created_at FROM reports WHERE project_id = $1 AND type = 'migration' ORDER BY created_at DESC LIMIT 20`, [projectId]),
    ]);
    return { snapshots, reports };
  });

  app.get('/api/projects/:projectId/ai-usage', async (req) => {
    const { projectId } = req.params as P;
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
    const [byPrompt, byDay, totals, month] = await Promise.all([
      ctx.db.query(`SELECT prompt_name, provider, model, COUNT(*)::int AS calls, SUM(CASE WHEN cached THEN 1 ELSE 0 END)::int AS cache_hits, SUM(CASE WHEN success THEN 0 ELSE 1 END)::int AS failures, SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens, SUM(estimated_cost_usd)::float AS cost FROM ai_usage WHERE (project_id = $1 OR project_id IS NULL) AND created_at > now() - ($2 || ' days')::interval GROUP BY 1,2,3 ORDER BY cost DESC`, [projectId, String(q.days)]),
      ctx.db.query(`SELECT date_trunc('day', created_at)::date::text AS day, COUNT(*)::int AS calls, SUM(estimated_cost_usd)::float AS cost, SUM(input_tokens + output_tokens)::int AS tokens FROM ai_usage WHERE (project_id = $1 OR project_id IS NULL) AND created_at > now() - ($2 || ' days')::interval GROUP BY 1 ORDER BY 1`, [projectId, String(q.days)]),
      ctx.db.one(`SELECT COUNT(*)::int AS calls, COALESCE(SUM(estimated_cost_usd),0)::float AS cost, COALESCE(SUM(input_tokens),0)::int AS input_tokens, COALESCE(SUM(output_tokens),0)::int AS output_tokens, COALESCE(AVG(CASE WHEN cached THEN 1.0 ELSE 0 END),0)::float AS cache_hit_rate FROM ai_usage WHERE (project_id = $1 OR project_id IS NULL) AND created_at > now() - ($2 || ' days')::interval`, [projectId, String(q.days)]),
      ctx.db.one(`SELECT COALESCE(SUM(estimated_cost_usd),0)::float AS cost FROM ai_usage WHERE created_at >= date_trunc('month', now())`),
    ]);
    const recent = await ctx.db.query(`SELECT created_at, prompt_name, model, input_tokens, output_tokens, cached, estimated_cost_usd, duration_ms, success, error FROM ai_usage WHERE (project_id = $1 OR project_id IS NULL) ORDER BY created_at DESC LIMIT 50`, [projectId]);
    return { ai: ctx.ai.info, totals, monthToDate: month, byPrompt, byDay, recent, note: 'Costs are estimates from token counts and list prices; check your provider invoice for actual spend.' };
  });

  app.get('/api/projects/:projectId/audit-logs', async (req) => {
    const { projectId } = req.params as P;
    const q = parse(pageQuery, req.query);
    return ctx.db.query(`SELECT * FROM audit_logs WHERE project_id = $1 OR project_id IS NULL ORDER BY created_at DESC LIMIT ${q.limit} OFFSET ${q.offset}`, [projectId]);
  });

  app.get('/api/projects/:projectId/jobs', async (req) => {
    const { projectId } = req.params as P;
    return ctx.db.query(`SELECT id, job_type, status, trigger, correlation_id, error, created_at, started_at, finished_at, EXTRACT(EPOCH FROM (finished_at - started_at))::float AS seconds FROM job_runs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 100`, [projectId]);
  });

  app.get('/api/projects/:projectId/jobs/:id', async (req) => {
    const { projectId, id } = req.params as P & { id: string };
    const j = await ctx.db.one('SELECT * FROM job_runs WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!j) throw new AppError('Job not found', 404, 'not_found');
    return j;
  });

  app.get('/api/projects/:projectId/rules', async (req) => {
    const p = await getProject(ctx, (req.params as P).projectId);
    return listRules(p.settings?.rules);
  });
}
