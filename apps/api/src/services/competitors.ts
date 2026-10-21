import { crawlSite } from '@phoenixx/crawler';
import { compareCompetitors, type CompetitorSummary, type SitePageSummary } from '@phoenixx/seo-engine';
import { AppError, detectLocations, detectServices, normalizeUrl, tokenize, type CrawledPage } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestCrawledPages, profileOf } from './common.js';

export function ownSummaries(pages: CrawledPage[]): SitePageSummary[] {
  return pages.filter((p) => p.indexable).map((p) => ({ url: p.url, title: p.title, h1: p.h1s[0] ?? null, h2s: p.h2s, wordCount: p.wordCount, schemaTypes: p.structuredData.filter((s) => s.valid).flatMap((s) => s.types) }));
}

export async function competitorSummaries(ctx: AppContext, projectId: string): Promise<CompetitorSummary[]> {
  const comps = await ctx.db.query<any>('SELECT * FROM competitors WHERE project_id = $1 AND is_active', [projectId]);
  const out: CompetitorSummary[] = [];
  for (const c of comps) {
    const pages = await ctx.db.query<any>('SELECT * FROM competitor_pages WHERE competitor_id = $1 AND status_code = 200', [c.id]);
    if (pages.length) out.push({ name: c.name, baseUrl: c.base_url, pages: pages.map((p) => ({ url: p.url, title: p.title, h1: p.h1, h2s: p.h2s, wordCount: p.word_count, schemaTypes: p.schema_types })) });
  }
  return out;
}

/**
 * Crawls a competitor politely (robots.txt respected, 1 req/s, page cap) and stores ONLY
 * structure: titles, headings, word counts, detected services/locations and schema types.
 * Body text is discarded so competitor content can never be copied.
 */
export async function analyzeCompetitor(ctx: AppContext, projectId: string, competitorId: string) {
  const c = await ctx.db.one<any>('SELECT * FROM competitors WHERE id = $1 AND project_id = $2', [competitorId, projectId]);
  if (!c) throw new AppError('Competitor not found', 404, 'not_found');
  const profile = profileOf(await getProject(ctx, projectId));
  try {
    const out = await crawlSite({ baseUrl: c.base_url, maxPages: c.max_pages, concurrency: 1, delayMs: 1000, timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS, userAgent: ctx.cfg.CRAWL_USER_AGENT, respectRobots: true, skipSiteChecks: true, logger: ctx.log.child({ competitor: c.name }) });
    let stored = 0;
    for (const p of out.pages) {
      if (p.blockedByRobots) continue;
      const text = [p.title, ...p.h1s, ...p.h2s].filter(Boolean).join(' . ');
      const topics = [...new Set(tokenize(text))].slice(0, 30);
      await ctx.db.query(
        `INSERT INTO competitor_pages(competitor_id, url, status_code, title, meta_description, h1, h2s, word_count, internal_link_count, topics, services, locations, schema_types, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (competitor_id, url) DO UPDATE SET status_code = EXCLUDED.status_code, title = EXCLUDED.title, meta_description = EXCLUDED.meta_description, h1 = EXCLUDED.h1, h2s = EXCLUDED.h2s,
           word_count = EXCLUDED.word_count, internal_link_count = EXCLUDED.internal_link_count, topics = EXCLUDED.topics, services = EXCLUDED.services, locations = EXCLUDED.locations, schema_types = EXCLUDED.schema_types, fetched_at = now()`,
        [c.id, p.url, p.redirectChain.length ? 301 : p.statusCode, p.title, p.metaDescription, p.h1s[0] ?? null, JSON.stringify(p.h2s.slice(0, 30)), p.wordCount, new Set(p.internalLinks.map((l) => l.href)).size, JSON.stringify(topics), detectServices(text, profile.services), detectLocations(text, profile.locations), p.structuredData.filter((s) => s.valid).flatMap((s) => s.types)],
      );
      stored++;
    }
    await ctx.db.query('UPDATE competitors SET last_crawled_at = now(), last_error = NULL WHERE id = $1', [c.id]);
    return { competitor: c.name, pages: stored };
  } catch (e) {
    await ctx.db.query('UPDATE competitors SET last_error = $2 WHERE id = $1', [c.id, (e as Error).message]);
    throw e;
  }
}

export async function competitorComparison(ctx: AppContext, projectId: string) {
  const profile = profileOf(await getProject(ctx, projectId));
  const { pages } = await latestCrawledPages(ctx, projectId);
  const comps = await competitorSummaries(ctx, projectId);
  return {
    competitors: comps.map((c) => ({ name: c.name, baseUrl: c.baseUrl, pages: c.pages.length, avgWords: Math.round(c.pages.reduce((s, p) => s + (p.wordCount ?? 0), 0) / Math.max(1, c.pages.length)) })),
    phoenixx: { pages: pages.filter((p) => p.indexable).length, avgWords: Math.round(pages.reduce((s, p) => s + p.wordCount, 0) / Math.max(1, pages.length)) },
    rows: comps.length ? compareCompetitors(ownSummaries(pages), comps, profile) : [],
    note: 'Structure-only comparison (titles, headings, page types). Competitor body text is never stored or reused.',
  };
}

export function validateCompetitorUrl(url: string): string {
  const n = normalizeUrl(url);
  if (!n || !/^https?:/.test(n)) throw new AppError('Enter a valid http(s) URL', 400, 'validation');
  return new URL('/', n).toString();
}
