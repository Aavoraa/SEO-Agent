#!/usr/bin/env node
/**
 * Standalone crawl + audit (no database needed).
 *   npm run crawl -- https://www.phoenixxit.com/ --max 100 --out ./exports/audit.json
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, SEVERITY_RANK } from '@phoenixx/shared';
import { analyzeSite } from '@phoenixx/seo-engine';
import { crawlSite } from './crawler.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

const cfg = loadConfig();
const url = process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? cfg.SEO_SITE_URL;
const max = Number(arg('max') ?? cfg.CRAWL_MAX_PAGES);

const out = await crawlSite({
  baseUrl: url,
  maxPages: max,
  concurrency: cfg.CRAWL_CONCURRENCY,
  delayMs: cfg.CRAWL_DELAY_MS,
  timeoutMs: cfg.CRAWL_TIMEOUT_MS,
  userAgent: cfg.CRAWL_USER_AGENT,
  checkExternalLinks: process.argv.includes('--external'),
});
const analysis = analyzeSite({ pages: out.pages, site: out.site, externalLinkStatus: out.externalLinkStatus });

const counts: Record<string, number> = {};
for (const i of analysis.issues) counts[i.severity] = (counts[i.severity] ?? 0) + 1;
console.log(`\nCrawled ${out.stats.pagesCrawled} URLs from ${out.baseUrl} in ${out.stats.durationMs} ms`);
console.log(`Health score (internal diagnostic): ${analysis.healthScore.score}/100 (${analysis.healthScore.grade})`);
console.log('Issues:', counts);
const grouped = new Map<string, { sev: string; n: number; example: string }>();
for (const i of analysis.issues) {
  const g = grouped.get(i.ruleId) ?? { sev: i.severity, n: 0, example: `${i.title} — ${i.url ?? ''}` };
  g.n++;
  if (SEVERITY_RANK[i.severity as keyof typeof SEVERITY_RANK] > SEVERITY_RANK[g.sev as keyof typeof SEVERITY_RANK]) g.sev = i.severity;
  grouped.set(i.ruleId, g);
}
for (const [rule, g] of [...grouped.entries()].sort((a, b) => SEVERITY_RANK[b[1].sev as 'high'] - SEVERITY_RANK[a[1].sev as 'high'])) {
  console.log(`  [${g.sev.toUpperCase().padEnd(8)}] ${rule.padEnd(30)} ×${String(g.n).padEnd(3)} e.g. ${g.example}`);
}
const file = arg('out');
if (file) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, JSON.stringify({ crawl: out, issues: analysis.issues, health: analysis.healthScore }, null, 2));
  console.log(`\nFull results written to ${file}`);
}
