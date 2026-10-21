import { stem, tokenize, round, type BusinessProfile, type CrawledPage, type Priority } from '@phoenixx/shared';
import { isHtmlOk, pathOf } from './rules/types.js';

/**
 * Internal linking engine: builds a TF-IDF topic vector per page and proposes links
 * from topically related pages that do not yet link to important/under-linked targets.
 * Suggestions are recommendations only – nothing is inserted without approval.
 */
export interface LinkSuggestion {
  sourceUrl: string;
  targetUrl: string;
  anchorText: string;
  reason: string;
  priority: Priority;
  score: number;
  similarity: number;
}

export interface LinkGraphStats {
  url: string;
  inlinks: number;
  outlinks: number;
  depth: number;
  orphan: boolean;
  pageType: string;
}

type Vec = Map<string, number>;

function termsOf(p: CrawledPage): string[] {
  const weighted = [p.title ?? '', p.title ?? '', ...p.h1s, ...p.h1s, ...p.h2s, p.metaDescription ?? '', p.textSample];
  return tokenize(weighted.join(' ')).map(stem);
}

function tfidf(docs: string[][]): Vec[] {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  return docs.map((d) => {
    const tf = new Map<string, number>();
    for (const t of d) tf.set(t, (tf.get(t) ?? 0) + 1);
    const v: Vec = new Map();
    let norm = 0;
    for (const [t, f] of tf) {
      const w = (1 + Math.log(f)) * Math.log((N + 1) / ((df.get(t) ?? 0) + 1));
      if (w > 0) {
        v.set(t, w);
        norm += w * w;
      }
    }
    norm = Math.sqrt(norm) || 1;
    for (const [t, w] of v) v.set(t, w / norm);
    return v;
  });
}

function cosine(a: Vec, b: Vec): number {
  let s = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const [t, w] of small) s += w * (big.get(t) ?? 0);
  return s;
}

/** Anchor text: prefer the service name (+ city for local services) over generic "click here". */
export function suggestAnchor(target: CrawledPage, profile: BusinessProfile): string {
  const path = pathOf(target.finalUrl);
  const svc = profile.services.find((s) => s.path === path);
  const city = profile.locations.find((l) => l.target && l.level === 'city');
  if (svc) return city && /coimbatore/i.test(target.title ?? '') ? `${svc.name.toLowerCase()} in ${city.name}` : svc.name.toLowerCase();
  const base = (target.h1s[0] ?? target.title ?? path).split(/[|–—-]/)[0]!.trim();
  return base.length > 60 ? base.slice(0, 60) : base;
}

export function analyzeInternalLinks(pages: CrawledPage[], inlinks: Map<string, Set<string>>, profile: BusinessProfile, opts: { importantPaths?: Set<string>; minSimilarity?: number; maxPerSource?: number; pageImpressions?: Map<string, number> } = {}) {
  const ok = pages.filter((p) => isHtmlOk(p) && p.indexable);
  const vecs = tfidf(ok.map(termsOf));
  const important = opts.importantPaths ?? new Set(['/', ...profile.services.filter((s) => s.path).map((s) => s.path!)]);
  const minSim = opts.minSimilarity ?? 0.12;
  const stats: LinkGraphStats[] = ok.map((p) => ({
    url: p.url,
    inlinks: inlinks.get(p.url)?.size ?? 0,
    outlinks: new Set(p.internalLinks.map((l) => l.href)).size,
    depth: p.depth,
    orphan: (inlinks.get(p.url)?.size ?? 0) === 0 && pathOf(p.url) !== '/',
    pageType: important.has(pathOf(p.url)) ? 'important' : 'standard',
  }));
  const suggestions: LinkSuggestion[] = [];
  for (let i = 0; i < ok.length; i++) {
    const src = ok[i]!;
    const existing = new Set(src.internalLinks.map((l) => l.href));
    const candidates: LinkSuggestion[] = [];
    for (let j = 0; j < ok.length; j++) {
      if (i === j) continue;
      const tgt = ok[j]!;
      const tPath = pathOf(tgt.url);
      if (tPath === '/' || existing.has(tgt.url) || existing.has(tgt.finalUrl) || /privacy|terms|cookie/i.test(tPath)) continue;
      const sim = cosine(vecs[i]!, vecs[j]!);
      const tgtIn = inlinks.get(tgt.url)?.size ?? 0;
      const isImportant = important.has(tPath);
      if (sim < minSim && !(tgtIn === 0 && sim > minSim / 2)) continue;
      const needScore = tgtIn === 0 ? 1 : tgtIn < 3 ? 0.6 : 0.2;
      const imp = opts.pageImpressions?.get(tgt.url) ?? 0;
      const score = round(sim * 60 + needScore * 25 + (isImportant ? 10 : 0) + Math.min(5, Math.log10(imp + 1)), 1);
      const reasons = [`Topical similarity ${round(sim, 2)}`];
      if (tgtIn === 0) reasons.push('target is an orphan page');
      else if (tgtIn < 3) reasons.push(`target has only ${tgtIn} internal link(s)`);
      if (isImportant) reasons.push('target is a core service page');
      candidates.push({
        sourceUrl: src.url,
        targetUrl: tgt.url,
        anchorText: suggestAnchor(tgt, profile),
        reason: reasons.join('; '),
        priority: score >= 45 ? 'high' : score >= 28 ? 'medium' : 'low',
        score,
        similarity: round(sim, 3),
      });
    }
    candidates.sort((a, b) => b.score - a.score);
    suggestions.push(...candidates.slice(0, opts.maxPerSource ?? 3));
  }
  suggestions.sort((a, b) => b.score - a.score);
  return { stats, suggestions };
}
