#!/usr/bin/env node
/**
 * SEO inventory + migration baseline for a site, no database needed.
 *   npm run baseline -- https://www.phoenixxit.com/ --out exports/baseline/phoenixxit --max 500
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '@phoenixx/shared';
import { analyzeSite } from '@phoenixx/seo-engine';
import { crawlSite } from './crawler.js';
import { buildBaseline } from './baseline.js';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const cfg = loadConfig();
const url = process.argv.slice(2).find((a) => /^https?:\/\//.test(a)) ?? cfg.SEO_SITE_URL;
const host = new URL(url).hostname.replace(/^www\./, '');
const dir = path.resolve(arg('out') ?? `exports/baseline/${host}-${new Date().toISOString().slice(0, 10)}`);

const out = await crawlSite({ baseUrl: url, maxPages: Number(arg('max') ?? cfg.CRAWL_MAX_PAGES), concurrency: cfg.CRAWL_CONCURRENCY, delayMs: cfg.CRAWL_DELAY_MS, timeoutMs: cfg.CRAWL_TIMEOUT_MS, userAgent: cfg.CRAWL_USER_AGENT });
const analysis = analyzeSite({ pages: out.pages, site: out.site, externalLinkStatus: out.externalLinkStatus });
const files = buildBaseline(out, analysis);
mkdirSync(dir, { recursive: true });
for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
writeFileSync(path.join(dir, 'crawl.json'), JSON.stringify(out, null, 2));
console.log(`\nBaseline for ${out.baseUrl}: ${out.stats.pagesCrawled} URLs, health ${analysis.healthScore.score}/100, ${analysis.issues.length} issues`);
console.log(`Written to ${dir}:\n  ${[...Object.keys(files), 'crawl.json'].join('\n  ')}`);
