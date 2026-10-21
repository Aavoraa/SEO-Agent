import type { AnalyzeResult } from '@phoenixx/seo-engine';
import type { CrawlOutput, CrawledPage } from '@phoenixx/shared';

/**
 * SEO inventory + migration baseline built from one crawl, without a database. Used for the
 * first look at a site (e.g. phoenixxit.com before its redesign). Search Console traffic, keywords
 * and backlinks are listed as "unavailable" here – they are added when the project's integrations
 * are connected and a `migration-snapshot` job runs in the platform.
 */
export interface BaselineFiles {
  'inventory.csv': string;
  'internal-links.csv': string;
  'issues.csv': string;
  'baseline.json': string;
  'site-profile.json': string;
  'SUMMARY.md': string;
}

const csv = (rows: Record<string, unknown>[]) => {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]!);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join(' | ') : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
};

const pathOf = (u: string) => {
  try {
    return new URL(u).pathname;
  } catch {
    return u;
  }
};

export function buildBaseline(out: CrawlOutput, analysis: AnalyzeResult, capturedAt = new Date()): BaselineFiles {
  const issuesByUrl = new Map<string, { critical: number; high: number; medium: number; low: number; info: number }>();
  for (const i of analysis.issues) {
    if (!i.url) continue;
    const c = issuesByUrl.get(i.url) ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    c[i.severity]++;
    issuesByUrl.set(i.url, c);
  }
  const page = (p: CrawledPage) => {
    const validSchema = p.structuredData.filter((s) => s.valid);
    const iss = issuesByUrl.get(p.url);
    return {
      url: p.url,
      path: pathOf(p.url),
      status: p.redirectChain.length ? p.redirectChain[0]!.status : p.statusCode,
      final_url: p.finalUrl !== p.url ? p.finalUrl : '',
      redirect_hops: p.redirectChain.length,
      indexable: p.indexable,
      indexability_reason: p.indexabilityReason ?? '',
      in_sitemap: p.inSitemap,
      depth: p.depth,
      title: p.title ?? '',
      title_length: p.title?.length ?? 0,
      meta_description: p.metaDescription ?? '',
      meta_description_length: p.metaDescription?.length ?? 0,
      h1: p.h1s[0] ?? '',
      h1_count: p.h1s.length,
      h2_count: p.h2s.length,
      canonical: p.canonical ?? '',
      canonical_self: p.canonical ? p.canonical === p.url || p.canonical === p.finalUrl : '',
      robots_meta: p.robotsMeta ?? '',
      word_count: p.wordCount,
      internal_inlinks: analysis.inlinks.get(p.url)?.size ?? 0,
      internal_outlinks: new Set(p.internalLinks.map((l) => l.href)).size,
      external_links: new Set(p.externalLinks.map((l) => l.href)).size,
      images: p.images.length,
      images_missing_alt: p.images.filter((i) => !i.hasAlt).length,
      schema_types: [...new Set(validSchema.flatMap((s) => s.types))],
      invalid_json_ld: p.structuredData.length - validSchema.length,
      og_image: p.openGraph['og:image'] ?? '',
      lang: p.lang ?? '',
      response_ms: p.responseTimeMs ?? '',
      encoding_errors: p.signals?.mojibakeCount ?? 0,
      content_hash: p.contentHash ?? '',
      issues_high_or_worse: iss ? iss.critical + iss.high : 0,
      issues_total: iss ? Object.values(iss).reduce((a, b) => a + b, 0) : 0,
    };
  };
  const inventory = out.pages.map(page);
  const edges = out.pages.flatMap((p) => p.internalLinks.map((l) => ({ source: p.url, target: l.href, anchor: l.anchor, nofollow: l.nofollow })));
  const issues = analysis.issues.map((i) => ({ severity: i.severity, rule: i.ruleId, category: i.category, url: i.url ?? '', title: i.title, recommendation: i.recommendation }));
  const bySeverity = Object.fromEntries(['critical', 'high', 'medium', 'low', 'info'].map((s) => [s, analysis.issues.filter((i) => i.severity === s).length]));
  const rules = [...new Set(analysis.issues.map((i) => i.ruleId))].map((r) => {
    const list = analysis.issues.filter((i) => i.ruleId === r);
    return { rule: r, severity: list[0]!.severity, count: list.length, example: list[0]!.title };
  });
  const sevRank = { critical: 5, high: 4, medium: 3, low: 2, info: 1 } as const;
  rules.sort((a, b) => sevRank[b.severity] - sevRank[a.severity] || b.count - a.count);

  const baseline = {
    kind: 'migration-baseline',
    capturedAt: capturedAt.toISOString(),
    siteUrl: out.baseUrl,
    dataLabel: 'verified',
    source: 'crawler',
    crawl: { startedAt: out.startedAt, finishedAt: out.finishedAt, ...out.stats },
    healthScore: analysis.healthScore,
    issuesBySeverity: bySeverity,
    site: {
      robots: out.site.robots,
      sitemaps: out.site.sitemaps,
      sitemapUrlCount: out.site.sitemapUrls.length,
      https: out.site.https,
      hostCanonicalization: out.site.hostCanonicalization,
      notFoundHandling: out.site.notFoundHandling,
    },
    // Not collected by a crawl – filled by the platform's migration-snapshot job once connected.
    unavailable: {
      organicTraffic: 'Connect Google Search Console (clicks/impressions per URL)',
      keywords: 'Connect Google Search Console (queries per URL)',
      backlinks: 'Import the Search Console Links export in Backlinks',
    },
    pages: inventory.map(({ issues_high_or_worse: _a, issues_total: _b, ...p }) => p),
    internalLinks: edges.length,
  };

  const indexable = inventory.filter((p) => p.indexable);
  const tech = out.site.profile;
  const md = [
    `# SEO baseline – ${out.baseUrl}`,
    '',
    `Captured ${capturedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC by the Phoenixx crawler (data label: **Verified** – first-party crawl).`,
    '',
    '## At a glance',
    '',
    `| | |`,
    `|---|---|`,
    `| URLs crawled | ${out.stats.pagesCrawled} (${out.stats.pagesFailed} failed) |`,
    `| Indexable pages | ${indexable.length} |`,
    `| URLs in sitemap | ${out.site.sitemapUrls.length} |`,
    `| Internal links | ${edges.length} |`,
    `| Health score (internal diagnostic, not a Google metric) | ${analysis.healthScore.score}/100 (${analysis.healthScore.grade}) |`,
    `| Issues | ${Object.entries(bySeverity).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(', ') || 'none'} |`,
    ...(tech
      ? [
          `| Server | ${tech.server ?? 'unknown'} |`,
          `| Rendering | ${tech.rendering} – ${tech.renderingNote} |`,
          `| Technologies | ${tech.technologies.map((t) => t.name).join(', ') || 'none detected'} |`,
          `| Analytics | ${[...tech.analytics.ga4, ...tech.analytics.gtm].join(', ') || 'none detected'} |`,
          `| AI search crawlers allowed | ${tech.aiCrawlers.filter((c) => c.purpose !== 'training' && c.allowed).length}/${tech.aiCrawlers.filter((c) => c.purpose !== 'training').length} |`,
          `| llms.txt | ${tech.llmsTxt.found ? 'present' : `not present (HTTP ${tech.llmsTxt.status ?? '—'})`} |`,
        ]
      : []),
    '',
    '## Pages',
    '',
    '| Path | Status | Indexable | Title (chars) | Meta (chars) | H1s | Words | Inlinks | Schema |',
    '|---|---|---|---|---|---|---|---|---|',
    ...inventory.map((p) => `| \`${p.path}\` | ${p.status ?? '—'} | ${p.indexable ? 'yes' : `no – ${p.indexability_reason}`} | ${p.title_length} | ${p.meta_description_length} | ${p.h1_count} | ${p.word_count} | ${p.internal_inlinks} | ${p.schema_types.join(', ') || (p.invalid_json_ld ? 'invalid JSON-LD' : '—')} |`),
    '',
    '## Issues by rule',
    '',
    '| Severity | Rule | Count | Example |',
    '|---|---|---|---|',
    ...rules.map((r) => `| ${r.severity} | \`${r.rule}\` | ${r.count} | ${r.example.replace(/\|/g, '\\|')} |`),
    '',
    '## Not in this baseline',
    '',
    ...Object.entries(baseline.unavailable).map(([k, v]) => `- **${k}** – unavailable: ${v}.`),
    '',
    'Files: `inventory.csv` (one row per URL), `internal-links.csv` (every internal link), `issues.csv`, `baseline.json` (migration baseline), `site-profile.json`.',
    '',
  ].join('\n');

  return {
    'inventory.csv': csv(inventory),
    'internal-links.csv': csv(edges),
    'issues.csv': csv(issues),
    'baseline.json': JSON.stringify(baseline, null, 2),
    'site-profile.json': JSON.stringify(out.site.profile ?? null, null, 2),
    'SUMMARY.md': md,
  };
}
