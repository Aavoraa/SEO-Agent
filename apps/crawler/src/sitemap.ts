import * as cheerio from 'cheerio';
import { normalizeUrl } from '@phoenixx/shared';
import { fetchWithRedirects, type FetchOptions } from './fetcher.js';

export interface SitemapFetch {
  url: string;
  status: number | null;
  urlCount: number;
  error?: string;
}

/** Fetches a sitemap or sitemap index recursively (bounded). Returns every <loc> page URL found. */
export async function collectSitemapUrls(start: string[], opts: FetchOptions, limit = 50000): Promise<{ urls: string[]; fetched: SitemapFetch[] }> {
  const queue = [...new Set(start)];
  const seen = new Set<string>();
  const urls = new Set<string>();
  const fetched: SitemapFetch[] = [];
  while (queue.length && seen.size < 50) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const res = await fetchWithRedirects(sm, { ...opts, maxBytes: 50 * 1024 * 1024 });
    if (res.error || !res.body || (res.status ?? 0) >= 400) {
      fetched.push({ url: sm, status: res.status, urlCount: 0, error: res.error ?? `HTTP ${res.status}` });
      continue;
    }
    let body = res.body;
    if (!/<(urlset|sitemapindex)/i.test(body)) {
      fetched.push({ url: sm, status: res.status, urlCount: 0, error: 'Response is not a sitemap XML document' });
      continue;
    }
    const $ = cheerio.load(body, { xml: true });
    const children = $('sitemapindex > sitemap > loc').map((_, el) => $(el).text().trim()).get();
    children.forEach((c) => queue.push(c));
    const locs = $('urlset > url > loc').map((_, el) => $(el).text().trim()).get();
    for (const l of locs) {
      const n = normalizeUrl(l);
      if (n && urls.size < limit) urls.add(n);
    }
    fetched.push({ url: sm, status: res.status, urlCount: locs.length });
  }
  return { urls: [...urls], fetched };
}
