import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crawlSite, fetchWithRedirects } from '@phoenixx/crawler';
import { candidateFilesForPath } from '@phoenixx/integrations';
import type { CrawlOutput, SiteChecks } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { prepareDemoHtml } from './heatmaps.js';

/**
 * DEMO website: a local copy of the Phoenixx IT HTML pages served on its own port. Demo deployments
 * write to this copy and demo audits crawl it, so the whole Audit → Fix → Approve → Deploy → Verify
 * → Rollback flow can be tried end to end without touching the real website.
 */

export const demoSitePort = (ctx: AppContext) => ctx.cfg.API_PORT + 1;
export const demoSiteOrigin = (ctx: AppContext) => `http://127.0.0.1:${demoSitePort(ctx)}`;

const fileFor = (pathname: string) => (pathname === '/' ? 'index.html' : `${pathname.replace(/^\/+|\/+$/g, '')}.html`);

/** Creates the demo copy once: fetches the public pages (read-only) or, offline, rebuilds them from the sample crawl. */
export async function ensureDemoSite(ctx: AppContext, sample: CrawlOutput, log: (m: string) => void = () => undefined) {
  const dir = path.resolve(ctx.cfg.DEMO_SITE_DIR);
  if (existsSync(path.join(dir, 'index.html'))) return { dir, created: false };
  mkdirSync(dir, { recursive: true });
  let fetched = 0;
  for (const p of sample.pages.filter((x) => x.statusCode === 200)) {
    const u = new URL(p.url);
    const r = await fetchWithRedirects(p.url, { userAgent: ctx.cfg.CRAWL_USER_AGENT, timeoutMs: 15000, maxBytes: 3_000_000 }).catch(() => null);
    let html: string;
    if (r?.body && r.status === 200) {
      html = r.body;
      fetched++;
    } else {
      html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${p.title ?? ''}</title>
${p.metaDescription ? `<meta name="description" content="${p.metaDescription.replace(/"/g, '&quot;')}">` : ''}
${p.canonical ? `<link rel="canonical" href="${p.canonical}">` : ''}
</head><body>
${p.h1s.map((h) => `<h1>${h}</h1>`).join('\n')}
${p.h2s.map((h) => `<h2>${h}</h2>`).join('\n')}
<p>${p.textSample}</p>
${p.internalLinks.map((l) => `<a href="${new URL(l.href).pathname}">${l.anchor}</a>`).join(' ')}
</body></html>`;
    }
    const marker = `<!-- DEMO COPY of ${p.url} for the Phoenixx SEO Agent demo – changes here never reach the real website -->`;
    html = /^\s*<!doctype[^>]*>/i.test(html) ? html.replace(/^(\s*<!doctype[^>]*>)/i, `$1\n${marker}`) : `${marker}\n${html}`;
    writeFileSync(path.join(dir, fileFor(u.pathname)), html);
  }
  log(`Demo website copy created in ${dir} (${fetched} page(s) fetched from the public site, the rest rebuilt from sample data)`);
  return { dir, created: true };
}

/** Tiny static server for the demo copy. HTML comes from the copy; assets redirect to the public site so previews render. */
export function startDemoSiteServer(ctx: AppContext, realSiteUrl: string, opts: { trackerTag?: () => Promise<string | null> } = {}) {
  const root = path.resolve(ctx.cfg.DEMO_SITE_DIR);
  const server = http.createServer(async (req, res) => {
    const p = (req.url ?? '/').split('?')[0]!;
    // No X-Robots-Tag here: the copy only listens on 127.0.0.1, and a noindex header would make the demo crawl
    // treat every page as non-indexable.
    const headers = { 'cache-control': 'no-store' };
    if (p === '/robots.txt') {
      res.writeHead(200, { ...headers, 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    const clean = decodeURIComponent(p);
    const isPage = !/\.[a-z0-9]{2,5}$/i.test(clean) || /\.html?$/i.test(clean);
    if (!isPage) {
      res.writeHead(302, { ...headers, location: new URL(clean.replace(/^\/+/, ''), realSiteUrl).toString() });
      return res.end();
    }
    for (const c of candidateFilesForPath(clean)) {
      const abs = path.resolve(root, c);
      if (!abs.startsWith(root + path.sep) || !existsSync(abs) || realpathSync(abs) !== abs) continue;
      let html = readFileSync(abs, 'utf8');
      // People browsing the copy get the heatmap tracker (and no real-site analytics); the crawler and
      // deployment verification get the file exactly as stored.
      const ua = req.headers['user-agent'] ?? '';
      if (/Mozilla/.test(ua) && !ua.includes(ctx.cfg.CRAWL_USER_AGENT)) html = prepareDemoHtml(html, (await opts.trackerTag?.().catch(() => null)) ?? null);
      res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(404, { ...headers, 'content-type': 'text/html' });
    res.end('<h1>Not found (demo copy)</h1>');
  });
  server.listen(demoSitePort(ctx), '127.0.0.1');
  return server;
}

/**
 * Demo audits crawl the local copy, then map URLs back to the real site so they line up with the
 * demo's sample Search Console data. Site-level checks (robots, HTTPS, host variants) can't be
 * measured on a localhost copy, so the last real site checks are reused.
 */
export async function crawlDemoSite(ctx: AppContext, realBaseUrl: string, previousSite: SiteChecks, userAgent: string, maxPages: number): Promise<CrawlOutput> {
  const demo = demoSiteOrigin(ctx);
  const real = new URL(realBaseUrl).origin;
  const out = await crawlSite({ baseUrl: `${demo}/`, maxPages, concurrency: 3, delayMs: 0, timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS, userAgent, skipSiteChecks: true, logger: ctx.log.child({ demoCrawl: true }) });
  const mapped = JSON.parse(JSON.stringify(out).split(demo).join(real)) as CrawlOutput;
  const inSitemap = new Set(previousSite.sitemapUrls);
  for (const p of mapped.pages) {
    p.inSitemap = inSitemap.has(p.url);
    // During the crawl the real canonical (https://www…) differed from the localhost URL, which marks
    // every page "canonicalised elsewhere". With URLs mapped back, a self-canonical is indexable again.
    if (p.indexabilityReason?.startsWith('Canonicalised to ') && p.canonical === p.finalUrl && !/noindex|none/i.test(`${p.robotsMeta ?? ''},${p.xRobotsTag ?? ''}`)) {
      p.indexable = true;
      p.indexabilityReason = null;
    }
  }
  return { ...mapped, baseUrl: realBaseUrl, site: previousSite };
}
