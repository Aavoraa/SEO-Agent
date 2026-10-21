import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_PROFILE as P } from '@phoenixx/shared';
import { buildLocalMatrix, checkContentQuality, compareSnapshots, organizationSchema, localBusinessSchema, faqSchema, queryOpportunity, recommendSchemaForPage, redirectRules, scorePriority, validateJsonLd, type SnapshotPage } from '../src/index.js';

describe('priority scoring', () => {
  it('ranks high-demand striking-distance commercial items above low-evidence ones', () => {
    const hi = scorePriority({ impact: 4, effort: 1, impressions: 12400, position: 8.7, ctr: 0.01, siteAvgCtr: 0.03, businessRelevance: 5, severity: 'medium', confidence: 0.8 });
    const lo = scorePriority({ impact: 1, effort: 4, impressions: 0, businessRelevance: 1, confidence: 0.4 });
    expect(hi.score).toBeGreaterThan(lo.score);
    expect(hi.priority).toBe('high');
    expect(hi.reasons.join(' ')).toMatch(/12,400 impressions/);
    expect(hi.reasons.join(' ')).toMatch(/below site average/);
    expect(hi.factors).toHaveLength(6);
  });
  it('critical severity is always critical priority', () => expect(scorePriority({ severity: 'critical' }).priority).toBe('critical'));
  it('query opportunity rewards positions 4–20 with low CTR', () => {
    const a = queryOpportunity({ impressions: 5000, clicks: 20, position: 8, ctr: 0.004 }, 0.03, 5);
    const b = queryOpportunity({ impressions: 5000, clicks: 20, position: 45, ctr: 0.004 }, 0.03, 5);
    expect(a.score).toBeGreaterThan(b.score);
  });
});

describe('schema generation & validation', () => {
  it('generates valid Organization and LocalBusiness JSON-LD from the business profile', () => {
    expect(validateJsonLd(organizationSchema(P)).valid).toBe(true);
    const lb = localBusinessSchema(P)!;
    expect(validateJsonLd(lb).valid).toBe(true);
    expect(JSON.stringify(lb)).toContain('Vadavalli');
  });
  it('rejects the broken JSON-LD pattern found on phoenixxit.com', () => {
    const broken = '{"@context":"https://schema.org","@type":"Organization","name":"Phoenixx IT"}\n"contactPoint": {"@type":"ContactPoint"}';
    const v = validateJsonLd(broken);
    expect(v.valid).toBe(false);
    expect(v.errors[0]).toMatch(/Invalid JSON/);
  });
  it('reports missing required properties', () => {
    const v = validateJsonLd({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: [{ '@type': 'Question', name: 'Q' }] });
    expect(v.valid).toBe(false);
    expect(v.errors.join()).toMatch(/acceptedAnswer/);
  });
  it('only emits FAQPage when real FAQs exist', () => {
    expect(faqSchema([])).toBeNull();
    const recs = recommendSchemaForPage(P, { url: 'https://www.phoenixxit.com/automation', title: 'x', description: 'd', pageType: 'service', serviceName: 'Business Automation' });
    expect(recs.map((r) => r.type)).toEqual(['Service', 'BreadcrumbList']);
  });
});

describe('content quality checker', () => {
  const good = `## Planning a business website in Coimbatore\n\nA website project starts with what your customers need to find. We map pages, content and enquiries before design.\n\n## What affects the timeline\n\nScope, content readiness and integrations drive the schedule. Clear feedback rounds keep it predictable.\n\n### Content\n\nWriting page copy early avoids delays later.\n\n## Choosing a partner\n\nAsk how they handle hosting, updates and search basics. See our [website design and development](/website-design-development) service and [digital marketing](/digital-marketing).\n\nTalk to Phoenixx IT to plan your website design project.`;
  it('passes specific, linked, CTA-bearing content', () => {
    const r = checkContentQuality({ title: 'Planning a business website design in Coimbatore', bodyMarkdown: good, targetKeyword: 'website design' }, { minWords: 80 });
    expect(r.checks.find((c) => c.id === 'cta')!.status).toBe('pass');
    expect(r.checks.find((c) => c.id === 'internal_links')!.status).toBe('pass');
    expect(r.flaggedClaims).toHaveLength(0);
  });
  it('flags stuffing, fake claims and generic AI phrasing', () => {
    const bad = `In today's fast-paced digital landscape, SEO services SEO services SEO services. We are the #1 company with 500+ clients and 99% success. We guarantee first page ranking results. Unlock the power of SEO services. SEO services SEO services SEO services.`;
    const r = checkContentQuality({ title: 'SEO Services', bodyMarkdown: bad, targetKeyword: 'seo services' });
    expect(r.checks.find((c) => c.id === 'keyword_stuffing')!.status).toBe('fail');
    expect(r.flaggedClaims.length).toBeGreaterThanOrEqual(3);
    expect(r.genericPhrases.length).toBeGreaterThanOrEqual(2);
    expect(r.verdict).not.toBe('ready_for_review');
  });
});

describe('migration monitor', () => {
  const pg = (path: string, o: Partial<SnapshotPage> = {}): SnapshotPage => ({ path, url: 'https://x.com' + path, statusCode: 200, title: path + ' title', metaDescription: 'd', h1: path + ' h1', canonical: 'https://x.com' + path, indexable: true, inlinks: 5, clicks: 0, impressions: 0, ...o });
  const baseline = [pg('/'), pg('/website-design-development', { title: 'Website Design Company in Coimbatore', clicks: 40, impressions: 2000 }), pg('/automation', { clicks: 5 }), pg('/faq')];
  const current = [pg('/'), pg('/services/website-design', { title: 'Website Design Services | Phoenixx IT', h1: 'Website Design' }), pg('/automation', { indexable: false, h1: null }), pg('/faq', { title: 'Changed' })];
  const res = compareSnapshots(baseline, current);
  it('flags deleted URLs with traffic as critical and suggests a redirect', () => {
    const f = res.findings.find((f) => f.path === '/website-design-development')!;
    expect(f.type).toBe('missing_page');
    expect(f.severity).toBe('critical');
    expect(f.suggestedRedirect?.to).toBe('/services/website-design');
    expect(res.summary.atRiskClicks).toBe(40);
  });
  it('detects indexability loss and H1 removal', () => {
    expect(res.findings.some((f) => f.path === '/automation' && f.type === 'indexability_lost' && f.severity === 'critical')).toBe(true);
    expect(res.findings.some((f) => f.path === '/automation' && f.type === 'h1_changed' && f.severity === 'high')).toBe(true);
  });
  it('generates redirect rules', () => expect(redirectRules(res.redirectMap)).toContain('Redirect 301 /website-design-development /services/website-design'));
});

describe('local SEO matrix', () => {
  it('recommends strengthening existing pages instead of thin location pages', () => {
    const cells = buildLocalMatrix(
      [
        { query: 'website design coimbatore', impressions: 800, clicks: 10, position: 9, services: ['website-design-development'], locations: ['coimbatore'] },
        { query: 'seo company coimbatore', impressions: 500, clicks: 3, position: 14, services: ['seo'], locations: ['coimbatore'] },
        { query: 'web design chennai', impressions: 900, clicks: 0, position: 40, services: ['website-design-development'], locations: ['chennai'] },
      ],
      [{ url: 'https://www.phoenixxit.com/website-design-development', title: 'Website Design', h1: null, services: ['website-design-development'], locations: [] }],
      P,
    );
    expect(cells.find((c) => c.serviceId === 'website-design-development' && c.locationId === 'coimbatore')!.action).toBe('add_location_section');
    expect(cells.find((c) => c.serviceId === 'seo' && c.locationId === 'coimbatore')!.action).toBe('create_location_page');
    expect(cells.find((c) => c.locationId === 'chennai')!.action).toBe('monitor');
  });
});
