import { describe, expect, it } from 'vitest';
import { DEFAULT_BUSINESS_PROFILE as P } from '@phoenixx/shared';
import { classifyIntent, classifyKeywordType, clusterKeywords, comparePeriods, detectDrop, expandKeywords, normalizeKeyword, searchIntentProfile, type ClusterInputKeyword, type GscRow } from '../src/index.js';

describe('intent classification', () => {
  it.each([
    ['software development company in coimbatore', 'local'],
    ['it companies in coimbatore', 'local'],
    ['phoenixx it', 'navigational'],
    ['how to build a mobile app', 'informational'],
    ['website design cost', 'transactional'],
    ['best digital marketing agency', 'commercial'],
    ['seo agency near me', 'local'],
    ['what is workflow automation', 'informational'],
  ])('%s → %s', (q, expected) => expect(classifyIntent(q, P).intent).toBe(expected));

  it('detects services and locations', () => {
    const r = classifyIntent('Web Design Company Kovai', P);
    expect(r.services).toContain('website-design-development');
    expect(r.locations).toContain('coimbatore');
  });

  it('assigns keyword types', () => {
    expect(classifyKeywordType('how much does an app cost', classifyIntent('how much does an app cost', P))).toBe('question');
    expect(classifyKeywordType('seo company coimbatore', classifyIntent('seo company coimbatore', P))).toBe('local');
  });

  it('builds a search-intent profile with page type and CTA', () => {
    const q = 'software development company in coimbatore';
    const prof = searchIntentProfile(q, classifyIntent(q, P), P);
    expect(prof.intent).toBe('local');
    expect(prof.recommendedCta).toBe('Talk to Phoenixx IT');
    expect(['service_page', 'location_section']).toContain(prof.recommendedPageType);
  });

  it('normalises queries', () => expect(normalizeKeyword('  "Best  IT Company!!" ')).toBe('best it company'));
});

describe('clustering', () => {
  const kw = (keyword: string, impressions: number, pages: string[] = []): ClusterInputKeyword => {
    const r = classifyIntent(keyword, P);
    return { keyword, intent: r.intent, services: r.services, locations: r.locations, impressions, clicks: Math.round(impressions * 0.02), position: 9, pages: pages.map((url) => ({ url, impressions })), isQuestion: r.isQuestion };
  };
  const clusters = clusterKeywords(
    [
      kw('it company in coimbatore', 900, ['https://www.phoenixxit.com/']),
      kw('it companies in coimbatore', 700, ['https://www.phoenixxit.com/']),
      kw('best it company coimbatore', 300, ['https://www.phoenixxit.com/']),
      kw('technology company coimbatore', 120, ['https://www.phoenixxit.com/']),
      kw('how much does a website cost in india', 200),
      kw('website design coimbatore', 400, ['https://www.phoenixxit.com/website-design-development', 'https://www.phoenixxit.com/']),
      kw('web design company in coimbatore', 250, ['https://www.phoenixxit.com/']),
    ],
    P,
  );
  it('groups the "IT company Coimbatore" variants into one cluster', () => {
    const c = clusters.find((c) => c.keywords.includes('it company in coimbatore'))!;
    expect(c.keywords).toEqual(expect.arrayContaining(['it companies in coimbatore', 'best it company coimbatore', 'technology company coimbatore']));
    expect(c.intent).toBe('local');
  });
  it('keeps questions separate as FAQ/blog content', () => {
    const q = clusters.find((c) => c.keywords.includes('how much does a website cost in india'))!;
    expect(['faq', 'blog']).toContain(q.strategy);
  });
  it('maps service clusters to the existing service page and flags cannibalisation', () => {
    const c = clusters.find((c) => c.keywords.includes('website design coimbatore'))!;
    expect(c.strategy).toBe('existing_page');
    expect(c.targetPageUrl).toBe('https://www.phoenixxit.com/website-design-development');
    expect(c.cannibalization.length).toBe(2);
  });
});

describe('period comparison & anomaly detection', () => {
  const rows: GscRow[] = [];
  for (let d = 1; d <= 56; d++) {
    const date = `2026-08-${String(d).padStart(2, '0')}`.replace(/2026-08-(3[2-9]|[4-5]\d)/, (m) => m);
    const day = new Date(Date.UTC(2026, 7, d)).toISOString().slice(0, 10);
    void date;
    rows.push({ date: day, query: 'seo company coimbatore', page: '/seo', clicks: d > 28 ? 10 : 5, impressions: d > 28 ? 200 : 100, position: d > 28 ? 6 : 9 });
    rows.push({ date: day, query: 'old query', page: '/old', clicks: d > 28 ? 1 : 10, impressions: d > 28 ? 20 : 200, position: 12 });
  }
  const end = new Date(Date.UTC(2026, 7, 56)).toISOString().slice(0, 10);
  const cmp = comparePeriods(rows, 'query', 28, end);
  it('detects rising and declining queries', () => {
    expect(cmp.find((c) => c.key === 'seo company coimbatore')!.trend).toBe('rising');
    expect(cmp.find((c) => c.key === 'old query')!.trend).toBe('declining');
  });
  it('computes weighted position and deltas', () => {
    const c = cmp.find((c) => c.key === 'seo company coimbatore')!;
    expect(c.current.position).toBe(6);
    expect(c.positionChange).toBe(-3);
    expect(c.clicksChangePct).toBe(100);
  });
  it('flags a traffic drop', () => {
    const series = Array.from({ length: 28 }, (_, i) => ({ date: String(i), clicks: i >= 21 ? 2 : 20, impressions: i >= 21 ? 50 : 400 }));
    expect(detectDrop(series).every((d) => d.isDrop)).toBe(true);
  });
});

describe('keyword expansion', () => {
  it('creates service × location hypotheses without volumes', () => {
    const e = expandKeywords(P);
    expect(e.some((k) => k.keyword === 'seo company in coimbatore')).toBe(true);
    expect(e.every((k) => !('volume' in k))).toBe(true);
  });
});
