import { describe, expect, it } from 'vitest';
import type { CrawledPage, SiteChecks } from '@phoenixx/shared';
import { analyzeSite, buildAuditScorecard, AUDIT_CATEGORIES, auditCategoryForRule } from '../src/index.js';

const site = (profile?: Partial<NonNullable<SiteChecks['profile']>>): SiteChecks => ({
  baseUrl: 'https://example.com/',
  robots: { url: 'https://example.com/robots.txt', status: 200, found: true, sitemaps: ['https://example.com/sitemap.xml'], disallowAll: false, rules: [] },
  sitemaps: [{ url: 'https://example.com/sitemap.xml', status: 200, urlCount: 2 }],
  sitemapUrls: ['https://example.com/', 'https://example.com/a'],
  https: { httpRedirectsToHttps: true, httpStatus: 301, finalUrl: 'https://example.com/' },
  hostCanonicalization: [],
  notFoundHandling: { url: 'x', status: 404, soft404: false },
  homepageReachable: true,
  profile: profile
    ? ({ server: 'Apache', poweredBy: null, technologies: [], analytics: { ga4: [], gtm: [] }, rendering: 'static-html', renderingNote: '', aiCrawlers: [], llmsTxt: { url: '', status: 404, found: false }, securityHeaders: { hsts: null, contentTypeOptions: 'nosniff', frameOptions: null, csp: null, referrerPolicy: null, permissionsPolicy: null }, embeddable: true, ...profile } as NonNullable<SiteChecks['profile']>)
    : undefined,
});

const page = (url: string, o: Partial<CrawledPage> = {}): CrawledPage => ({
  url, finalUrl: url, statusCode: 200, redirectChain: [], redirectLoop: false, responseTimeMs: 120, contentType: 'text/html', contentLength: 20000,
  canonical: url, robotsMeta: null, xRobotsTag: null, indexable: true, indexabilityReason: null,
  title: 'A good descriptive page title for testing', metaDescription: 'A meta description that is long enough to be useful to searchers and describes the page accurately here.',
  h1s: ['Heading'], h2s: ['Sub'], h3s: [], wordCount: 600, images: [], internalLinks: [{ href: 'https://example.com/', anchor: 'Home', rel: null, nofollow: false }, { href: 'https://example.com/a', anchor: 'A', rel: null, nofollow: false }],
  externalLinks: [], structuredData: [], openGraph: { 'og:image': 'x', 'og:title': 't' }, hreflang: [], lang: 'en', contentHash: url, textSample: '',
  signals: { mojibakeCount: 0, mojibakeSamples: [], phones: [], emails: [], claims: [], duplicateMetaTags: [], hasViewport: true, lang: 'en', mixedContent: [], stockImages: [] } as never,
  depth: 0, inSitemap: true, discoveredFrom: null, blockedByRobots: false, error: null, ...o,
});

describe('audit scorecard', () => {
  it('maps every rule to one of the 10 categories', () => {
    expect(AUDIT_CATEGORIES).toHaveLength(10);
    expect(auditCategoryForRule('missing_title', 'content')).toBe('onpage');
    expect(auditCategoryForRule('https_not_enforced', 'technical')).toBe('security');
    expect(auditCategoryForRule('orphan_page', 'internal_linking')).toBe('links');
  });

  it('scores from pass/fail checks: a page-level failure lowers only its category, proportionally', () => {
    const pages = [page('https://example.com/'), page('https://example.com/a', { h1s: [] })];
    const s = site({});
    const a = analyzeSite({ pages, site: s });
    const card = buildAuditScorecard({ pages, site: s, issues: a.issues });
    const h1 = card.checks.find((c) => c.id === 'missing_h1')!;
    expect(h1).toMatchObject({ category: 'onpage', evaluated: 2, passed: 1 });
    const fixed = [page('https://example.com/'), page('https://example.com/a')];
    const card2 = buildAuditScorecard({ pages: fixed, site: s, issues: analyzeSite({ pages: fixed, site: s }).issues });
    const on = (c: typeof card) => c.categories.find((x) => x.id === 'onpage')!.score!;
    expect(on(card2)).toBeGreaterThan(on(card));
    expect(card2.overall).toBeGreaterThanOrEqual(card.overall);
    expect(card.checksPassed).toBeLessThan(card.checksTotal);
  });

  it('includes security headers and AI readiness when the crawl has a site profile, otherwise marks them partial', () => {
    const pages = [page('https://example.com/')];
    const withProfile = buildAuditScorecard({ pages, site: site({}), issues: [] });
    expect(withProfile.checks.find((c) => c.id === 'sec_hsts')).toMatchObject({ passed: 0, evaluated: 1 });
    expect(withProfile.checks.find((c) => c.id === 'sec_nosniff')).toMatchObject({ passed: 1 });
    expect(withProfile.checks.find((c) => c.id === 'ai_content_in_html')!.passed).toBe(1);
    const noProfile = buildAuditScorecard({ pages, site: site(), issues: [] });
    expect(noProfile.categories.find((c) => c.id === 'security')!.coverage).toBe('partial');
    expect(noProfile.categories.find((c) => c.id === 'performance')!.note).toMatch(/PageSpeed/);
  });

  it('never invents a score for a category without checks', () => {
    const card = buildAuditScorecard({ pages: [], site: site(), issues: [] });
    for (const c of card.categories.filter((x) => x.checks === 0)) expect(c).toMatchObject({ score: null, status: 'not_measured' });
  });
});
