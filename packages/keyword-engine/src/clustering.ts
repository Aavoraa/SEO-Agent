import { jaccard, stem, tokenize, slugify, type BusinessProfile, type Intent } from '@phoenixx/shared';
import { normalizeKeyword } from './intent.js';

export interface ClusterInputKeyword {
  keyword: string;
  intent: Intent;
  services: string[];
  locations: string[];
  impressions: number;
  clicks: number;
  position: number | null;
  /** Pages that received impressions for this keyword (from GSC). */
  pages: { url: string; impressions: number }[];
  isQuestion: boolean;
}

export interface KeywordCluster {
  key: string;
  name: string;
  intent: Intent;
  keywords: string[];
  services: string[];
  locations: string[];
  totalImpressions: number;
  totalClicks: number;
  strategy: 'single_page' | 'separate_pages' | 'faq' | 'blog' | 'existing_page';
  recommendedPageType: string;
  targetPageUrl: string | null;
  rationale: string;
  cannibalization: { url: string; impressions: number; share: number }[];
}

// Location words are removed for topic similarity so "it company coimbatore" and "it companies in coimbatore" group.
function topicTokens(k: string, profile: BusinessProfile): Set<string> {
  const locWords = new Set(profile.locations.flatMap((l) => l.aliases.flatMap((a) => a.split(' '))));
  return new Set(tokenize(normalizeKeyword(k)).filter((t) => !locWords.has(t)).map(stem));
}

/**
 * Deterministic clustering:
 *  1. Seed groups by (primary service, location) so "IT company Coimbatore" variants stay together.
 *  2. Within/among remaining keywords, merge by token Jaccard ≥ threshold (single-link, highest demand first).
 * Then decide the page strategy and detect cannibalisation from GSC page distribution.
 */
export function clusterKeywords(input: ClusterInputKeyword[], profile: BusinessProfile, opts: { threshold?: number } = {}): KeywordCluster[] {
  const threshold = opts.threshold ?? 0.5;
  const sorted = [...input].sort((a, b) => b.impressions - a.impressions);
  const groups: { seed: ClusterInputKeyword; members: ClusterInputKeyword[]; tokens: Set<string> }[] = [];
  for (const kw of sorted) {
    const toks = topicTokens(kw.keyword, profile);
    let best: (typeof groups)[number] | null = null;
    let bestSim = 0;
    for (const g of groups) {
      const sameService = kw.services.length && g.seed.services.length && kw.services[0] === g.seed.services[0];
      const sameLoc = (kw.locations[0] ?? '') === (g.seed.locations[0] ?? '');
      const sameQuestionness = kw.isQuestion === g.seed.isQuestion;
      let sim = jaccard(toks, g.tokens);
      if (sameService && sameLoc && sameQuestionness) sim = Math.max(sim, 0.6);
      if (!sameQuestionness) sim *= 0.5; // questions become FAQ/blog clusters, not service clusters
      if (sim > bestSim) {
        bestSim = sim;
        best = g;
      }
    }
    if (best && bestSim >= threshold) {
      best.members.push(kw);
      for (const t of toks) best.tokens.add(t);
    } else groups.push({ seed: kw, members: [kw], tokens: toks });
  }

  return groups.map(({ seed, members }) => {
    const totalImpressions = members.reduce((s, m) => s + m.impressions, 0);
    const totalClicks = members.reduce((s, m) => s + m.clicks, 0);
    const services = [...new Set(members.flatMap((m) => m.services))];
    const locations = [...new Set(members.flatMap((m) => m.locations))];
    const intentCounts = new Map<Intent, number>();
    for (const m of members) intentCounts.set(m.intent, (intentCounts.get(m.intent) ?? 0) + m.impressions + 1);
    const intent = [...intentCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    const pageImp = new Map<string, number>();
    for (const m of members) for (const p of m.pages) pageImp.set(p.url, (pageImp.get(p.url) ?? 0) + p.impressions);
    const pages = [...pageImp.entries()].sort((a, b) => b[1] - a[1]);
    const pageTotal = pages.reduce((s, [, n]) => s + n, 0) || 1;
    // Cannibalisation: 2+ pages each holding ≥ 20% of the cluster's impressions.
    const competing = pages.filter(([, n]) => n / pageTotal >= 0.2);
    const cannibalization = competing.length >= 2 ? competing.map(([url, n]) => ({ url, impressions: n, share: Math.round((n / pageTotal) * 100) / 100 })) : [];
    const svc = profile.services.find((s) => s.id === services[0]);
    const existingServicePage = svc?.path ? new URL(svc.path, profile.url).toString() : null;
    const allQuestions = members.every((m) => m.isQuestion);
    let strategy: KeywordCluster['strategy'];
    let recommendedPageType: string;
    let targetPageUrl: string | null = pages[0]?.[0] ?? null;
    let rationale: string;
    if (allQuestions) {
      strategy = members.length <= 3 && svc ? 'faq' : 'blog';
      recommendedPageType = strategy === 'faq' ? 'FAQ section on service page' : 'Blog article';
      targetPageUrl = strategy === 'faq' ? (existingServicePage ?? targetPageUrl) : null;
      rationale = strategy === 'faq' ? 'Short, specific questions about a service are best answered in an FAQ block on that service page.' : 'Informational questions need a dedicated, in-depth article that links to the relevant service.';
    } else if (intent === 'informational') {
      strategy = 'blog';
      recommendedPageType = 'Blog article / guide';
      rationale = 'Informational intent – searchers want to learn, not buy yet. A guide can link to the service page.';
    } else if (existingServicePage || targetPageUrl) {
      strategy = 'existing_page';
      recommendedPageType = 'Existing service page';
      targetPageUrl = existingServicePage ?? targetPageUrl;
      rationale = `Same intent as an existing page – optimise ${targetPageUrl ? new URL(targetPageUrl).pathname : 'it'} for the whole cluster instead of creating competing pages.`;
    } else {
      strategy = 'single_page';
      recommendedPageType = 'New service page';
      rationale = 'Commercial intent with no page targeting it. One comprehensive page should target all variants.';
    }
    if (cannibalization.length) rationale += ` Warning: ${cannibalization.length} pages compete for these queries – consolidate signals on one target.`;
    const locName = profile.locations.find((l) => l.id === locations[0])?.name;
    const name = svc ? `${svc.name}${locName ? ` – ${locName}` : ''}${allQuestions ? ' (questions)' : ''}` : seed.keyword;
    return {
      key: slugify(`${svc?.id ?? seed.keyword}-${locations[0] ?? 'any'}-${allQuestions ? 'q' : intent}`).slice(0, 120),
      name,
      intent,
      keywords: members.map((m) => m.keyword),
      services,
      locations,
      totalImpressions,
      totalClicks,
      strategy,
      recommendedPageType,
      targetPageUrl,
      rationale,
      cannibalization,
    };
  });
}
