import { detectSiteProfile, extractHtml, fetchWithRedirects, parseRobots } from '@phoenixx/crawler';
import { AppError, normalizeUrl } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { assertPublicHost } from './net-guard.js';

/**
 * Website auto-detection for onboarding. Reads the public homepage, robots.txt and sitemap (read-only)
 * and recommends how to connect the site. Hosting providers are never inferred from weak signals:
 * only what the responses actually show (headers, generator tags, asset paths) is reported.
 */
export interface ConnectionOption {
  method: 'wordpress' | 'shopify' | 'webflow' | 'wix' | 'git' | 'sftp' | 'ftp' | 'api' | 'manual';
  label: string;
  available: boolean;
  reason: string;
  handles: ('content' | 'code')[];
}

export async function detectWebsite(ctx: AppContext, rawUrl: string) {
  const url = normalizeUrl(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`);
  if (!url) throw new AppError('Enter a valid website address', 400, 'validation');
  try {
    await assertPublicHost(url, ctx.cfg.OUTBOUND_ALLOW_PRIVATE_HOSTS);
  } catch {
    throw new AppError('That address is not a public website', 400, 'validation');
  }
  const opts = { userAgent: ctx.cfg.CRAWL_USER_AGENT, timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS, maxBytes: 3_000_000 };
  const home = await fetchWithRedirects(url, opts);
  if (!home.body || (home.status ?? 0) >= 400) throw new AppError(`Could not load ${url} (${home.error ?? `HTTP ${home.status}`})`, 422, 'unreachable');
  const finalUrl = home.finalUrl;
  const origin = new URL(finalUrl).origin;
  const x = extractHtml(home.body, finalUrl, finalUrl);
  const profile = detectSiteProfile(home.body, home.headers, x.wordCount);
  const robotsRes = await fetchWithRedirects(`${origin}/robots.txt`, { ...opts, maxBytes: 256 * 1024 });
  const robotsOk = !!robotsRes.body && (robotsRes.status ?? 0) < 400 && !/<html/i.test(robotsRes.body.slice(0, 300));
  const robots = robotsOk ? parseRobots(robotsRes.body!) : null;
  const sitemapUrl = robots?.sitemaps[0] ?? `${origin}/sitemap.xml`;
  const sitemap = await fetchWithRedirects(sitemapUrl, { ...opts, maxBytes: 5_000_000 });
  const sitemapOk = (sitemap.status ?? 0) === 200 && /<(urlset|sitemapindex)/i.test(sitemap.body ?? '');
  const has = (n: string) => profile.technologies.some((t) => t.name === n);
  const cms = profile.technologies.find((t) => t.category === 'cms')?.name ?? null;
  const framework = profile.technologies.find((t) => t.category === 'framework')?.name ?? null;

  const options: ConnectionOption[] = [];
  if (has('WordPress')) options.push({ method: 'wordpress', label: 'WordPress REST API (application password)', available: true, reason: 'WordPress detected (wp-content / generator tag).', handles: ['content'] });
  if (has('Shopify')) options.push({ method: 'shopify', label: 'Shopify Admin API', available: false, reason: 'Shopify detected. The Shopify adapter is on the roadmap – use manual export until then.', handles: ['content'] });
  if (has('Webflow')) options.push({ method: 'webflow', label: 'Webflow CMS API', available: false, reason: 'Webflow detected. The Webflow adapter is on the roadmap – use manual export until then.', handles: ['content'] });
  if (has('Wix')) options.push({ method: 'wix', label: 'Wix (limited API)', available: false, reason: 'Wix detected. Wix exposes limited SEO APIs – manual export is recommended.', handles: ['content'] });
  if (framework && ['Next.js', 'Nuxt', 'Gatsby', 'Astro', 'React (client-side)', 'Vue (client-side)', 'Angular'].includes(framework)) {
    options.push({ method: 'git', label: 'Git repository (commit on a branch, your pipeline deploys)', available: true, reason: `${framework} detected – pages are built from code, so changes belong in the repository.`, handles: ['content', 'code'] });
  }
  if (profile.rendering === 'static-html') {
    options.push({ method: 'sftp', label: 'SFTP (file deployment with backup & verification)', available: true, reason: 'Hand-built HTML detected – files can be edited directly on the server.', handles: ['content', 'code'] });
    options.push({ method: 'git', label: 'Git repository', available: true, reason: 'If the site lives in a repository, commit-based changes keep full history.', handles: ['content', 'code'] });
  }
  if (cms === 'WordPress') options.push({ method: 'git', label: 'Git / SFTP for theme code', available: true, reason: 'Code changes (templates, schema in themes) should go through your deployment pipeline, not the CMS.', handles: ['code'] });
  options.push({ method: 'manual', label: 'Manual export (no connection)', available: true, reason: 'Approved changes become precise instructions for your developer. Always available.', handles: ['content', 'code'] });

  const schemaTypes = [...new Set(x.structuredData.filter((s) => s.valid).flatMap((s) => s.types))];
  return {
    url: finalUrl,
    status: home.status,
    https: finalUrl.startsWith('https://'),
    title: x.title,
    cms,
    framework,
    rendering: profile.rendering,
    renderingNote: profile.renderingNote,
    server: profile.server,
    cdn: profile.technologies.filter((t) => t.category === 'cdn').map((t) => t.name),
    seoPlugins: profile.technologies.filter((t) => t.category === 'seo_plugin').map((t) => t.name),
    analytics: profile.analytics,
    technologies: profile.technologies,
    robots: { found: robotsOk, sitemaps: robots?.sitemaps ?? [], blocksAll: robots ? robots.groups.some((g) => g.userAgents.includes('*') && g.disallow.includes('/')) : false },
    sitemap: { url: sitemapUrl, found: sitemapOk },
    schemaTypes,
    language: x.lang,
    recommendedConnection: options[0]!,
    connectionOptions: options,
    hostingNote: 'Hosting provider is not inferred – only the server software and CDN visible in the response headers are reported.',
  };
}
