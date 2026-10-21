import { detectLocations, detectServices, stem, tokenize, type BusinessProfile } from '@phoenixx/shared';

/**
 * Competitor comparison on STRUCTURE only (titles, headings, topics, coverage).
 * No competitor body copy is stored or reused – output is "Phoenixx has / competitor has / opportunity".
 */
export interface SitePageSummary {
  url: string;
  title: string | null;
  h1: string | null;
  h2s: string[];
  wordCount: number | null;
  schemaTypes?: string[];
}

export interface CompetitorSummary {
  name: string;
  baseUrl: string;
  pages: SitePageSummary[];
}

export interface CoverageRow {
  dimension: 'service' | 'location' | 'topic' | 'page_type' | 'schema' | 'depth';
  item: string;
  phoenixxHas: string;
  competitorsHave: { name: string; evidence: string }[];
  opportunity: string;
  strength: number; // how many competitors cover it
}

function pageText(p: SitePageSummary) {
  return [p.title, p.h1, ...p.h2s].filter(Boolean).join(' . ');
}

function topicTerms(pages: SitePageSummary[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of pages) {
    const toks = tokenize([p.title, p.h1, ...p.h2s].filter(Boolean).join(' ')).map(stem);
    const grams = new Set<string>();
    for (let i = 0; i + 1 < toks.length; i++) grams.add(`${toks[i]} ${toks[i + 1]}`);
    for (const g of grams) m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

const PAGE_TYPES: { id: string; re: RegExp; label: string }[] = [
  { id: 'blog', re: /\/(blog|insights|articles|news|resources)\b/i, label: 'Blog / insights section' },
  { id: 'case_study', re: /\/(case-stud|portfolio|our-work|work)\b/i, label: 'Case studies / portfolio' },
  { id: 'about', re: /\/about/i, label: 'Dedicated About page' },
  { id: 'contact', re: /\/contact/i, label: 'Dedicated Contact page' },
  { id: 'careers', re: /\/(careers|jobs)/i, label: 'Careers page' },
  { id: 'industries', re: /\/(industr|sectors)/i, label: 'Industry pages' },
  { id: 'pricing', re: /\/(pricing|plans|packages)/i, label: 'Pricing / packages page' },
];

export function compareCompetitors(own: SitePageSummary[], competitors: CompetitorSummary[], profile: BusinessProfile): CoverageRow[] {
  const rows: CoverageRow[] = [];
  const ownText = own.map(pageText).join(' \n ');
  const ownServices = new Set(detectServices(ownText, profile.services));
  const ownLocations = new Set(detectLocations(ownText, profile.locations));

  for (const svc of profile.services) {
    const has = competitors
      .map((c) => {
        const pages = c.pages.filter((p) => detectServices(pageText(p), [svc]).length);
        return pages.length ? { name: c.name, evidence: `${pages.length} page(s), e.g. "${pages[0]!.title ?? pages[0]!.url}"` } : null;
      })
      .filter(Boolean) as { name: string; evidence: string }[];
    if (!has.length) continue;
    const ownPage = svc.path ? own.find((p) => new URL(p.url).pathname === svc.path) : undefined;
    const phoenixxHas = ownPage ? `Dedicated page ${svc.path}` : ownServices.has(svc.id) ? 'Mentioned, no dedicated page' : 'Not covered';
    if (ownPage) continue;
    rows.push({ dimension: 'service', item: svc.name, phoenixxHas, competitorsHave: has, opportunity: ownServices.has(svc.id) ? `Consider a dedicated ${svc.name} page if Search Console shows demand.` : `Evaluate whether ${svc.name} is a real Phoenixx IT offering before creating content.`, strength: has.length });
  }

  for (const loc of profile.locations) {
    const has = competitors
      .map((c) => {
        const pages = c.pages.filter((p) => detectLocations(pageText(p), [loc]).length);
        return pages.length ? { name: c.name, evidence: `${pages.length} page(s) target ${loc.name}` } : null;
      })
      .filter(Boolean) as { name: string; evidence: string }[];
    if (!has.length || ownLocations.has(loc.id)) continue;
    rows.push({ dimension: 'location', item: loc.name, phoenixxHas: 'No page titles/headings mention this location', competitorsHave: has, opportunity: loc.target ? `Reference ${loc.name} naturally on relevant service pages.` : `Only pursue ${loc.name} if the business genuinely serves it and search data shows demand.`, strength: has.length });
  }

  for (const t of PAGE_TYPES) {
    const has = competitors.filter((c) => c.pages.some((p) => t.re.test(p.url))).map((c) => ({ name: c.name, evidence: c.pages.find((p) => t.re.test(p.url))!.url }));
    if (!has.length || own.some((p) => t.re.test(p.url))) continue;
    rows.push({ dimension: 'page_type', item: t.label, phoenixxHas: 'None', competitorsHave: has, opportunity: `Add a ${t.label.toLowerCase()} built from Phoenixx IT's own, verifiable material.`, strength: has.length });
  }

  const ownTopics = topicTerms(own);
  const compTopics = new Map<string, { name: string; evidence: string }[]>();
  for (const c of competitors) for (const [g] of topicTerms(c.pages)) compTopics.set(g, [...(compTopics.get(g) ?? []), { name: c.name, evidence: 'titles/headings' }]);
  [...compTopics.entries()]
    .filter(([g, list]) => !ownTopics.has(g) && list.length >= Math.max(2, Math.ceil(competitors.length / 2)))
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 25)
    .forEach(([g, list]) => rows.push({ dimension: 'topic', item: g, phoenixxHas: 'Not in titles/headings', competitorsHave: list, opportunity: 'Topic gap – review whether it matches a Phoenixx IT service and user intent.', strength: list.length }));

  const ownSchema = new Set(own.flatMap((p) => p.schemaTypes ?? []));
  const compSchema = new Map<string, string[]>();
  for (const c of competitors) for (const t of new Set(c.pages.flatMap((p) => p.schemaTypes ?? []))) compSchema.set(t, [...(compSchema.get(t) ?? []), c.name]);
  for (const [t, names] of compSchema) if (!ownSchema.has(t) && !['AggregateRating', 'Review'].includes(t)) rows.push({ dimension: 'schema', item: t, phoenixxHas: 'Not used', competitorsHave: names.map((n) => ({ name: n, evidence: 'JSON-LD' })), opportunity: `Use ${t} markup only where it truthfully describes page content.`, strength: names.length });

  const avg = (ps: SitePageSummary[]) => Math.round(ps.reduce((s, p) => s + (p.wordCount ?? 0), 0) / Math.max(1, ps.length));
  const ownAvg = avg(own);
  const comp = competitors.map((c) => ({ name: c.name, avg: avg(c.pages) })).filter((c) => c.avg > ownAvg * 1.5);
  if (comp.length) rows.push({ dimension: 'depth', item: 'Average page depth (words)', phoenixxHas: `${ownAvg} words/page`, competitorsHave: comp.map((c) => ({ name: c.name, evidence: `${c.avg} words/page` })), opportunity: 'Competitors publish more in-depth pages; expand key service pages with genuinely useful detail.', strength: comp.length });

  return rows.sort((a, b) => b.strength - a.strength);
}
