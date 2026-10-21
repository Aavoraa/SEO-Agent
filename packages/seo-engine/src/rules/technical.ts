import { normalizeUrl } from '@phoenixx/shared';
import { isHtmlOk, pathOf, type RuleDefinition } from './types.js';

const cfg = (severity: RuleDefinition['defaults']['severity'], params: RuleDefinition['defaults']['params'] = {}) => ({ enabled: true, severity, params });

export const technicalRules: RuleDefinition[] = [
  {
    id: 'site_unreachable',
    category: 'technical',
    title: 'Website unavailable',
    rationale: 'If the homepage cannot be fetched, search engines and visitors cannot reach the site.',
    scope: 'site',
    defaults: cfg('critical'),
    check: (ctx) =>
      ctx.site.homepageReachable
        ? []
        : [{ url: ctx.site.baseUrl, title: 'Homepage is not reachable', description: 'The crawler could not load the homepage successfully.', recommendation: 'Check hosting, DNS and SSL immediately.', evidence: { baseUrl: ctx.site.baseUrl } }],
  },
  {
    id: 'robots_disallow_all',
    category: 'technical',
    title: 'robots.txt blocks the whole site',
    rationale: 'A "Disallow: /" for Googlebot prevents crawling of every page and will remove the site from search over time.',
    scope: 'site',
    defaults: cfg('critical'),
    check: (ctx) =>
      ctx.site.robots.disallowAll
        ? [{ url: ctx.site.robots.url, title: 'robots.txt disallows all crawling', description: 'Googlebot is blocked from "/".', recommendation: 'Remove the blanket Disallow rule (requires approval – high-risk change).', evidence: { rules: ctx.site.robots.rules } }]
        : [],
  },
  {
    id: 'robots_missing',
    category: 'technical',
    title: 'robots.txt missing',
    rationale: 'Not harmful by itself, but robots.txt is the standard place to declare the sitemap.',
    scope: 'site',
    defaults: cfg('low'),
    check: (ctx) =>
      ctx.site.robots.found || !ctx.site.robots.url
        ? []
        : [{ url: ctx.site.robots.url, title: 'robots.txt not found', description: `robots.txt returned ${ctx.site.robots.status ?? 'no response'}.`, recommendation: 'Publish a robots.txt that allows crawling and lists the sitemap.', evidence: { status: ctx.site.robots.status } }],
  },
  {
    id: 'ai_search_crawlers_blocked',
    category: 'technical',
    title: 'AI search crawlers blocked',
    rationale: 'ChatGPT search, Claude, Perplexity and Copilot can only show and cite pages their crawlers may fetch. Blocking model-*training* bots is a separate business choice and is not flagged.',
    scope: 'site',
    defaults: cfg('medium'),
    check: (ctx) => {
      const blocked = (ctx.site.profile?.aiCrawlers ?? []).filter((c) => !c.allowed && c.purpose !== 'training' && c.token !== 'Googlebot');
      if (!blocked.length) return [];
      return [
        {
          url: ctx.site.robots.url,
          title: `robots.txt blocks ${blocked.length} AI search crawler(s)`,
          description: `Blocked: ${blocked.map((c) => `${c.token} (${c.product})`).join('; ')}.`,
          recommendation: 'If you want to appear in these AI answers, allow these user agents in robots.txt (requires admin approval). Training crawlers can stay blocked independently.',
          evidence: { blocked: blocked.map((c) => c.token) },
        },
      ];
    },
  },
  {
    id: 'robots_blocks_sitemap_url',
    category: 'technical',
    title: 'robots.txt blocks pages listed in the sitemap',
    rationale: 'Sending conflicting signals (listed in sitemap but blocked) can keep important pages out of the index.',
    scope: 'page',
    defaults: cfg('high'),
    check: (_ctx, _c, p) => (p && p.blockedByRobots && p.inSitemap ? [{ url: p.url, title: 'Sitemap URL blocked by robots.txt', description: 'This URL is in the sitemap but robots.txt disallows it.', recommendation: 'Either allow the URL in robots.txt or remove it from the sitemap.', evidence: {} }] : []),
  },
  {
    id: 'sitemap_missing',
    category: 'technical',
    title: 'XML sitemap missing or failing',
    rationale: 'Sitemaps help search engines discover and prioritise pages, especially after a redesign.',
    scope: 'site',
    defaults: cfg('high'),
    check: (ctx) => {
      if (!ctx.site.sitemaps.length && !ctx.site.robots.url) return [];
      const ok = ctx.site.sitemaps.some((s) => s.urlCount > 0);
      return ok ? [] : [{ url: ctx.site.sitemaps[0]?.url ?? null, title: 'No working XML sitemap found', description: 'No sitemap returned any URLs.', recommendation: 'Publish /sitemap.xml and reference it in robots.txt.', evidence: { sitemaps: ctx.site.sitemaps } }];
    },
  },
  {
    id: 'sitemap_not_in_robots',
    category: 'technical',
    title: 'Sitemap not referenced in robots.txt',
    rationale: 'Declaring the sitemap in robots.txt helps every search engine find it.',
    scope: 'site',
    defaults: cfg('low'),
    check: (ctx) => (ctx.site.robots.found && !ctx.site.robots.sitemaps.length && ctx.site.sitemaps.some((s) => s.urlCount > 0) ? [{ url: ctx.site.robots.url, title: 'robots.txt has no Sitemap: line', description: 'A sitemap exists but robots.txt does not declare it.', recommendation: 'Add "Sitemap: <url>" to robots.txt.', evidence: {} }] : []),
  },
  {
    id: 'sitemap_bad_url',
    category: 'technical',
    title: 'Sitemap lists non-200 or non-indexable URLs',
    rationale: 'Sitemaps should only contain canonical, indexable 200 pages; errors waste crawl budget and reduce trust in the sitemap.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (_ctx, _c, p) => {
      if (!p || !p.inSitemap || p.blockedByRobots) return [];
      if (p.redirectChain.length) return [{ url: p.url, title: 'Sitemap URL redirects', description: `Redirects to ${p.finalUrl}.`, recommendation: 'List the final destination URL in the sitemap instead.', evidence: { finalUrl: p.finalUrl, chain: p.redirectChain }, key: 'redirect' }];
      if ((p.statusCode ?? 0) >= 400 || p.statusCode === null) return [{ url: p.url, title: `Sitemap URL returns ${p.statusCode ?? 'no response'}`, description: 'The sitemap lists a URL that does not load.', recommendation: 'Fix the page or remove it from the sitemap.', evidence: { status: p.statusCode }, key: 'status', severityOverride: 'high' }];
      if (isHtmlOk(p) && !p.indexable) return [{ url: p.url, title: 'Sitemap URL is not indexable', description: p.indexabilityReason ?? 'Not indexable.', recommendation: 'Remove non-indexable URLs from the sitemap or make the page indexable.', evidence: { reason: p.indexabilityReason }, key: 'noindex', severityOverride: 'high' }];
      return [];
    },
  },
  {
    id: 'indexable_not_in_sitemap',
    category: 'technical',
    title: 'Indexable page missing from sitemap',
    rationale: 'Pages missing from the sitemap may be discovered later or treated as less important.',
    scope: 'page',
    defaults: cfg('low'),
    check: (ctx, _c, p) => (p && ctx.site.sitemapUrls.length && isHtmlOk(p) && p.indexable && !p.inSitemap ? [{ url: p.url, title: 'Indexable page not in sitemap', description: 'This page is indexable but not listed in the XML sitemap.', recommendation: 'Add the page to the sitemap if it should rank.', evidence: {} }] : []),
  },
  {
    id: 'https_not_enforced',
    category: 'technical',
    title: 'HTTP does not redirect to HTTPS',
    rationale: 'Mixed HTTP/HTTPS versions split ranking signals and trigger browser security warnings.',
    scope: 'site',
    defaults: cfg('high'),
    check: (ctx) => (ctx.site.https.httpRedirectsToHttps === false ? [{ url: ctx.site.baseUrl, title: 'HTTP version is served without redirecting to HTTPS', description: `http:// ended at ${ctx.site.https.finalUrl}.`, recommendation: 'Add a site-wide 301 redirect from HTTP to HTTPS.', evidence: ctx.site.https }] : []),
  },
  {
    id: 'host_not_canonicalized',
    category: 'technical',
    title: 'www / non-www / http variants do not resolve to one host',
    rationale: 'Each host variant should 301 to the single canonical origin to avoid duplicate sites in the index.',
    scope: 'site',
    defaults: cfg('medium'),
    check: (ctx) => {
      const bad = ctx.site.hostCanonicalization.filter((h) => h.status !== null && !h.consistent);
      return bad.length ? [{ url: ctx.site.baseUrl, title: `${bad.length} host variant(s) do not redirect to the canonical homepage`, description: bad.map((b) => `${b.variant} → ${b.finalUrl ?? b.status}`).join('; '), recommendation: 'Redirect all variants with a single 301 hop to the canonical origin.', evidence: { variants: ctx.site.hostCanonicalization } }] : [];
    },
  },
  {
    id: 'soft_404',
    category: 'technical',
    title: 'Missing pages return 200 (soft 404)',
    rationale: 'Non-existent URLs should return 404 so they are not indexed as thin duplicates.',
    scope: 'site',
    defaults: cfg('medium'),
    check: (ctx) => (ctx.site.notFoundHandling?.soft404 ? [{ url: ctx.site.notFoundHandling.url, title: 'Non-existent URL returned HTTP 200', description: 'A random URL returned 200 instead of 404.', recommendation: 'Configure the server to return a real 404 status for unknown URLs.', evidence: ctx.site.notFoundHandling }] : []),
  },
  {
    id: 'http_error',
    category: 'technical',
    title: 'Page returns an error status',
    rationale: 'Error pages cannot rank and waste link equity pointing to them.',
    scope: 'page',
    defaults: cfg('high'),
    check: (ctx, _c, p) => {
      if (!p || p.redirectChain.length || p.blockedByRobots) return [];
      const s = p.statusCode;
      if (s === null) return [{ url: p.url, title: 'Page failed to load', description: p.error ?? 'No response', recommendation: 'Check the server/logs for this URL.', evidence: { error: p.error, from: p.discoveredFrom } }];
      if (s < 400) return [];
      const important = ctx.importantPaths.has(pathOf(p.url));
      return [{ url: p.url, title: `HTTP ${s}`, description: `Page returned ${s}. Linked from: ${[...(ctx.inlinks.get(p.url) ?? [])].slice(0, 5).join(', ') || p.discoveredFrom || 'n/a'}.`, recommendation: s >= 500 ? 'Fix the server error.' : 'Restore the page, or 301-redirect it to the closest relevant page (requires approval), and update internal links.', evidence: { status: s, inlinks: [...(ctx.inlinks.get(p.url) ?? [])].slice(0, 20) }, severityOverride: s >= 500 || important ? 'critical' : undefined }];
    },
  },
  {
    id: 'broken_internal_link',
    category: 'technical',
    title: 'Broken internal links',
    rationale: 'Links to missing pages frustrate users and leak link equity.',
    scope: 'page',
    defaults: cfg('high'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p)) return [];
      const broken = [...new Set(p.internalLinks.map((l) => l.href))].filter((h) => {
        const t = ctx.byUrl.get(h);
        return t && !t.blockedByRobots && (t.statusCode === null || t.statusCode >= 400);
      });
      return broken.length ? [{ url: p.url, title: `${broken.length} broken internal link(s)`, description: `Links to: ${broken.slice(0, 5).join(', ')}`, recommendation: 'Update or remove these links.', evidence: { broken: broken.map((b) => ({ href: b, status: ctx.byUrl.get(b)?.statusCode ?? null })) } }] : [];
    },
  },
  {
    id: 'broken_external_link',
    category: 'technical',
    title: 'Broken external links',
    rationale: 'Outbound links to dead pages look neglected to users.',
    scope: 'page',
    defaults: cfg('low'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p)) return [];
      const broken = [...new Set(p.externalLinks.map((l) => l.href))].filter((h) => {
        const s = ctx.externalLinkStatus[h];
        return s !== undefined && (s === null || s >= 400) && s !== 429 && s !== 999;
      });
      return broken.length ? [{ url: p.url, title: `${broken.length} broken external link(s)`, description: broken.slice(0, 5).join(', '), recommendation: 'Update or remove the outbound links.', evidence: { broken } }] : [];
    },
  },
  {
    id: 'redirect_chain',
    category: 'technical',
    title: 'Redirect chain',
    rationale: 'Each extra hop slows users and search engines; chains should be collapsed to a single 301.',
    scope: 'page',
    defaults: cfg('medium', { maxHops: 1 }),
    check: (_ctx, c, p) => (p && p.redirectChain.length > Number(c.params.maxHops) ? [{ url: p.url, title: `Redirect chain with ${p.redirectChain.length} hops`, description: p.redirectChain.map((h) => `${h.status} ${h.url}`).join(' → ') + ` → ${p.finalUrl}`, recommendation: 'Point the first URL directly at the final destination.', evidence: { chain: p.redirectChain } }] : []),
  },
  {
    id: 'redirect_loop',
    category: 'technical',
    title: 'Redirect loop',
    rationale: 'Loops make the URL permanently unreachable.',
    scope: 'page',
    defaults: cfg('high'),
    check: (_ctx, _c, p) => (p?.redirectLoop ? [{ url: p.url, title: 'Redirect loop detected', description: p.redirectChain.map((h) => h.url).join(' → '), recommendation: 'Fix the redirect rules so the URL resolves.', evidence: { chain: p.redirectChain } }] : []),
  },
  {
    id: 'internal_link_to_redirect',
    category: 'technical',
    title: 'Internal links point at redirecting URLs',
    rationale: 'Linking straight to final URLs saves a hop and passes signals cleanly.',
    scope: 'page',
    defaults: cfg('low'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p)) return [];
      const redir = [...new Set(p.internalLinks.map((l) => l.href))].filter((h) => (ctx.byUrl.get(h)?.redirectChain.length ?? 0) > 0);
      return redir.length ? [{ url: p.url, title: `${redir.length} internal link(s) to redirects`, description: redir.slice(0, 5).map((r) => `${r} → ${ctx.byUrl.get(r)?.finalUrl}`).join('; '), recommendation: 'Update links to the final URL.', evidence: { links: redir } }] : [];
    },
  },
  {
    id: 'missing_canonical',
    category: 'technical',
    title: 'Missing canonical tag',
    rationale: 'A self-referencing canonical protects against duplicate URLs created by parameters or host variants.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && !p.canonical ? [{ url: p.url, title: 'No canonical tag', description: 'The page has no rel=canonical.', recommendation: 'Add a self-referencing canonical tag.', evidence: {} }] : []),
  },
  {
    id: 'canonical_issue',
    category: 'technical',
    title: 'Canonical points to a different or broken URL',
    rationale: 'A wrong canonical can remove the page from search results in favour of another URL.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p) || !p.canonical || p.canonical === p.finalUrl) return [];
      const target = ctx.byUrl.get(p.canonical);
      const crossDomain = (() => {
        try {
          return new URL(p.canonical).hostname.replace(/^www\./, '') !== new URL(p.finalUrl).hostname.replace(/^www\./, '');
        } catch {
          return true;
        }
      })();
      const broken = target && (target.statusCode === null || target.statusCode >= 300 || !target.indexable);
      const hostOnly = normalizeUrl(p.canonical.replace('://www.', '://')) === normalizeUrl(p.finalUrl.replace('://www.', '://'));
      return [
        {
          url: p.url,
          title: crossDomain ? 'Canonical points to another domain' : hostOnly ? 'Canonical points to a different host variant' : broken ? 'Canonical target is not an indexable 200 page' : 'Canonical points to a different URL',
          description: `Canonical: ${p.canonical}`,
          recommendation: 'Confirm the intended canonical. Changing canonicals is a high-risk change and requires approval.',
          evidence: { canonical: p.canonical, targetStatus: target?.statusCode ?? null },
          severityOverride: crossDomain || broken ? 'high' : undefined,
        },
      ];
    },
  },
  {
    id: 'noindex',
    category: 'technical',
    title: 'Page is set to noindex',
    rationale: 'noindex removes the page from search. Fine for utility pages; a serious problem on service pages.',
    scope: 'page',
    defaults: cfg('info'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p) || !/noindex|none/i.test(`${p.robotsMeta},${p.xRobotsTag}`)) return [];
      const important = ctx.importantPaths.has(pathOf(p.url));
      return [{ url: p.url, title: important ? 'Important page is noindex' : 'Page is noindex', description: `Directives: ${[p.robotsMeta, p.xRobotsTag].filter(Boolean).join(' / ')}`, recommendation: important ? 'Remove noindex unless this is deliberate (approval required).' : 'Confirm this page should be excluded from search.', evidence: { robotsMeta: p.robotsMeta, xRobotsTag: p.xRobotsTag }, severityOverride: important ? 'critical' : undefined }];
    },
  },
  {
    id: 'nofollow_page',
    category: 'technical',
    title: 'Page-level nofollow',
    rationale: 'A meta nofollow stops link equity flowing to every linked page; it is usually accidental.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && /nofollow|none/i.test(`${p.robotsMeta},${p.xRobotsTag}`) ? [{ url: p.url, title: 'Meta robots nofollow', description: `Directives: ${p.robotsMeta ?? ''} ${p.xRobotsTag ?? ''}`, recommendation: 'Remove nofollow unless deliberate.', evidence: {} }] : []),
  },
  {
    id: 'slow_response',
    category: 'performance',
    title: 'Slow server response',
    rationale: 'Slow responses hurt user experience and Core Web Vitals (measured here as crawler response time, not full page load).',
    scope: 'page',
    defaults: cfg('medium', { warnMs: 1500, highMs: 3000 }),
    check: (_ctx, c, p) => {
      if (!p || !isHtmlOk(p) || p.responseTimeMs === null || p.responseTimeMs < Number(c.params.warnMs)) return [];
      return [{ url: p.url, title: `Slow response (${p.responseTimeMs} ms)`, description: 'Server response time measured by the crawler exceeds the threshold.', recommendation: 'Enable caching/compression, check hosting performance; verify with PageSpeed Insights.', evidence: { responseTimeMs: p.responseTimeMs }, severityOverride: p.responseTimeMs >= Number(c.params.highMs) ? 'high' : undefined }];
    },
  },
  {
    id: 'oversized_page',
    category: 'performance',
    title: 'Oversized HTML document',
    rationale: 'Very large HTML delays rendering, especially on mobile.',
    scope: 'page',
    defaults: cfg('medium', { maxKb: 1024 }),
    check: (_ctx, c, p) => (p && isHtmlOk(p) && (p.contentLength ?? 0) > Number(c.params.maxKb) * 1024 ? [{ url: p.url, title: `HTML is ${Math.round((p.contentLength ?? 0) / 1024)} KB`, description: 'Large inline CSS/JS or content bloat.', recommendation: 'Move inline CSS/JS into cached files and remove unused markup.', evidence: { bytes: p.contentLength } }] : []),
  },
  {
    id: 'mixed_content',
    category: 'technical',
    title: 'Mixed content',
    rationale: 'HTTP resources on HTTPS pages are blocked by browsers or show security warnings.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (_ctx, _c, p) => (p && p.signals.mixedContent.length ? [{ url: p.url, title: `${p.signals.mixedContent.length} insecure resource(s)`, description: p.signals.mixedContent.slice(0, 5).join(', '), recommendation: 'Load all resources over HTTPS.', evidence: { resources: p.signals.mixedContent } }] : []),
  },
  {
    id: 'missing_viewport',
    category: 'technical',
    title: 'Missing mobile viewport',
    rationale: 'Google uses mobile-first indexing; pages without a viewport render poorly on phones.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && !p.signals.hasViewport ? [{ url: p.url, title: 'No viewport meta tag', description: '', recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', evidence: {} }] : []),
  },
  {
    id: 'duplicate_meta_tags',
    category: 'technical',
    title: 'Duplicate meta tags',
    rationale: 'Repeated meta tags (e.g. two descriptions or robots tags) create ambiguity; search engines may pick either.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => (p && p.signals.duplicateMetaTags.length ? [{ url: p.url, title: `Duplicate meta tag(s): ${p.signals.duplicateMetaTags.join(', ')}`, description: 'The same meta tag appears more than once in <head>.', recommendation: 'Keep one instance of each tag.', evidence: { tags: p.signals.duplicateMetaTags } }] : []),
  },
];
