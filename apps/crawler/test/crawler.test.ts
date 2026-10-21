import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiCrawlerAccess, buildBaseline, crawlSite, detectSiteProfile, extractHtml, isAllowed, parseRobots } from '../src/index.js';
import { analyzeSite } from '@phoenixx/seo-engine';
import { startFixtureSite } from '../../../tests/fixtures/site.js';
import type { CrawlOutput } from '@phoenixx/shared';

let site: Awaited<ReturnType<typeof startFixtureSite>>;
let out: CrawlOutput;

beforeAll(async () => {
  site = await startFixtureSite();
  out = await crawlSite({ baseUrl: site.origin + '/', maxPages: 50, concurrency: 3, delayMs: 0, timeoutMs: 5000 });
});
afterAll(() => site.close());

const page = (p: string) => out.pages.find((x) => new URL(x.url).pathname === p)!;

describe('robots.txt parser', () => {
  const r = parseRobots('User-agent: *\nDisallow: /private/\nAllow: /private/public\n\nUser-agent: Googlebot\nDisallow: /nogoogle$\nSitemap: https://x.com/s.xml');
  it('applies longest-match allow/disallow', () => {
    expect(isAllowed(r, 'bingbot', '/private/a')).toBe(false);
    expect(isAllowed(r, 'bingbot', '/private/public/x')).toBe(true);
  });
  it('uses the specific user-agent group', () => {
    expect(isAllowed(r, 'Googlebot', '/private/a')).toBe(true);
    expect(isAllowed(r, 'Googlebot', '/nogoogle')).toBe(false);
    expect(isAllowed(r, 'Googlebot', '/nogoogle/x')).toBe(true);
  });
  it('collects sitemaps', () => expect(r.sitemaps).toEqual(['https://x.com/s.xml']));
});

describe('HTML extraction', () => {
  it('extracts SEO fields, flags invalid JSON-LD and mojibake', () => {
    const html = `<html lang="en"><head><title> Hello </title><meta name="description" content="Desc"><meta name="description" content="Dup"><link rel="canonical" href="/a/"><script type="application/ld+json">{"@type":"Organization"} x</script><meta property="og:image" content="img.png"></head><body><h1>A</h1><h2>B</h2><h4>skip</h4><p>Text â€” here 60% faster</p><img src="/x.png"><a href="/b" rel="nofollow">b</a><a href="https://other.com">o</a><a href="tel:+91 93427 21163">call</a></body></html>`;
    const x = extractHtml(html, 'https://site.com/a', 'https://site.com/');
    expect(x.title).toBe('Hello');
    expect(x.canonical).toBe('https://site.com/a');
    expect(x.structuredData[0]!.valid).toBe(false);
    expect(x.signals.mojibakeCount).toBeGreaterThan(0);
    expect(x.signals.duplicateMetaTags).toContain('description');
    expect(x.signals.relativeOgImage).toBe(true);
    expect(x.signals.headingOrderSkips).toBe(1);
    expect(x.signals.phones).toContain('9342721163');
    expect(x.signals.claims.join(' ')).toContain('60%');
    expect(x.internalLinks[0]).toMatchObject({ href: 'https://site.com/b', nofollow: true });
    expect(x.externalLinks).toHaveLength(1);
    expect(x.images[0]!.hasAlt).toBe(false);
  });
});

describe('crawler', () => {
  it('reads robots.txt and sitemap', () => {
    expect(out.site.robots.found).toBe(true);
    expect(out.site.sitemapUrls.length).toBe(6);
    expect(out.site.homepageReachable).toBe(true);
  });
  it('records redirect chains', () => {
    const p = page('/old-page');
    expect(p.redirectChain).toHaveLength(2);
    expect(new URL(p.finalUrl).pathname).toBe('/web-design');
  });
  it('respects robots.txt disallow', () => expect(page('/private/secret').blockedByRobots).toBe(true));
  it('detects noindex and canonicalised pages', () => {
    expect(page('/orphan-guide').indexable).toBe(false);
    expect(page('/seo-services').indexable).toBe(false);
    expect(page('/').indexable).toBe(true);
  });
  it('discovers broken pages via links', () => expect(page('/missing-page').statusCode).toBe(404));
  it('detects soft-404 handling correctly (server returns 404)', () => expect(out.site.notFoundHandling?.soft404).toBe(false));
});

describe('SEO analysis on crawled fixture', () => {
  it('detects the expected issues with severities', () => {
    const res = analyzeSite({ pages: out.pages, site: out.site });
    const by = (rule: string) => res.issues.filter((i) => i.ruleId === rule);
    expect(by('missing_h1').map((i) => new URL(i.url!).pathname)).toContain('/web-design');
    expect(by('invalid_structured_data')[0]?.severity).toBe('high');
    expect(by('encoding_errors')).toHaveLength(1);
    expect(by('redirect_chain')).toHaveLength(1);
    expect(by('broken_internal_link').length).toBeGreaterThan(0);
    expect(by('sitemap_bad_url').some((i) => i.url?.endsWith('/gone'))).toBe(true);
    expect(by('robots_blocks_sitemap_url')).toHaveLength(1);
    expect(by('canonical_issue')).toHaveLength(1);
    expect(by('multiple_h1')).toHaveLength(1);
    expect(by('images_missing_alt')).toHaveLength(1);
    expect(by('nofollow_page')).toHaveLength(1);
    expect(by('internal_link_to_redirect').length).toBeGreaterThan(0);
    expect(by('unverified_claims').length).toBeGreaterThan(0);
    expect(res.healthScore.score).toBeGreaterThan(0);
    expect(res.healthScore.score).toBeLessThan(100);
    expect(res.healthScore.disclaimer).toMatch(/not a Google metric/);
  });
  it('fingerprints are stable across runs', () => {
    const a = analyzeSite({ pages: out.pages, site: out.site }).issues.map((i) => i.fingerprint).sort();
    const b = analyzeSite({ pages: out.pages, site: out.site }).issues.map((i) => i.fingerprint).sort();
    expect(a).toEqual(b);
  });
  it('honours rule overrides (disable + severity change)', () => {
    const res = analyzeSite({ pages: out.pages, site: out.site, overrides: { missing_h1: { enabled: false }, multiple_h1: { severity: 'high' } } });
    expect(res.issues.some((i) => i.ruleId === 'missing_h1')).toBe(false);
    expect(res.issues.find((i) => i.ruleId === 'multiple_h1')?.severity).toBe('high');
  });
});

describe('site profile & AI crawler access', () => {
  it('reads AI crawler access from robots.txt, separating search from training bots', () => {
    const r = parseRobots('User-agent: GPTBot\nDisallow: /\n\nUser-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /');
    const acc = Object.fromEntries(aiCrawlerAccess(r).map((c) => [c.token, c]));
    expect(acc.GPTBot).toMatchObject({ allowed: false, purpose: 'training', matchedGroup: 'GPTBot' });
    expect(acc.PerplexityBot).toMatchObject({ allowed: false, purpose: 'search' });
    expect(acc['OAI-SearchBot']).toMatchObject({ allowed: true, matchedGroup: '*' });
    expect(aiCrawlerAccess(null).every((c) => c.allowed)).toBe(true);
  });

  it('detects stack from structure, not from words in the copy', () => {
    const html = '<html><head><script async src="https://www.googletagmanager.com/gtag/js?id=G-7Z9VDR6JRF"></script><link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script></head><body><p>We build with React, Next.js and WordPress.</p></body></html>';
    const p = detectSiteProfile(html, { server: 'Apache' }, 300);
    expect(p.server).toBe('Apache');
    expect(p.technologies.map((t) => t.name).sort()).toEqual(['Apache', 'GSAP', 'Google Analytics 4', 'Google Fonts']);
    expect(p.analytics.ga4).toEqual(['G-7Z9VDR6JRF']);
    expect(p.rendering).toBe('static-html');
    expect(detectSiteProfile('<html><body><div id="root"></div><script src="/static/js/react-dom.production.min.js"></script></body></html>', {}, 0).rendering).toBe('client-side');
    expect(detectSiteProfile('<html><head><link rel="stylesheet" href="/wp-content/themes/x/style.css"></head></html>', {}, 500).technologies[0]!.name).toBe('WordPress');
  });

  it('stores the profile on the crawl and flags blocked AI search crawlers', async () => {
    expect(out.site.profile?.aiCrawlers.find((c) => c.token === 'ClaudeBot')?.allowed).toBe(true);
    expect(out.site.profile?.llmsTxt.found).toBe(false);
    const blocked = await startFixtureSite({ '/robots.txt': { status: 200, body: 'User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } } });
    try {
      const o = await crawlSite({ baseUrl: blocked.origin + '/', maxPages: 3, concurrency: 1, delayMs: 0, timeoutMs: 5000 });
      const issues = analyzeSite({ pages: o.pages, site: o.site }).issues.filter((i) => i.ruleId === 'ai_search_crawlers_blocked');
      expect(issues).toHaveLength(1);
      expect(issues[0]!.evidence.blocked).toEqual(['OAI-SearchBot']); // ClaudeBot is a training bot → not flagged
    } finally {
      await blocked.close();
    }
  });
});

describe('baseline builder', () => {
  it('produces an inventory, link edges, issues and a migration baseline without a database', () => {
    const files = buildBaseline(out, analyzeSite({ pages: out.pages, site: out.site }), new Date('2026-09-28T10:00:00Z'));
    const inv = files['inventory.csv'].trim().split('\n');
    expect(inv[0]).toMatch(/^url,path,status,final_url,/);
    expect(inv.length - 1).toBe(out.pages.length);
    expect(inv.find((l) => l.includes('/seo-services,'))).toMatch(/,2,/); // two H1s
    const b = JSON.parse(files['baseline.json']);
    expect(b).toMatchObject({ kind: 'migration-baseline', capturedAt: '2026-09-28T10:00:00.000Z', dataLabel: 'verified' });
    expect(b.unavailable.organicTraffic).toMatch(/Search Console/);
    expect(b.pages.find((p: any) => p.path === '/gone').status).toBe(404);
    expect(b.pages.find((p: any) => p.path === '/old-page').redirect_hops).toBe(2);
    expect(files['internal-links.csv']).toMatch(/^source,target,anchor,nofollow\n/);
    expect(files['SUMMARY.md']).toMatch(/## Issues by rule/);
    expect(JSON.parse(files['site-profile.json']).rendering).toBe('static-html');
  });
});
