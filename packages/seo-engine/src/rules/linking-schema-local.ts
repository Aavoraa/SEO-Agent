import { validateJsonLd } from '../schema.js';
import { isHtmlOk, pathOf, type RuleDefinition } from './types.js';

const cfg = (severity: RuleDefinition['defaults']['severity'], params: RuleDefinition['defaults']['params'] = {}) => ({ enabled: true, severity, params });

/* ───────────── Internal linking rules ───────────── */
export const linkingRules: RuleDefinition[] = [
  {
    id: 'orphan_page',
    category: 'internal_linking',
    title: 'Orphan page',
    rationale: 'Pages with no internal links are hard for users and crawlers to find and receive no internal link equity.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p) || !p.indexable || pathOf(p.url) === '/') return [];
      const n = ctx.inlinks.get(p.url)?.size ?? 0;
      return n === 0 ? [{ url: p.url, title: 'No internal links point to this page', description: p.inSitemap ? 'Found only via the XML sitemap.' : 'Found without any linking page.', recommendation: 'Link to it from relevant pages (see Internal Links suggestions).', evidence: { inlinks: 0, inSitemap: p.inSitemap } }] : [];
    },
  },
  {
    id: 'weak_inlinks',
    category: 'internal_linking',
    title: 'Important page has few contextual internal links',
    rationale: 'Service pages linked only from navigation/footer get less topical context than pages linked from related content.',
    scope: 'page',
    defaults: cfg('low', { minInlinks: 3 }),
    check: (ctx, c, p) => {
      if (!p || !isHtmlOk(p) || !ctx.importantPaths.has(pathOf(p.url)) || pathOf(p.url) === '/') return [];
      const n = ctx.inlinks.get(p.url)?.size ?? 0;
      return n > 0 && n < Number(c.params.minInlinks) ? [{ url: p.url, title: `Only ${n} page(s) link here`, description: [...(ctx.inlinks.get(p.url) ?? [])].join(', '), recommendation: 'Add contextual links from related service pages and articles.', evidence: { inlinks: n } }] : [];
    },
  },
  {
    id: 'deep_page',
    category: 'internal_linking',
    title: 'Page is many clicks from the homepage',
    rationale: 'Pages deeper than 3 clicks are crawled less often and viewed as less important.',
    scope: 'page',
    defaults: cfg('low', { maxDepth: 3 }),
    check: (_ctx, c, p) => (p && isHtmlOk(p) && p.discoveredFrom !== 'sitemap' && p.depth > Number(c.params.maxDepth) ? [{ url: p.url, title: `Click depth ${p.depth}`, description: '', recommendation: 'Link from higher-level pages.', evidence: { depth: p.depth } }] : []),
  },
  {
    id: 'no_contextual_outlinks',
    category: 'internal_linking',
    title: 'Page only links to homepage sections',
    rationale: 'Service pages that only link back to the homepage miss the chance to connect related services.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => {
      if (!p || !isHtmlOk(p) || pathOf(p.url) === '/') return [];
      const targets = new Set(p.internalLinks.map((l) => pathOf(l.href)).filter((x) => x !== '/' && x !== pathOf(p.url)));
      const utility = [...targets].filter((t) => !/faq|privacy|terms|contact/i.test(t));
      return utility.length === 0 ? [{ url: p.url, title: 'No links to other service/content pages', description: `Internal link targets: ${[...targets].join(', ') || 'homepage only'}`, recommendation: 'Link to closely related services with descriptive anchor text.', evidence: { targets: [...targets] } }] : [];
    },
  },
  {
    id: 'nofollow_internal_links',
    category: 'internal_linking',
    title: 'Internal links marked nofollow',
    rationale: 'nofollow on internal links wastes link equity and is almost never intended.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => {
      const nf = p?.internalLinks.filter((l) => l.nofollow) ?? [];
      return p && nf.length ? [{ url: p.url, title: `${nf.length} nofollow internal link(s)`, description: nf.slice(0, 5).map((l) => l.href).join(', '), recommendation: 'Remove rel="nofollow" from internal links.', evidence: { links: nf.map((l) => l.href) } }] : [];
    },
  },
];

/* ───────────── Structured data rules ───────────── */
export const schemaRules: RuleDefinition[] = [
  {
    id: 'invalid_structured_data',
    category: 'schema',
    title: 'Invalid structured data',
    rationale: 'JSON-LD with syntax errors is ignored entirely by Google – none of its information is used.',
    scope: 'page',
    defaults: cfg('high'),
    check: (_ctx, _c, p) => {
      if (!p) return [];
      return p.structuredData
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => !b.valid)
        .map(({ b, i }) => ({ url: p.url, title: 'JSON-LD block is not valid JSON', description: b.error ?? 'Parse error', recommendation: 'Fix the JSON syntax (a suggested corrected block is generated in Recommendations).', evidence: { error: b.error, snippet: b.raw.slice(0, 800) }, key: String(i) }));
    },
  },
  {
    id: 'schema_missing_properties',
    category: 'schema',
    title: 'Structured data missing required properties',
    rationale: 'Incomplete markup is not eligible for enhanced results.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (_ctx, _c, p) => {
      if (!p) return [];
      return p.structuredData
        // Blocks re-loaded from storage without their payload can't be re-validated – skip rather than guess.
        .map((b, i) => ({ b, i, v: b.valid && b.data !== undefined ? validateJsonLd(b.data) : null }))
        .filter(({ v }) => v && v.errors.length)
        .map(({ i, v }) => ({ url: p.url, title: `Schema errors: ${v!.types.join(', ')}`, description: v!.errors.join('; '), recommendation: 'Add the missing properties.', evidence: { errors: v!.errors, warnings: v!.warnings }, key: String(i) }));
    },
  },
  {
    id: 'homepage_missing_org_schema',
    category: 'schema',
    title: 'Homepage lacks valid Organization/LocalBusiness schema',
    rationale: 'Organization data helps Google connect the site, logo and social profiles to the business entity.',
    scope: 'site',
    defaults: cfg('medium'),
    check: (ctx) => {
      const home = ctx.pages.find((p) => isHtmlOk(p) && pathOf(p.finalUrl) === '/');
      if (!home) return [];
      const types = home.structuredData.filter((b) => b.valid).flatMap((b) => b.types);
      const ok = types.some((t) => ['Organization', 'LocalBusiness', 'ProfessionalService', 'Corporation'].includes(t));
      return ok ? [] : [{ url: home.url, title: 'No valid Organization schema on homepage', description: home.structuredData.some((b) => !b.valid) ? 'An Organization block exists but fails to parse.' : 'No Organization markup found.', recommendation: 'Add a valid Organization + WebSite JSON-LD block (generated for you).', evidence: { validTypes: types } }];
    },
  },
  {
    id: 'service_page_missing_schema',
    category: 'schema',
    title: 'Service page without Service schema',
    rationale: 'Service markup describes what is offered, where, and by whom.',
    scope: 'page',
    defaults: cfg('low'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p) || !ctx.importantPaths.has(pathOf(p.url)) || pathOf(p.url) === '/') return [];
      const has = p.structuredData.some((b) => b.valid && b.types.includes('Service'));
      return has ? [] : [{ url: p.url, title: 'No Service schema', description: '', recommendation: 'Add Service + BreadcrumbList JSON-LD (generated for review).', evidence: {} }];
    },
  },
];

/* ───────────── Local SEO rules ───────────── */
const digits = (s: string) => s.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');

export const localRules: RuleDefinition[] = [
  {
    id: 'local_business_schema_missing',
    category: 'local',
    title: 'No LocalBusiness markup for a business with a physical office',
    rationale: 'LocalBusiness data (address, geo, phone) reinforces the Coimbatore location for local searches.',
    scope: 'site',
    defaults: cfg('medium'),
    check: (ctx) => {
      if (!ctx.profile.address) return [];
      const has = ctx.pages.some((p) => p.structuredData.some((b) => b.valid && b.types.some((t) => /LocalBusiness|ProfessionalService|Store|Agency/.test(t))));
      return has ? [] : [{ url: ctx.site.baseUrl, title: 'LocalBusiness / ProfessionalService schema missing', description: `Address on file: ${Object.values(ctx.profile.address).join(', ')}`, recommendation: 'Add ProfessionalService JSON-LD on the homepage/contact page using the exact NAP shown on the site.', evidence: {} }];
    },
  },
  {
    id: 'nap_inconsistent',
    category: 'local',
    title: 'Inconsistent phone numbers across pages',
    rationale: 'Consistent Name-Address-Phone data across the site and listings supports local trust signals.',
    scope: 'site',
    defaults: cfg('medium'),
    check: (ctx) => {
      if (!ctx.profile.phone) return [];
      const expected = digits(ctx.profile.phone);
      const found = new Map<string, Set<string>>();
      for (const p of ctx.pages) {
        if (!isHtmlOk(p)) continue;
        for (const d of p.signals.phones ?? []) {
          if (d.length === 10) (found.get(d) ?? found.set(d, new Set()).get(d)!).add(p.url);
        }
      }
      const others = [...found.keys()].filter((d) => d !== expected);
      return others.length ? [{ url: null, title: `${others.length} phone number(s) differ from the business profile`, description: others.map((o) => `${o} on ${[...found.get(o)!].slice(0, 3).join(', ')}`).join('; '), recommendation: 'Use one primary phone number consistently, or document why multiple numbers exist.', evidence: { expected, others } }] : [];
    },
  },
  {
    id: 'location_not_in_service_titles',
    category: 'local',
    title: 'Service page title does not mention the target city',
    rationale: 'For local-intent services, including the city in the title aligns with how customers search (e.g. "website design Coimbatore").',
    scope: 'page',
    defaults: cfg('info'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p) || !p.title || !ctx.importantPaths.has(pathOf(p.url)) || pathOf(p.url) === '/') return [];
      const city = ctx.profile.locations.find((l) => l.target && l.level === 'city');
      if (!city || city.aliases.some((a) => p.title!.toLowerCase().includes(a))) return [];
      return [{ url: p.url, title: `Title omits "${city.name}"`, description: p.title, recommendation: `Consider including ${city.name} if Search Console shows local demand for this service.`, evidence: { title: p.title } }];
    },
  },
];
