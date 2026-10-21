import { normalizeUrl, sameSite, sleep, type CrawledPage, type CrawlOutput, type SiteChecks, type SiteProfile, type Logger, createLogger } from '@phoenixx/shared';
import { fetchWithRedirects, type FetchOptions } from './fetcher.js';
import { extractHtml } from './extract.js';
import { parseRobots, isAllowed, disallowsAll, type ParsedRobots } from './robots.js';
import { collectSitemapUrls } from './sitemap.js';
import { aiCrawlerAccess, detectSiteProfile } from './site-profile.js';

export interface CrawlOptions {
  baseUrl: string;
  maxPages?: number;
  concurrency?: number;
  delayMs?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Crawl URLs from the sitemap even if nothing links to them (needed for orphan detection). */
  includeSitemapUrls?: boolean;
  /** HEAD-check external links (bounded). Off by default to stay polite. */
  checkExternalLinks?: boolean;
  maxExternalChecks?: number;
  /** Respect robots.txt for fetching (always true for competitors). */
  respectRobots?: boolean;
  /** Skip site-level checks (robots, https, host variants) – used for competitor crawls. */
  skipSiteChecks?: boolean;
  maxDepth?: number;
  logger?: Logger;
  onPage?: (page: CrawledPage) => void | Promise<void>;
}

const HTML_TYPES = /text\/html|application\/xhtml\+xml/i;
const SKIP_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|rar|gz|mp4|mp3|webm|woff2?|ttf|eot|css|js|json|xml|txt|docx?|xlsx?|pptx?)$/i;

function emptySignals() {
  return { hasViewport: false, hasCharset: false, mojibakeCount: 0, mixedContent: [], duplicateMetaTags: [], relativeOgImage: false, htmlLang: null, headingOrderSkips: 0, hotlinkedImages: 0, phones: [], claims: [] };
}

async function siteChecks(baseUrl: string, fopts: FetchOptions): Promise<{ checks: Omit<SiteChecks, 'sitemaps' | 'sitemapUrls'>; robots: ParsedRobots | null }> {
  const base = new URL(baseUrl);
  const robotsUrl = `${base.origin}/robots.txt`;
  const robotsRes = await fetchWithRedirects(robotsUrl, { ...fopts, maxBytes: 512 * 1024 });
  let robots: ParsedRobots | null = null;
  const robotsFound = !!robotsRes.body && (robotsRes.status ?? 0) < 400 && !/<html/i.test(robotsRes.body.slice(0, 500));
  if (robotsFound) robots = parseRobots(robotsRes.body!);

  // HTTPS enforcement & host canonicalisation (http/https × www/bare).
  const bareHost = base.hostname.replace(/^www\./, '');
  const variants = [`http://${bareHost}/`, `http://www.${bareHost}/`, `https://${bareHost}/`, `https://www.${bareHost}/`];
  const canonicalHome = normalizeUrl(baseUrl)!;
  const results = await Promise.all(variants.map((v) => fetchWithRedirects(v, { ...fopts, readBody: false })));
  const hostCanonicalization = results.map((r, i) => ({
    variant: variants[i]!,
    finalUrl: r.finalUrl ? normalizeUrl(r.finalUrl) : null,
    status: r.status,
    consistent: !r.error && r.status !== null && r.status < 400 && normalizeUrl(r.finalUrl) === normalizeUrl(new URL('/', canonicalHome).toString()),
  }));
  const httpRes = results[base.hostname.startsWith('www.') ? 1 : 0]!;

  // Soft-404 check: a random path should return 404/410.
  const probe = `${base.origin}/__seo-agent-404-probe-${Date.now()}`;
  const probeRes = await fetchWithRedirects(probe, { ...fopts, maxBytes: 200 * 1024 });
  const home = await fetchWithRedirects(base.toString(), { ...fopts, maxBytes: 3_000_000 });
  const llms = await fetchWithRedirects(`${base.origin}/llms.txt`, { ...fopts, maxBytes: 64 * 1024 });
  const homeText = home.body ? extractHtml(home.body, home.finalUrl, baseUrl) : null;
  const profile: SiteProfile = {
    ...detectSiteProfile(home.body ?? '', home.headers, homeText?.wordCount ?? 0),
    aiCrawlers: aiCrawlerAccess(robots),
    llmsTxt: { url: `${base.origin}/llms.txt`, status: llms.status, found: (llms.status ?? 0) === 200 && !!llms.body && !/<html/i.test(llms.body.slice(0, 500)) },
  };

  return {
    robots,
    checks: {
      baseUrl: canonicalHome,
      robots: {
        url: robotsUrl,
        status: robotsRes.status,
        found: robotsFound,
        sitemaps: robots?.sitemaps ?? [],
        disallowAll: robots ? disallowsAll(robots, 'googlebot') : false,
        rules: robots?.groups.map((g) => ({ userAgent: g.userAgents.join(','), allow: g.allow, disallow: g.disallow })) ?? [],
        error: robotsFound ? undefined : robotsRes.error ?? `HTTP ${robotsRes.status}`,
      },
      https: {
        httpRedirectsToHttps: httpRes.error ? null : (httpRes.finalUrl ?? '').startsWith('https:'),
        httpStatus: httpRes.status,
        finalUrl: httpRes.finalUrl,
      },
      hostCanonicalization,
      notFoundHandling: { url: probe, status: probeRes.status, soft404: probeRes.status === 200 },
      homepageReachable: !home.error && (home.status ?? 500) < 400,
      profile,
    },
  };
}

/**
 * Fills a page record from its HTML (SEO fields + indexability). Shared by the crawler and by
 * single-page re-crawls after a deployment, so both judge a page the same way.
 */
export function applyHtmlToPage(base: CrawledPage, html: string, siteUrl: string): CrawledPage {
  const x = extractHtml(html, base.finalUrl, siteUrl);
  Object.assign(base, {
    title: x.title,
    metaDescription: x.metaDescription,
    canonical: x.canonical,
    robotsMeta: x.robotsMeta,
    h1s: x.h1s,
    h2s: x.h2s,
    h3s: x.h3s,
    wordCount: x.wordCount,
    images: x.images,
    internalLinks: x.internalLinks,
    externalLinks: x.externalLinks,
    structuredData: x.structuredData,
    openGraph: x.openGraph,
    hreflang: x.hreflang,
    lang: x.lang,
    contentHash: x.contentHash,
    textSample: x.textSample,
    signals: x.signals,
  });
  const directives = `${x.robotsMeta ?? ''},${base.xRobotsTag ?? ''}`.toLowerCase();
  if (/noindex|none/.test(directives)) {
    base.indexable = false;
    base.indexabilityReason = 'noindex directive';
  } else if (x.canonical && x.canonical !== base.finalUrl) {
    base.indexable = false;
    base.indexabilityReason = `Canonicalised to ${x.canonical}`;
  } else if (base.blockedByRobots) {
    base.indexable = false;
  } else {
    base.indexable = true;
    base.indexabilityReason = null;
  }
  return base;
}

/**
 * Polite breadth-first crawler for server-rendered sites (phoenixxit.com is static HTML).
 * JavaScript rendering is intentionally not used: Google indexes the rendered DOM, but for
 * static/SSR sites the HTML response is what matters and it keeps the crawler dependency-free.
 */
export async function crawlSite(options: CrawlOptions): Promise<CrawlOutput> {
  const log = options.logger ?? createLogger({ component: 'crawler' });
  const startedAt = new Date();
  const baseUrl = normalizeUrl(options.baseUrl);
  if (!baseUrl) throw new Error(`Invalid base URL: ${options.baseUrl}`);
  const maxPages = options.maxPages ?? 500;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 3, 10));
  const delayMs = options.delayMs ?? 250;
  const maxDepth = options.maxDepth ?? 20;
  const fopts: FetchOptions = { userAgent: options.userAgent ?? 'PhoenixxSEOAgent/1.0', timeoutMs: options.timeoutMs ?? 20000, maxBytes: 5 * 1024 * 1024 };

  let checks: SiteChecks;
  let robots: ParsedRobots | null = null;
  if (options.skipSiteChecks) {
    checks = {
      baseUrl,
      robots: { url: '', status: null, found: false, sitemaps: [], disallowAll: false, rules: [] },
      sitemaps: [],
      sitemapUrls: [],
      https: { httpRedirectsToHttps: null, httpStatus: null, finalUrl: null },
      hostCanonicalization: [],
      notFoundHandling: null,
      homepageReachable: true,
    };
    const r = await fetchWithRedirects(new URL('/robots.txt', baseUrl).toString(), fopts);
    if (r.body && (r.status ?? 500) < 400) robots = parseRobots(r.body);
  } else {
    const sc = await siteChecks(baseUrl, fopts);
    robots = sc.robots;
    const sitemapCandidates = sc.robots?.sitemaps.length ? sc.robots.sitemaps : [new URL('/sitemap.xml', baseUrl).toString()];
    const sm = await collectSitemapUrls(sitemapCandidates, fopts);
    checks = { ...sc.checks, sitemaps: sm.fetched, sitemapUrls: sm.urls };
  }
  const sitemapSet = new Set(checks.sitemapUrls);
  const respectRobots = options.respectRobots ?? true;

  const pages = new Map<string, CrawledPage>();
  const queued = new Set<string>();
  const queue: { url: string; depth: number; from: string | null }[] = [];
  const enqueue = (url: string, depth: number, from: string | null) => {
    const n = normalizeUrl(url);
    if (!n || queued.has(n) || !sameSite(n, baseUrl) || SKIP_EXT.test(new URL(n).pathname) || depth > maxDepth) return;
    if (queued.size >= maxPages) return;
    queued.add(n);
    queue.push({ url: n, depth, from });
  };
  enqueue(baseUrl, 0, null);
  if (options.includeSitemapUrls !== false) for (const u of checks.sitemapUrls) enqueue(u, 1, 'sitemap');

  let truncated = false;
  let inFlight = 0;
  const worker = async () => {
    // Keep idle workers alive while others may still discover new URLs.
    while (queue.length || inFlight > 0) {
      if (!queue.length) {
        await sleep(25);
        continue;
      }
      const item = queue.shift()!;
      inFlight++;
      const page = await crawlOne(item.url, item.depth, item.from).finally(() => inFlight--);
      pages.set(item.url, page);
      await options.onPage?.(page);
      if (page.statusCode && page.statusCode < 400 && page.indexable !== undefined) {
        for (const l of page.internalLinks) {
          if (queued.size >= maxPages) {
            truncated = true;
            break;
          }
          enqueue(l.href, item.depth + 1, item.url);
        }
      }
      if (delayMs) await sleep(delayMs);
    }
  };

  const crawlOne = async (url: string, depth: number, from: string | null): Promise<CrawledPage> => {
    const path = new URL(url).pathname + new URL(url).search;
    const base: CrawledPage = {
      url,
      finalUrl: url,
      statusCode: null,
      redirectChain: [],
      redirectLoop: false,
      responseTimeMs: null,
      contentType: null,
      contentLength: null,
      canonical: null,
      robotsMeta: null,
      xRobotsTag: null,
      indexable: false,
      indexabilityReason: null,
      title: null,
      metaDescription: null,
      h1s: [],
      h2s: [],
      h3s: [],
      wordCount: 0,
      images: [],
      internalLinks: [],
      externalLinks: [],
      structuredData: [],
      openGraph: {},
      hreflang: [],
      lang: null,
      contentHash: null,
      textSample: '',
      signals: emptySignals(),
      depth,
      inSitemap: sitemapSet.has(url),
      discoveredFrom: from,
      blockedByRobots: false,
      error: null,
    };
    if (robots && !isAllowed(robots, 'googlebot', path)) {
      base.blockedByRobots = true;
      base.indexabilityReason = 'Blocked by robots.txt';
      if (respectRobots) return base;
    }
    const res = await fetchWithRedirects(url, fopts);
    base.finalUrl = normalizeUrl(res.finalUrl) ?? res.finalUrl;
    base.statusCode = res.status;
    base.redirectChain = res.redirectChain;
    base.redirectLoop = res.redirectLoop;
    base.responseTimeMs = res.timeMs;
    base.contentType = res.headers['content-type'] ?? null;
    base.contentLength = res.headers['x-body-bytes'] ? Number(res.headers['x-body-bytes']) : res.headers['content-length'] ? Number(res.headers['content-length']) : null;
    base.xRobotsTag = res.headers['x-robots-tag'] ?? null;
    base.error = res.error;
    if (res.error || res.status === null) {
      base.indexabilityReason = res.error ?? 'No response';
      return base;
    }
    if (res.redirectChain.length) {
      base.indexabilityReason = `Redirects to ${base.finalUrl}`;
      // Crawl the destination as its own page if internal.
      if (sameSite(base.finalUrl, baseUrl)) enqueue(base.finalUrl, depth, url);
      return base;
    }
    if (res.status >= 400) {
      base.indexabilityReason = `HTTP ${res.status}`;
      return base;
    }
    if (!HTML_TYPES.test(base.contentType ?? '') || !res.body) {
      base.indexabilityReason = `Non-HTML content (${base.contentType ?? 'unknown'})`;
      return base;
    }
    return applyHtmlToPage(base, res.body, baseUrl);
  };

  log.info('crawl.start', { baseUrl, maxPages, concurrency, sitemapUrls: checks.sitemapUrls.length });
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Bounded external link checks.
  const externalLinkStatus: Record<string, number | null> = {};
  if (options.checkExternalLinks) {
    const ext = [...new Set([...pages.values()].flatMap((p) => p.externalLinks.map((l) => l.href)))].slice(0, options.maxExternalChecks ?? 100);
    for (const href of ext) {
      const r = await fetchWithRedirects(href, { ...fopts, method: 'HEAD', readBody: false, timeoutMs: 10000 });
      externalLinkStatus[href] = r.status === 405 || r.status === 403 ? (await fetchWithRedirects(href, { ...fopts, readBody: false, timeoutMs: 10000 })).status : r.status;
    }
  }

  const all = [...pages.values()];
  const finishedAt = new Date();
  log.info('crawl.finish', { pages: all.length, ms: finishedAt.getTime() - startedAt.getTime() });
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    baseUrl,
    pages: all,
    site: checks,
    externalLinkStatus,
    stats: {
      pagesCrawled: all.length,
      pagesFailed: all.filter((p) => p.error || (p.statusCode ?? 0) >= 400).length,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      truncated,
    },
  };
}
