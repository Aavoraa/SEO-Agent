import type { DataLabel, IntegrationStatus, SiteProfile } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestCrawl, latestCrawledPages, primaryWebsite } from './common.js';

export interface CatalogEntry {
  id: string;
  name: string;
  category: 'search_data' | 'ai' | 'keywords_serp' | 'links' | 'performance' | 'local' | 'ai_visibility' | 'implementation' | 'notifications' | 'social_market';
  status: IntegrationStatus;
  /** What the dashboard shows the numbers as when this source is used. */
  dataLabel: DataLabel;
  powers: string[];
  detail: string;
  setup: string;
  /** Phase in which the adapter ships, for status 'planned'. */
  phase?: number;
}

/**
 * Every data source and action provider the platform knows about, with its real state for this
 * project. The UI renders anything not connected/configured as "Integration required" (or
 * "Planned – phase N") instead of showing numbers.
 */
export async function integrationCatalog(ctx: AppContext, projectId: string): Promise<{ demo: boolean; entries: CatalogEntry[] }> {
  const project = await getProject(ctx, projectId);
  const demo = project.is_demo;
  const rows = await ctx.db.query<{ provider: string; status: string; last_sync_at: string | null; last_error: string | null }>('SELECT provider, status, last_sync_at, last_error FROM integrations WHERE project_id = $1', [projectId]);
  const row = (p: string) => rows.find((r) => r.provider === p);
  const google = await ctx.googleAuth(projectId);
  const settings = project.settings as { searchConsoleSiteUrl?: string; ga4PropertyId?: string };
  const googleStatus = (provider: string, property: string | undefined): IntegrationStatus => (row(provider)?.status === 'connected' ? 'connected' : google.configured && property ? 'configured' : 'integration_required');
  const gscProperty = settings.searchConsoleSiteUrl ?? ctx.cfg.SEARCH_CONSOLE_SITE_URL;
  const ga4Property = settings.ga4PropertyId ?? ctx.cfg.GA4_PROPERTY_ID;
  const sync = (p: string) => (row(p)?.last_sync_at ? ` Last sync ${new Date(row(p)!.last_sync_at!).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : '') + (row(p)?.last_error ? ` Last error: ${row(p)!.last_error}` : '');
  const label = (l: DataLabel): DataLabel => (demo ? 'demo' : l);
  const ai = ctx.ai.info;

  const entries: CatalogEntry[] = [
    { id: 'crawler', name: 'Site crawler', category: 'search_data', status: 'connected', dataLabel: label('verified'), powers: ['Technical SEO', 'On-page', 'Schema', 'Internal links', 'AI readiness', 'Migration monitor'], detail: 'Built in. Fetches your site like a search engine (robots.txt respected).', setup: 'Nothing to set up.' },
    { id: 'google_search_console', name: 'Google Search Console', category: 'search_data', status: demo ? 'connected' : googleStatus('google_search_console', gscProperty), dataLabel: label('verified'), powers: ['Search performance', 'Keywords', 'Content gaps', 'Local SEO demand', 'Alerts', 'Experiments'], detail: (gscProperty ? `Property ${gscProperty}.` : 'No property set.') + sync('google_search_console'), setup: 'Service account (GOOGLE_SERVICE_ACCOUNT_KEY_FILE) or Settings → Integrations → Connect Google; add the account as a user of the property.' },
    { id: 'google_analytics', name: 'Google Analytics 4', category: 'search_data', status: demo ? 'connected' : googleStatus('google_analytics', ga4Property), dataLabel: label('verified'), powers: ['Sessions & conversions', 'Weekly report'], detail: (ga4Property ? `Property ${ga4Property}.` : 'No property set.') + sync('google_analytics'), setup: 'Grant the Google account Viewer on the GA4 property and set the numeric property ID.' },
    { id: 'ai_provider', name: `AI provider${ai.provider !== 'none' ? ` (${ai.provider})` : ''}`, category: 'ai', status: ai.provider === 'none' ? 'integration_required' : 'configured', dataLabel: 'modeled', powers: ['Titles & meta drafts', 'Content briefs & drafts', 'Audit summaries', 'Anchor text'], detail: ai.provider === 'none' ? 'Everything except AI writing works without it.' : `Model ${ai.model}; budget $${ai.monthlyBudgetUsd}/month.${ai.provider === 'mock' ? ' Mock provider: canned demo output.' : ''}`, setup: 'AI_PROVIDER=claude|openai with ANTHROPIC_API_KEY or OPENAI_API_KEY.' },
    { id: 'backlinks', name: `Backlink data${ctx.cfg.BACKLINK_PROVIDER !== 'none' ? ` (${ctx.cfg.BACKLINK_PROVIDER})` : ''}`, category: 'links', status: ctx.cfg.BACKLINK_PROVIDER !== 'none' ? 'configured' : 'manual', dataLabel: label(ctx.cfg.BACKLINK_PROVIDER !== 'none' ? 'estimated' : 'verified'), powers: ['Backlinks', 'Lost links', 'Broken-link recovery'], detail: ctx.cfg.BACKLINK_PROVIDER !== 'none' ? 'Links synced weekly, then verified live.' : 'Works from the Search Console Links CSV export (Backlinks → Upload CSV). Links are verified live either way.', setup: 'Optional: BACKLINK_PROVIDER=dataforseo with DATAFORSEO_LOGIN/PASSWORD for automatic sync and link-gap data.' },
    { id: 'website_adapter', name: `Website changes (${ctx.adapter.name})`, category: 'implementation', status: ctx.adapter.name === 'manual' ? 'manual' : 'configured', dataLabel: 'verified', powers: ['Implement approved changes', 'Rollback'], detail: ctx.adapter.name === 'manual' ? 'Approved changes are exported as instructions for your developer; verification checks the live site.' : `Approved changes are applied through the ${ctx.adapter.name} adapter.`, setup: 'WEBSITE_ADAPTER=git (static sites like phoenixxit.com), wordpress or api.' },
    { id: 'notifications', name: 'Notifications', category: 'notifications', status: ctx.notifiers.length ? 'configured' : 'integration_required', dataLabel: 'verified', powers: ['Alerts', 'Weekly report email'], detail: ctx.notifiers.length ? `Channels: ${ctx.notifiers.map((n) => n.channel).join(', ')}.` : 'No channel configured; alerts stay in the dashboard.', setup: 'SMTP_*, SLACK_WEBHOOK_URL, TEAMS_WEBHOOK_URL or TELEGRAM_BOT_TOKEN/CHAT_ID.' },
    { id: 'pagespeed', name: 'PageSpeed Insights / CrUX', category: 'performance', status: 'planned', phase: 2, dataLabel: 'unavailable', powers: ['Core Web Vitals'], detail: 'Lab and field LCP/INP/CLS per URL.', setup: 'Free Google API key.' },
    { id: 'url_inspection', name: 'Search Console URL Inspection', category: 'search_data', status: 'planned', phase: 2, dataLabel: 'unavailable', powers: ['Indexation'], detail: "Google's index status per URL.", setup: 'Uses the Search Console connection.' },
    { id: 'keyword_data', name: 'Keyword data provider', category: 'keywords_serp', status: 'planned', phase: 3, dataLabel: 'unavailable', powers: ['Search volume', 'CPC', 'Keyword difficulty', 'Trends'], detail: 'Search Console shows impressions, not volume. Volume/CPC/difficulty are never estimated without a provider.', setup: 'e.g. DataForSEO Keywords Data or Google Ads Keyword Planner.' },
    { id: 'serp', name: 'SERP & rank tracking provider', category: 'keywords_serp', status: 'planned', phase: 3, dataLabel: 'unavailable', powers: ['Rank tracking (device/location)', 'SERP features', 'SERP competitors', 'Google AI Overviews / AI Mode presence'], detail: 'Search Console average position is available today; daily per-location ranks need a SERP API.', setup: 'e.g. DataForSEO SERP API.' },
    { id: 'ai_visibility', name: 'AI answer engines', category: 'ai_visibility', status: 'planned', phase: 5, dataLabel: 'unavailable', powers: ['AI visibility', 'Prompt tracking', 'Citations', 'Brand sentiment', 'AI share of voice'], detail: 'Prompts run through official APIs (OpenAI, Anthropic, Google Gemini, Perplexity); Google AI Overviews only via a SERP provider that returns them.', setup: 'API keys per engine to track.' },
    { id: 'google_business_profile', name: 'Google Business Profile', category: 'local', status: 'planned', phase: 6, dataLabel: 'unavailable', powers: ['Profile monitoring', 'Reviews', 'Review sentiment'], detail: 'The GBP API requires approval from Google.', setup: 'Apply for GBP API access.' },
    { id: 'local_grid', name: 'Local map-grid rankings', category: 'local', status: 'planned', phase: 6, dataLabel: 'unavailable', powers: ['Map rankings'], detail: 'Map-pack position across a grid of locations.', setup: 'Local SERP provider.' },
    { id: 'social_market', name: 'Social, brand & market data', category: 'social_market', status: 'planned', phase: 11, dataLabel: 'unavailable', powers: ['Social monitoring', 'Brand mentions', 'Market intelligence', 'Competitor traffic (estimated)'], detail: 'Third-party estimates, always labelled Estimated.', setup: 'Provider choice in Phase 11.' },
  ];
  return { demo, entries };
}

/** AI readiness from the latest crawl: crawler access, llms.txt, structure signals. All values are verified crawl facts. */
export async function aiReadiness(ctx: AppContext, projectId: string) {
  const site = await primaryWebsite(ctx, projectId);
  const crawl = await latestCrawl(ctx, site.id);
  const profile = (crawl?.site_checks as { profile?: SiteProfile } | null)?.profile ?? null;
  if (!crawl || !profile) return { available: false as const, reason: crawl ? 'The latest crawl predates AI-readiness checks – run a new crawl.' : 'No crawl yet – run a crawl first.' };
  const { pages } = await latestCrawledPages(ctx, projectId);
  const html = pages.filter((p) => p.statusCode === 200 && p.indexable);
  const schemaTypes = new Set(html.flatMap((p) => p.structuredData.filter((s) => s.valid).flatMap((s) => s.types)));
  const pct = (n: number) => (html.length ? Math.round((n / html.length) * 100) : 0);
  const searchBots = profile.aiCrawlers.filter((c) => c.purpose !== 'training');
  const checks = [
    { id: 'search_crawlers', label: 'AI search & user crawlers allowed', ok: searchBots.every((c) => c.allowed), detail: `${searchBots.filter((c) => c.allowed).length}/${searchBots.length} allowed` },
    { id: 'h1', label: 'Pages with exactly one H1', ok: pct(html.filter((p) => p.h1s.length === 1).length) >= 90, detail: `${pct(html.filter((p) => p.h1s.length === 1).length)}% of ${html.length} indexable pages` },
    { id: 'schema_org', label: 'Organization or LocalBusiness schema', ok: [...schemaTypes].some((t) => /Organization|LocalBusiness|ProfessionalService/.test(t)), detail: [...schemaTypes].join(', ') || 'no valid JSON-LD' },
    { id: 'faq', label: 'Question-and-answer content (FAQ schema)', ok: schemaTypes.has('FAQPage'), detail: schemaTypes.has('FAQPage') ? 'FAQPage present' : 'no FAQPage schema' },
    { id: 'depth', label: 'Substantive pages (300+ words)', ok: pct(html.filter((p) => p.wordCount >= 300).length) >= 70, detail: `${pct(html.filter((p) => p.wordCount >= 300).length)}% of indexable pages` },
    { id: 'rendering', label: 'Content in the HTML (no JavaScript needed)', ok: profile.rendering !== 'client-side', detail: profile.renderingNote },
  ];
  return {
    available: true as const,
    crawledAt: crawl.started_at,
    dataLabel: 'verified' as const,
    crawlers: profile.aiCrawlers,
    llmsTxt: { ...profile.llmsTxt, note: 'Optional. Some AI tools read /llms.txt; Google Search does not use it.' },
    checks,
    stack: { server: profile.server, rendering: profile.rendering, technologies: profile.technologies, analytics: profile.analytics },
    note: 'Readiness is based on what crawlers can access and understand. Actual AI visibility (mentions, citations) needs the AI answer-engine integration (Phase 5).',
  };
}
