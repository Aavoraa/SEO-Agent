import { AppError, DEFAULT_BUSINESS_PROFILE, isoDate, addDays, type BusinessProfile, type CrawledPage } from '@phoenixx/shared';
import type { RuleOverrides } from '@phoenixx/seo-engine';
import type { AppContext } from '../context.js';
import type { Queryable } from '@phoenixx/database';

export interface ProjectRow {
  id: string;
  name: string;
  slug: string;
  is_demo: boolean;
  business_profile: Partial<BusinessProfile>;
  settings: ProjectSettings;
  onboarding: Record<string, unknown>;
  created_at: string;
}

export interface ProjectSettings {
  rules?: RuleOverrides;
  alertMinSeverity?: Record<string, 'critical' | 'high' | 'medium' | 'low' | 'info'>;
  crawl?: { maxPages?: number; checkExternalLinks?: boolean };
  ai?: { autoAnalyzeCrawl?: boolean; refineKeywordIntent?: boolean };
  thresholds?: { minImpressionsForLocationPage?: number; trafficDropPct?: number };
}

export interface WebsiteRow {
  id: string;
  project_id: string;
  base_url: string;
  role: string;
  sitemap_url: string | null;
  is_primary: boolean;
  adapter_type: string;
}

export async function getProject(ctx: AppContext, projectId: string): Promise<ProjectRow> {
  const p = await ctx.db.one<ProjectRow>('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!p) throw new AppError('Project not found', 404, 'not_found');
  return p;
}

export function profileOf(p: ProjectRow): BusinessProfile {
  return { ...DEFAULT_BUSINESS_PROFILE, ...p.business_profile } as BusinessProfile;
}

export async function primaryWebsite(ctx: AppContext, projectId: string): Promise<WebsiteRow> {
  const w = await ctx.db.one<WebsiteRow>('SELECT * FROM websites WHERE project_id = $1 ORDER BY is_primary DESC, created_at LIMIT 1', [projectId]);
  if (!w) throw new AppError('No website configured for this project', 400, 'no_website');
  return w;
}

/** Latest completed crawl run for the primary website. */
export async function latestCrawl(ctx: AppContext, websiteId: string): Promise<{ id: string; started_at: string; health_score: number | null; site_checks: any; stats: any } | null> {
  return ctx.db.one(`SELECT id, started_at, health_score, site_checks, stats FROM crawl_runs WHERE website_id = $1 AND status = 'completed' ORDER BY started_at DESC LIMIT 1`, [websiteId]);
}

/** Rebuild CrawledPage objects from stored crawl_results (used by internal linking, local SEO, competitors, migration). */
export function rowToCrawledPage(r: any): CrawledPage {
  return {
    url: r.url,
    finalUrl: r.final_url ?? r.url,
    statusCode: r.status_code,
    redirectChain: r.redirect_chain ?? [],
    redirectLoop: false,
    responseTimeMs: r.response_time_ms,
    contentType: r.content_type,
    contentLength: r.content_length,
    canonical: r.canonical,
    robotsMeta: r.robots_meta,
    xRobotsTag: r.x_robots_tag,
    indexable: !!r.indexable,
    indexabilityReason: r.indexability_reason,
    title: r.title,
    metaDescription: r.meta_description,
    h1s: r.h1s ?? [],
    h2s: r.h2s ?? [],
    h3s: r.h3s ?? [],
    wordCount: r.word_count ?? 0,
    images: r.images ?? [],
    internalLinks: r.internal_links ?? [],
    externalLinks: r.external_links ?? [],
    structuredData: r.structured_data ?? [],
    openGraph: r.open_graph ?? {},
    hreflang: r.hreflang ?? [],
    lang: r.lang,
    contentHash: r.content_hash,
    textSample: r.text_sample ?? '',
    signals: r.signals ?? {},
    depth: r.depth ?? 0,
    inSitemap: !!r.in_sitemap,
    discoveredFrom: r.discovered_from,
    blockedByRobots: false,
    error: r.error,
  };
}

export async function latestCrawledPages(ctx: AppContext, projectId: string): Promise<{ crawlId: string | null; pages: CrawledPage[] }> {
  const site = await primaryWebsite(ctx, projectId);
  const crawl = await latestCrawl(ctx, site.id);
  if (!crawl) return { crawlId: null, pages: [] };
  const rows = await ctx.db.query('SELECT * FROM crawl_results WHERE crawl_run_id = $1', [crawl.id]);
  return { crawlId: crawl.id, pages: rows.map(rowToCrawledPage) };
}

/** Latest date with Search Console data (GSC lags 2–3 days); falls back to today-3. */
export async function latestGscDate(db: Queryable, projectId: string): Promise<string> {
  const r = (await db.query<{ d: string | null }>('SELECT MAX(date)::text AS d FROM search_console_data WHERE project_id = $1', [projectId]))[0];
  return r?.d ?? isoDate(addDays(new Date(), -3));
}

export async function audit(
  ctx: AppContext,
  e: { projectId?: string | null; actorType: 'user' | 'api_key' | 'system'; actorId?: string | null; actorLabel?: string | null; action: string; entityType?: string; entityId?: string; details?: Record<string, unknown>; ip?: string; requestId?: string },
) {
  await ctx.db.query(
    `INSERT INTO audit_logs(project_id, actor_type, actor_id, actor_label, action, entity_type, entity_id, details, ip, request_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.projectId ?? null, e.actorType, e.actorId ?? null, e.actorLabel ?? null, e.action, e.entityType ?? null, e.entityId ?? null, e.details ?? {}, e.ip ?? null, e.requestId ?? null],
  );
}

export interface Actor {
  type: 'user' | 'api_key' | 'system';
  id: string | null;
  label: string;
  role: 'admin' | 'editor' | 'viewer' | 'service';
  /** API keys only: the one project this key may access (null/undefined = all projects). */
  projectScope?: string | null;
  /** API keys only: the one organization this key may access. */
  orgScope?: string | null;
  /** Users: organization role that granted access to the current project (if any). */
  orgRole?: string;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, label: 'system', role: 'service' };
