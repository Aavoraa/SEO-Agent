import { AppError, DEFAULT_BUSINESS_PROFILE, normalizeUrl, slugify } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject } from './common.js';
import { defaultOrganization } from './tenancy.js';

export async function createProject(
  ctx: AppContext,
  input: {
    name: string;
    siteUrl: string;
    isDemo?: boolean;
    businessProfile?: Record<string, unknown>;
    searchConsoleSiteUrl?: string;
    ga4PropertyId?: string;
    /** Owning organization (defaults to the internal/demo organization for single-tenant installs). */
    organizationId?: string;
    /** Customer projects start with an empty profile (services/locations filled during onboarding). */
    blankProfile?: boolean;
  },
) {
  const url = normalizeUrl(input.siteUrl);
  if (!url) throw new AppError('Enter a valid website URL (https://…)', 400, 'validation');
  const base = new URL('/', url).toString();
  let slug = slugify(input.name) || 'project';
  if (await ctx.db.one('SELECT 1 FROM projects WHERE slug = $1', [slug])) slug = `${slug}-${Date.now().toString(36)}`;
  const isPhoenixx = /phoenixxit\.com$/.test(new URL(base).hostname);
  const blank = { name: input.name, url: base, description: '', services: [], locations: [], facts: [], ctas: ['Contact us'], sameAs: [], languages: ['English'] };
  const profile = input.businessProfile ?? (isPhoenixx ? DEFAULT_BUSINESS_PROFILE : input.blankProfile ? blank : { ...blank, services: DEFAULT_BUSINESS_PROFILE.services, locations: DEFAULT_BUSINESS_PROFILE.locations });
  const orgId = input.organizationId ?? (await defaultOrganization(ctx, { demo: input.isDemo })).id;
  return ctx.db.transaction(async (tx) => {
    const [p] = await tx.query<{ id: string }>(`INSERT INTO projects(name, slug, is_demo, business_profile, settings, organization_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [input.name, slug, input.isDemo ?? false, profile, { searchConsoleSiteUrl: input.searchConsoleSiteUrl, ga4PropertyId: input.ga4PropertyId, automation: { level: 2 } }, orgId]);
    await tx.query(`INSERT INTO websites(project_id, base_url, role, sitemap_url, is_primary, adapter_type) VALUES ($1,$2,'production',$3,true,$4)`, [p!.id, base, new URL('/sitemap.xml', base).toString(), ctx.cfg.WEBSITE_ADAPTER]);
    return { id: p!.id, slug };
  });
}

/** First-run checklist shown on the dashboard until complete. */
export async function setupStatus(ctx: AppContext, projectId: string) {
  const p = await getProject(ctx, projectId);
  const integ = await ctx.db.query<{ provider: string; status: string; last_sync_at: string | null; last_error: string | null }>('SELECT provider, status, last_sync_at, last_error FROM integrations WHERE project_id = $1', [projectId]);
  const crawl = await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM crawl_runs cr JOIN websites w ON w.id = cr.website_id WHERE w.project_id = $1 AND cr.status = 'completed'`, [projectId]);
  const report = await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM reports WHERE project_id = $1 AND type = 'initial'`, [projectId]);
  const gAuth = await ctx.googleAuth(projectId);
  const find = (prov: string) => integ.find((i) => i.provider === prov);
  const gscConfigured = !!(p.settings as any)?.searchConsoleSiteUrl || !!ctx.cfg.SEARCH_CONSOLE_SITE_URL;
  const ga4Configured = !!(p.settings as any)?.ga4PropertyId || !!ctx.cfg.GA4_PROPERTY_ID;
  const steps = [
    { id: 'project', label: 'Create project & enter website URL', done: true },
    { id: 'google', label: 'Connect Google (service account or OAuth)', done: gAuth.configured || p.is_demo, detail: p.is_demo ? 'Demo uses sample data' : gAuth.method },
    { id: 'gsc', label: 'Connect Google Search Console', done: p.is_demo || find('google_search_console')?.status === 'connected', detail: gscConfigured ? find('google_search_console')?.last_error ?? null : 'Set SEARCH_CONSOLE_SITE_URL' },
    { id: 'ga4', label: 'Connect GA4 (optional)', done: p.is_demo || find('google_analytics')?.status === 'connected', optional: true, detail: ga4Configured ? find('google_analytics')?.last_error ?? null : 'Set GA4_PROPERTY_ID' },
    { id: 'ai', label: 'Choose AI provider (optional)', done: ctx.ai.enabled, optional: true, detail: ctx.ai.info.provider },
    { id: 'crawl', label: 'Run initial crawl', done: (crawl?.n ?? 0) > 0 },
    { id: 'report', label: 'Generate SEO health report', done: (report?.n ?? 0) > 0 },
  ];
  return { projectId, isDemo: p.is_demo, complete: steps.filter((s) => !s.optional).every((s) => s.done), steps, integrations: integ, ai: ctx.ai.info };
}
