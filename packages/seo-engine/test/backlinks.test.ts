import { describe, expect, it } from 'vitest';
import { matchBacklink, parseBacklinkCsv, parseCsv, redirectForBrokenTarget, summarizeBacklinks, type SnapshotPage } from '../src/index.js';

const SITE = 'https://www.phoenixxit.com/';

describe('CSV parsing', () => {
  it('handles quotes, escaped quotes, CRLF, BOM and TSV', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('reads the Search Console "Latest links" export (linking page only)', () => {
    const r = parseBacklinkCsv('Linking page,Last crawled\nhttps://blog.example.org/tools/,2026-09-01\nhttps://www.phoenixxit.com/about,2026-09-02\nnot a url,2026-09-03\n', SITE);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ sourceUrl: 'https://blog.example.org/tools', sourceDomain: 'blog.example.org', targetUrl: '', lastSeen: '2026-09-01T00:00:00.000Z' });
    expect(r.skipped.map((s) => s.reason)).toEqual(['Linking page is on our own site (internal link)', 'Invalid linking page URL']);
  });

  it('reads tool exports with target, anchor and follow columns', () => {
    const csv = 'Referring page URL,Target URL,Anchor,Nofollow\n"https://news.example.com/a?b=2&a=1",https://phoenixxit.com/web-design/,"Web design, Coimbatore",true\nhttps://dir.example.net/x,/seo-services,SEO,false\nhttps://x.example/y,https://other-site.com/,x,false\n';
    const r = parseBacklinkCsv(csv, SITE);
    expect(r.columns).toMatchObject({ source: 'Referring page URL', target: 'Target URL', anchor: 'Anchor', nofollow: 'Nofollow' });
    expect(r.rows).toEqual([
      expect.objectContaining({ sourceUrl: 'https://news.example.com/a?a=1&b=2', targetUrl: 'https://phoenixxit.com/web-design', anchor: 'Web design, Coimbatore', nofollow: true }),
      expect.objectContaining({ sourceUrl: 'https://dir.example.net/x', targetUrl: 'https://www.phoenixxit.com/seo-services', nofollow: false }),
    ]);
    expect(r.skipped[0]!.reason).toBe('Target is not on this site');
  });

  it('accepts a bare list of URLs and de-duplicates', () => {
    const r = parseBacklinkCsv('https://a.example/1\nhttps://a.example/1\nhttps://b.example/2\n', SITE);
    expect(r.rows.map((x) => x.sourceUrl)).toEqual(['https://a.example/1', 'https://b.example/2']);
  });

  it('explains an unrecognised file instead of importing garbage', () => {
    const r = parseBacklinkCsv('Keyword,Clicks\nweb design,10\n', SITE);
    expect(r.rows).toHaveLength(0);
    expect(r.skipped[0]!.reason).toMatch(/No linking-page column/);
  });

  it('understands "dofollow" columns (true = followed)', () => {
    const r = parseBacklinkCsv('url_from,url_to,dofollow\nhttps://a.example/1,https://www.phoenixxit.com/,true\nhttps://a.example/2,https://www.phoenixxit.com/,false\n', SITE);
    expect(r.rows.map((x) => x.nofollow)).toEqual([false, true]);
  });
});

describe('matching a link on the linking page', () => {
  const links = [
    { href: 'https://phoenixxit.com/seo-services', anchor: 'SEO', rel: 'nofollow', nofollow: true },
    { href: 'http://www.phoenixxit.com/seo-services/', anchor: 'SEO agency', rel: null, nofollow: false },
    { href: 'https://elsewhere.example/', anchor: 'x', rel: null, nofollow: false },
  ];
  it('treats www/non-www, http/https and trailing slashes as the same target and prefers followed links', () => {
    expect(matchBacklink(links, SITE, 'https://www.phoenixxit.com/seo-services')?.anchor).toBe('SEO agency');
  });
  it('matches through redirect aliases, and any link to the site when no target is known', () => {
    expect(matchBacklink(links, SITE, 'https://www.phoenixxit.com/old-seo', ['https://www.phoenixxit.com/seo-services'])).not.toBeNull();
    expect(matchBacklink(links, SITE, '')?.nofollow).toBe(false);
    expect(matchBacklink(links, SITE, 'https://www.phoenixxit.com/contact')).toBeNull();
  });
});

describe('broken link targets', () => {
  const page = (path: string, title: string): SnapshotPage => ({ path, url: 'https://www.phoenixxit.com' + path, statusCode: 200, title, metaDescription: null, h1: title, canonical: null, indexable: true, inlinks: 0, clicks: 0, impressions: 0 });
  it('suggests the most similar live page, or the home page with low confidence', () => {
    const live = [page('/', 'Phoenixx IT'), page('/website-design-coimbatore', 'Website Design Company in Coimbatore'), page('/seo-services', 'SEO Services')];
    expect(redirectForBrokenTarget('https://www.phoenixxit.com/website-design', live).to).toBe('/website-design-coimbatore');
    const fallback = redirectForBrokenTarget('https://www.phoenixxit.com/zzz-qqq', live);
    expect(fallback).toMatchObject({ to: '/', confidence: 0.1 });
  });
  it('uses link anchors when the old URL says little, and ignores words every page shares', () => {
    const live = [page('/', 'Phoenixx IT Coimbatore'), page('/website-design-development', 'Website Design & Development | Phoenixx IT'), page('/app-development', 'App Development in Coimbatore | Phoenixx IT'), page('/digital-marketing', 'Digital Marketing in Coimbatore | Phoenixx IT')];
    expect(redirectForBrokenTarget('https://www.phoenixxit.com/services/web-design.html', live)).toMatchObject({ to: '/website-design-development' });
    expect(redirectForBrokenTarget('https://www.phoenixxit.com/p?id=7', live, ['Phoenixx IT mobile app development'])).toMatchObject({ to: '/app-development' });
    expect(redirectForBrokenTarget('https://www.phoenixxit.com/p?id=7', live, ['Phoenixx IT'])).toMatchObject({ to: '/', confidence: 0.1 });
  });
  it('summarises links and referring domains', () => {
    const s = summarizeBacklinks([
      { source_domain: 'a.example', status: 'live', nofollow: null, found_nofollow: true },
      { source_domain: 'a.example', status: 'lost', nofollow: null, found_nofollow: null },
      { source_domain: 'b.example', status: 'unverified', nofollow: false, found_nofollow: null },
    ]);
    expect(s).toEqual({ backlinks: 3, referringDomains: 2, liveReferringDomains: 1, live: 1, lost: 1, unverified: 1, nofollow: 1 });
  });
});
