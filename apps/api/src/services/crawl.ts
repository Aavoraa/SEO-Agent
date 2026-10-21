import { crawlSite } from '@phoenixx/crawler';
import { analyzeSite, classifyPageType } from '@phoenixx/seo-engine';
import { bulkInsert, insert, upsert } from '@phoenixx/database';
import { addDays, isoDate, round, type CrawledPage } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestGscDate, primaryWebsite, profileOf } from './common.js';
import { recommendationsFromIssues, type PageSearchStats } from './recommendations.js';
import { raiseAlert } from './alerts.js';
import { mobileUserAgent, recordAudit, type AuditDevice } from './audits.js';
import { crawlDemoSite } from '../demo/site.js';
import { assertFeature, assertLimit, limitValue, orgOfProject, recordUsage } from './tenancy.js';
import { emitEvent } from './events.js';
import { existsSync } from 'node:fs';
import path from 'node:path';

export interface CrawlJobInput {
  websiteId?: string;
  maxPages?: number;
  trigger?: string;
  correlationId?: string;
  /** Run the AI audit summary (only if the issue set changed since the last summary). */
  aiSummary?: boolean;
  /** Fetch pages as a desktop (default) or mobile browser; recorded on the SEO audit. */
  device?: AuditDevice;
  /** Who started it (audit history). */
  createdBy?: string;
}

export async function pageSearchStats(ctx: AppContext, projectId: string, days = 28): Promise<{ byPage: Map<string, PageSearchStats>; siteAvgCtr: number }> {
  const end = await latestGscDate(ctx.db, projectId);
  const start = isoDate(addDays(end, -(days - 1)));
  const rows = await ctx.db.query<{ page: string; clicks: number; impressions: number; position: number | null }>(
    `SELECT page, SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions, (SUM(position*impressions)/NULLIF(SUM(impressions),0))::float AS position
     FROM search_console_data WHERE project_id = $1 AND page <> '' AND query <> '' AND date BETWEEN $2 AND $3 GROUP BY page`,
    [projectId, start, end],
  );
  const byPage = new Map(rows.map((r) => [r.page, { clicks: r.clicks, impressions: r.impressions, ctr: r.impressions ? r.clicks / r.impressions : 0, position: r.position ? round(r.position, 1) : null }]));
  const tot = rows.reduce((a, r) => ({ c: a.c + r.clicks, i: a.i + r.impressions }), { c: 0, i: 0 });
  return { byPage, siteAvgCtr: tot.i ? tot.c / tot.i : 0 };
}

/** Persists a crawl (from the live crawler or a provided CrawlOutput) and runs the full analysis. */
export async function runCrawl(ctx: AppContext, projectId: string, input: CrawlJobInput = {}, provided?: import('@phoenixx/shared').CrawlOutput) {
  const project = await getProject(ctx, projectId);
  const profile = profileOf(project);
  const website = input.websiteId ? ((await ctx.db.one<any>('SELECT * FROM websites WHERE id = $1 AND project_id = $2', [input.websiteId, projectId])) ?? (await primaryWebsite(ctx, projectId))) : await primaryWebsite(ctx, projectId);
  const settings = project.settings ?? {};
  // Plan limits: pages per crawl is capped, and fresh crawls count towards the monthly audit allowance.
  const org = await orgOfProject(ctx, projectId);
  const planPages = await limitValue(ctx, org.id, 'pagesPerCrawl', Number.MAX_SAFE_INTEGER);
  const maxPages = Math.min(input.maxPages ?? settings.crawl?.maxPages ?? ctx.cfg.CRAWL_MAX_PAGES, planPages);
  if (!provided) {
    const audits = (await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM seo_audits a JOIN projects p ON p.id = a.project_id WHERE p.organization_id = $1 AND a.created_at >= date_trunc('month', now()) AND a.trigger <> 'post-deployment'`, [org.id]))!.n;
    await assertLimit(ctx, org.id, 'auditsPerMonth', audits);
    if (input.device === 'mobile') await assertFeature(ctx, org.id, 'mobileAudits');
  }
  const run = await insert<{ id: string }>(ctx.db, 'crawl_runs', { website_id: website.id, status: 'running', trigger: input.trigger ?? 'manual', correlation_id: input.correlationId ?? null, config: { maxPages } });
  const log = ctx.log.child({ crawlRunId: run.id, correlationId: input.correlationId });
  try {
    const userAgent = input.device === 'mobile' ? mobileUserAgent(ctx.cfg.CRAWL_USER_AGENT) : ctx.cfg.CRAWL_USER_AGENT;
    const demoCopy = !provided && project.is_demo && ctx.cfg.DEMO_MODE && existsSync(path.join(path.resolve(ctx.cfg.DEMO_SITE_DIR), 'index.html'));
    const prevSite = demoCopy ? (await ctx.db.one<{ site_checks: any }>(`SELECT site_checks FROM crawl_runs WHERE website_id = $1 AND status = 'completed' ORDER BY started_at DESC LIMIT 1`, [website.id]))?.site_checks : null;
    const out =
      provided ??
      (demoCopy && prevSite?.robots
        ? await crawlDemoSite(ctx, website.base_url, prevSite, userAgent, maxPages)
        : await crawlSite({
        baseUrl: website.base_url,
        maxPages,
        concurrency: ctx.cfg.CRAWL_CONCURRENCY,
        delayMs: ctx.cfg.CRAWL_DELAY_MS,
        timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS,
        userAgent,
        checkExternalLinks: settings.crawl?.checkExternalLinks ?? false,
        logger: log,
      }));

    const { byPage, siteAvgCtr } = await pageSearchStats(ctx, projectId);
    const topPaths = [...byPage.entries()].sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10).map(([u]) => new URL(u).pathname);
    const analysis = analyzeSite({ pages: out.pages, site: out.site, profile, overrides: settings.rules, externalLinkStatus: out.externalLinkStatus, importantPaths: topPaths });

    // ── Persist pages + crawl results ──
    const pageIds = new Map<string, string>();
    for (const p of out.pages) {
      const row = await upsert<{ id: string }>(
        ctx.db,
        'pages',
        {
          website_id: website.id,
          url: p.url,
          path: new URL(p.url).pathname,
          page_type: analysis.pageTypes.get(p.url) ?? classifyPageType(p.url, profile),
          is_important: topPaths.includes(new URL(p.url).pathname) || profile.services.some((s) => s.path === new URL(p.url).pathname) || new URL(p.url).pathname === '/',
          status_code: p.statusCode,
          title: p.title,
          meta_description: p.metaDescription,
          h1: p.h1s[0] ?? null,
          word_count: p.wordCount,
          indexable: p.indexable,
          in_sitemap: p.inSitemap,
          inlinks: analysis.inlinks.get(p.url)?.size ?? 0,
          content_hash: p.contentHash,
          last_seen_at: new Date(),
          removed_at: null,
        },
        ['website_id', 'url'],
      );
      pageIds.set(p.url, row.id);
    }
    const resultRows = out.pages.map((p: CrawledPage) => ({
      crawl_run_id: run.id,
      page_id: pageIds.get(p.url) ?? null,
      url: p.url,
      final_url: p.finalUrl,
      status_code: p.statusCode,
      redirect_chain: JSON.stringify(p.redirectChain),
      response_time_ms: p.responseTimeMs,
      content_type: p.contentType,
      content_length: p.contentLength,
      canonical: p.canonical,
      robots_meta: p.robotsMeta,
      x_robots_tag: p.xRobotsTag,
      indexable: p.indexable,
      indexability_reason: p.indexabilityReason,
      title: p.title,
      meta_description: p.metaDescription,
      h1s: JSON.stringify(p.h1s),
      h2s: JSON.stringify(p.h2s),
      h3s: JSON.stringify(p.h3s),
      word_count: p.wordCount,
      images: JSON.stringify(p.images.slice(0, 200)),
      internal_links: JSON.stringify(p.internalLinks.slice(0, 500)),
      external_links: JSON.stringify(p.externalLinks.slice(0, 200)),
      // Keep the JSON-LD payload (bounded) so stored pages can be re-analysed exactly, e.g. after a deployment.
      structured_data: JSON.stringify(p.structuredData.map((s) => (JSON.stringify(s.data ?? null).length <= 20_000 ? s : { ...s, data: undefined }))),
      open_graph: JSON.stringify(p.openGraph),
      hreflang: JSON.stringify(p.hreflang),
      lang: p.lang,
      content_hash: p.contentHash,
      text_sample: p.textSample,
      signals: JSON.stringify(p.signals),
      depth: p.depth,
      in_sitemap: p.inSitemap,
      discovered_from: p.discoveredFrom,
      error: p.error,
    }));
    await bulkInsert(ctx.db, 'crawl_results', resultRows, { chunkSize: 50 });
    await ctx.db.query(`UPDATE pages p SET last_crawl_result_id = cr.id FROM crawl_results cr WHERE cr.crawl_run_id = $1 AND cr.page_id = p.id`, [run.id]);
    if (!out.stats.truncated) await ctx.db.query(`UPDATE pages SET removed_at = now() WHERE website_id = $1 AND removed_at IS NULL AND last_seen_at < $2`, [website.id, out.startedAt]);

    // ── Issues: upsert detected, resolve disappeared ──
    const detected = new Set<string>();
    const stored: any[] = [];
    for (const i of analysis.issues) {
      detected.add(i.fingerprint);
      const row = await ctx.db.one(
        `INSERT INTO seo_issues(project_id, website_id, page_id, crawl_run_id, rule_id, category, severity, title, description, evidence, recommendation, url, fingerprint)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (project_id, fingerprint) DO UPDATE SET crawl_run_id = EXCLUDED.crawl_run_id, severity = EXCLUDED.severity, title = EXCLUDED.title, description = EXCLUDED.description,
           evidence = EXCLUDED.evidence, recommendation = EXCLUDED.recommendation, page_id = EXCLUDED.page_id, last_detected_at = now(),
           status = CASE WHEN seo_issues.status = 'resolved' THEN 'open' ELSE seo_issues.status END, resolved_at = NULL
         RETURNING *`,
        [projectId, website.id, i.url ? (pageIds.get(i.url) ?? null) : null, run.id, i.ruleId, i.category, i.severity, i.title, i.description, i.evidence, i.recommendation, i.url, i.fingerprint],
      );
      stored.push({ ...i, id: row.id, page_id: row.page_id });
    }
    const resolved = await ctx.db.query<{ id: string }>(
      `UPDATE seo_issues SET status = 'resolved', resolved_at = now() WHERE website_id = $1 AND status IN ('open','acknowledged') AND NOT (fingerprint = ANY($2::text[])) RETURNING id`,
      [website.id, [...detected]],
    );
    // Recommendations for resolved issues that were never actioned are closed.
    if (resolved.length) await ctx.db.query(`UPDATE recommendations SET status = 'completed', updated_at = now() WHERE issue_id = ANY($1::uuid[]) AND status IN ('recommended','pending_approval')`, [resolved.map((r) => r.id)]);

    const pageMap = new Map(out.pages.map((p) => [p.url, p]));
    const recsCreated = await recommendationsFromIssues(ctx, projectId, stored, pageMap, profile, byPage, siteAvgCtr);
    if (!provided) await recordUsage(ctx, org.id, projectId, 'pages_crawled', out.stats.pagesCrawled, { crawlRunId: run.id });
    if (recsCreated) {
      const pending = (await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM recommendations WHERE project_id = $1 AND status = 'pending_approval' AND created_at >= $2`, [projectId, out.startedAt]))!.n;
      await emitEvent(ctx, projectId, 'recommendation.created', { count: recsCreated, crawlRunId: run.id });
      if (pending) await emitEvent(ctx, projectId, 'approval.required', { count: pending, crawlRunId: run.id });
    }

    // ── Critical alerts from crawl ──
    for (const i of analysis.issues.filter((x) => x.severity === 'critical')) {
      await raiseAlert(ctx, projectId, { severity: 'critical', type: `crawl:${i.ruleId}`, title: i.title, message: `${i.description} ${i.recommendation}`.trim(), evidence: { url: i.url, ...i.evidence }, fingerprint: `crawl:${i.fingerprint}` });
    }

    const counts: Record<string, number> = {};
    for (const i of analysis.issues) counts[i.severity] = (counts[i.severity] ?? 0) + 1;
    const stats = { ...out.stats, issues: counts, resolvedIssues: resolved.length, recommendationsCreated: recsCreated, health: analysis.healthScore, indexablePages: out.pages.filter((p) => p.indexable).length };

    // ── Optional AI interpretation (cost control: only when the issue set changed) ──
    let aiSummary: unknown = null;
    if ((input.aiSummary ?? settings.ai?.autoAnalyzeCrawl ?? true) && ctx.ai.enabled) {
      const issueHash = [...detected].sort().join(',');
      const prev = await ctx.db.one<{ stats: any }>(`SELECT stats FROM crawl_runs WHERE website_id = $1 AND status = 'completed' AND stats ? 'aiSummary' ORDER BY started_at DESC LIMIT 1`, [website.id]);
      if (prev?.stats?.issueHash === issueHash) aiSummary = prev.stats.aiSummary;
      else {
        try {
          const grouped = new Map<string, { severity: string; count: number; examples: string[]; title: string }>();
          for (const i of analysis.issues) {
            const g = grouped.get(i.ruleId) ?? { severity: i.severity, count: 0, examples: [], title: i.title };
            g.count++;
            if (g.examples.length < 3 && i.url) g.examples.push(i.url);
            grouped.set(i.ruleId, g);
          }
          const r = await ctx.ai.run(
            'seo-audit',
            { profile: { name: profile.name, services: profile.services.map((s) => s.name), locations: profile.locations.filter((l) => l.target).map((l) => l.name), facts: profile.facts }, siteUrl: website.base_url, healthScore: analysis.healthScore.score, issues: [...grouped.entries()].map(([rule, g]) => `${g.severity.toUpperCase()} ${rule} ×${g.count}: ${g.title} (e.g. ${g.examples.join(', ')})`).join('\n'), searchContext: [...byPage.entries()].slice(0, 15).map(([u, s]) => `${u}: ${s.clicks} clicks, ${s.impressions} impr, pos ${s.position}`).join('\n') },
            { projectId, correlationId: input.correlationId },
          );
          aiSummary = { ...r.data, model: r.model, cached: r.cached };
        } catch (e) {
          log.warn('crawl.ai_summary_failed', { error: (e as Error).message });
          aiSummary = { error: (e as Error).message };
        }
      }
      Object.assign(stats, { aiSummary, issueHash });
    }

    await ctx.db.query(`UPDATE crawl_runs SET status = 'completed', finished_at = now(), pages_crawled = $2, pages_failed = $3, health_score = $4, stats = $5, site_checks = $6 WHERE id = $1`, [run.id, out.stats.pagesCrawled, out.stats.pagesFailed, analysis.healthScore.score, stats, out.site]);
    await ctx.db.query(`UPDATE projects SET onboarding = onboarding || '{"firstCrawl": true}'::jsonb WHERE id = $1`, [projectId]);
    let audit: Awaited<ReturnType<typeof recordAudit>> | null = null;
    try {
      audit = await recordAudit(ctx, { projectId, crawlRunId: run.id, device: input.device ?? 'desktop', trigger: input.trigger ?? 'manual', createdBy: input.createdBy, siteUrl: website.base_url, out, analysis, overrides: settings.rules });
      await emitEvent(ctx, projectId, 'audit.completed', { auditId: audit.auditId, score: audit.overall, grade: audit.grade, device: input.device ?? 'desktop', trigger: input.trigger ?? 'manual', pages: out.stats.pagesCrawled });
    } catch (e) {
      log.warn('crawl.audit_record_failed', { error: (e as Error).message });
    }
    log.info('crawl.persisted', { pages: out.pages.length, issues: analysis.issues.length, resolved: resolved.length });
    return { crawlRunId: run.id, auditId: audit?.auditId ?? null, auditScore: audit?.overall ?? null, pagesCrawled: out.stats.pagesCrawled, pagesFailed: out.stats.pagesFailed, healthScore: analysis.healthScore, issues: counts, resolvedIssues: resolved.length, recommendationsCreated: recsCreated, aiSummary };
  } catch (e) {
    await ctx.db.query(`UPDATE crawl_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1`, [run.id, (e as Error).message]);
    await raiseAlert(ctx, projectId, { severity: 'high', type: 'crawl_failed', title: 'Website crawl failed', message: (e as Error).message, evidence: { crawlRunId: run.id }, fingerprint: `crawl_failed:${website.id}` });
    throw e;
  }
}
