import { jaccard, stem, tokenize, round, type Severity } from '@phoenixx/shared';

/**
 * SEO Migration Monitor – compares a pre-redesign baseline snapshot with the new site
 * (staging or live) and produces a redirect map + regression list. Critical for the
 * Phoenixx IT redesign: every URL with traffic or links must survive or be 301-redirected.
 */
export interface SnapshotPage {
  path: string;
  url: string;
  statusCode: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  indexable: boolean | null;
  inlinks: number;
  clicks: number;
  impressions: number;
}

export interface MigrationFinding {
  severity: Severity;
  type: 'missing_page' | 'status_changed' | 'redirected' | 'title_changed' | 'meta_changed' | 'h1_changed' | 'canonical_changed' | 'indexability_lost' | 'inlinks_dropped' | 'new_page';
  path: string;
  before: string | null;
  after: string | null;
  message: string;
  clicks: number;
  impressions: number;
  suggestedRedirect?: { to: string; confidence: number; basis: string } | null;
}

export interface MigrationComparison {
  summary: {
    baselinePages: number;
    newPages: number;
    preserved: number;
    missing: number;
    redirected: number;
    atRiskClicks: number;
    atRiskImpressions: number;
    critical: number;
    high: number;
  };
  findings: MigrationFinding[];
  redirectMap: { from: string; to: string; confidence: number; basis: string }[];
}

function textSim(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  return jaccard(new Set(tokenize(a).map(stem)), new Set(tokenize(b).map(stem)));
}

function slugTokens(path: string) {
  return new Set(tokenize(path.replace(/[/_.-]+/g, ' ')).map(stem));
}

/** Find the most likely replacement page for a removed URL (slug + title + H1 similarity). */
export function suggestRedirect(old: SnapshotPage, candidates: SnapshotPage[]): { to: string; confidence: number; basis: string } | null {
  let best: { to: string; confidence: number; basis: string } | null = null;
  for (const c of candidates) {
    if (c.statusCode !== 200) continue;
    const slug = jaccard(slugTokens(old.path), slugTokens(c.path));
    const title = textSim(old.title, c.title);
    const h1 = textSim(old.h1, c.h1);
    const conf = round(slug * 0.45 + title * 0.35 + h1 * 0.2, 2);
    if (!best || conf > best.confidence) best = { to: c.path, confidence: conf, basis: `slug ${round(slug, 2)}, title ${round(title, 2)}, h1 ${round(h1, 2)}` };
  }
  return best && best.confidence >= 0.2 ? best : null;
}

export function compareSnapshots(baseline: SnapshotPage[], current: SnapshotPage[], opts: { treatTrafficAs?: number } = {}): MigrationComparison {
  const cur = new Map(current.map((p) => [p.path.replace(/\/$/, '') || '/', p]));
  const findings: MigrationFinding[] = [];
  const redirectMap: MigrationComparison['redirectMap'] = [];
  const trafficThreshold = opts.treatTrafficAs ?? 1;
  let preserved = 0;
  let missing = 0;
  let redirected = 0;
  let atRiskClicks = 0;
  let atRiskImpressions = 0;
  const liveCandidates = current.filter((c) => c.statusCode === 200);
  for (const old of baseline) {
    if (old.statusCode !== 200) continue;
    const key = old.path.replace(/\/$/, '') || '/';
    const now = cur.get(key);
    const hasTraffic = old.clicks >= trafficThreshold || old.impressions >= 50;
    const base = { path: old.path, clicks: old.clicks, impressions: old.impressions };
    if (!now || now.statusCode === null || now.statusCode >= 400) {
      missing++;
      atRiskClicks += old.clicks;
      atRiskImpressions += old.impressions;
      const sug = suggestRedirect(old, liveCandidates);
      if (sug) redirectMap.push({ from: old.path, ...sug });
      findings.push({ ...base, severity: hasTraffic || old.inlinks >= 3 || old.path === '/' ? 'critical' : 'high', type: 'missing_page', before: `${old.statusCode}`, after: now ? `${now.statusCode ?? 'error'}` : 'not found', message: `URL no longer resolves${hasTraffic ? ` – it earned ${old.clicks} clicks / ${old.impressions} impressions` : ''}. ${sug ? `Suggested 301 → ${sug.to}` : 'No close replacement found – map manually.'}`, suggestedRedirect: sug });
      continue;
    }
    if (now.statusCode >= 300) {
      redirected++;
      findings.push({ ...base, severity: 'info', type: 'redirected', before: '200', after: `${now.statusCode}`, message: 'URL now redirects. Confirm it is a single-hop 301 to the most relevant page.' });
      continue;
    }
    preserved++;
    if ((old.title ?? '') !== (now.title ?? '')) {
      const sim = textSim(old.title, now.title);
      findings.push({ ...base, severity: hasTraffic && sim < 0.5 ? 'high' : 'medium', type: 'title_changed', before: old.title, after: now.title, message: `Title changed (similarity ${round(sim, 2)}).${hasTraffic ? ' This page has search traffic – keep ranking terms.' : ''}` });
    }
    if ((old.h1 ?? '') !== (now.h1 ?? '')) findings.push({ ...base, severity: !now.h1 ? 'high' : 'low', type: 'h1_changed', before: old.h1, after: now.h1, message: now.h1 ? 'H1 changed.' : 'H1 removed in the new design.' });
    if ((old.metaDescription ?? '') !== (now.metaDescription ?? '')) findings.push({ ...base, severity: now.metaDescription ? 'low' : 'medium', type: 'meta_changed', before: old.metaDescription, after: now.metaDescription, message: now.metaDescription ? 'Meta description changed.' : 'Meta description removed.' });
    const normCanon = (c: string | null) => (c ? c.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '') || '/' : null);
    if (normCanon(old.canonical) !== normCanon(now.canonical)) findings.push({ ...base, severity: 'high', type: 'canonical_changed', before: old.canonical, after: now.canonical, message: 'Canonical target changed – verify it still self-references.' });
    if (old.indexable && now.indexable === false) findings.push({ ...base, severity: 'critical', type: 'indexability_lost', before: 'indexable', after: 'not indexable', message: 'Page became non-indexable (noindex, canonical or robots). Staging noindex tags must not ship to production.' });
    if (old.inlinks >= 3 && now.inlinks < old.inlinks / 2) findings.push({ ...base, severity: 'medium', type: 'inlinks_dropped', before: String(old.inlinks), after: String(now.inlinks), message: 'Internal links to this page dropped by more than half.' });
  }
  const oldPaths = new Set(baseline.map((b) => b.path.replace(/\/$/, '') || '/'));
  for (const c of current) if (!oldPaths.has(c.path.replace(/\/$/, '') || '/') && c.statusCode === 200) findings.push({ path: c.path, clicks: 0, impressions: 0, severity: 'info', type: 'new_page', before: null, after: c.title, message: 'New URL in the redesigned site.' });
  const rank: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  findings.sort((a, b) => rank[b.severity] - rank[a.severity] || b.clicks - a.clicks);
  return {
    summary: {
      baselinePages: baseline.filter((b) => b.statusCode === 200).length,
      newPages: current.filter((c) => c.statusCode === 200).length,
      preserved,
      missing,
      redirected,
      atRiskClicks,
      atRiskImpressions,
      critical: findings.filter((f) => f.severity === 'critical').length,
      high: findings.filter((f) => f.severity === 'high').length,
    },
    findings,
    redirectMap,
  };
}

/** Apache .htaccess / nginx snippets for the proposed redirect map (for manual review and deployment). */
export function redirectRules(map: { from: string; to: string }[], server: 'apache' | 'nginx' = 'apache'): string {
  if (server === 'nginx') return map.map((r) => `location = ${r.from} { return 301 ${r.to}; }`).join('\n');
  return ['# Generated by Phoenixx SEO Agent – review before deploying', ...map.map((r) => `Redirect 301 ${r.from} ${r.to}`)].join('\n');
}
