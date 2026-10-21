import type { AiCrawlerAccess, SiteProfile } from '@phoenixx/shared';
import { isAllowed, type ParsedRobots } from './robots.js';

/**
 * Crawlers used by AI and search products, by robots.txt token. `purpose` matters for advice:
 * blocking a *search/user* crawler removes the site from that product's answers and citations;
 * blocking a *training* crawler only opts out of model training and is a business decision.
 */
export const AI_CRAWLERS: Omit<AiCrawlerAccess, 'allowed' | 'matchedGroup'>[] = [
  { token: 'Googlebot', owner: 'Google', product: 'Google Search, AI Overviews, AI Mode', purpose: 'search' },
  { token: 'Google-Extended', owner: 'Google', product: 'Gemini training & grounding (control token)', purpose: 'training' },
  { token: 'Bingbot', owner: 'Microsoft', product: 'Bing, Copilot', purpose: 'search' },
  { token: 'OAI-SearchBot', owner: 'OpenAI', product: 'ChatGPT search results', purpose: 'search' },
  { token: 'ChatGPT-User', owner: 'OpenAI', product: 'ChatGPT fetching pages for a user', purpose: 'user' },
  { token: 'GPTBot', owner: 'OpenAI', product: 'OpenAI model training', purpose: 'training' },
  { token: 'Claude-SearchBot', owner: 'Anthropic', product: 'Claude search results', purpose: 'search' },
  { token: 'Claude-User', owner: 'Anthropic', product: 'Claude fetching pages for a user', purpose: 'user' },
  { token: 'ClaudeBot', owner: 'Anthropic', product: 'Anthropic model training', purpose: 'training' },
  { token: 'PerplexityBot', owner: 'Perplexity', product: 'Perplexity search index', purpose: 'search' },
  { token: 'Perplexity-User', owner: 'Perplexity', product: 'Perplexity fetching pages for a user', purpose: 'user' },
  { token: 'Applebot-Extended', owner: 'Apple', product: 'Apple AI training (control token)', purpose: 'training' },
  { token: 'CCBot', owner: 'Common Crawl', product: 'Open web dataset used by many models', purpose: 'training' },
  { token: 'Meta-ExternalAgent', owner: 'Meta', product: 'Meta AI training', purpose: 'training' },
  { token: 'Bytespider', owner: 'ByteDance', product: 'ByteDance AI training', purpose: 'training' },
];

/** Whether each AI/search crawler may fetch the homepage under the site's robots.txt (no robots.txt = allowed). */
export function aiCrawlerAccess(robots: ParsedRobots | null, path = '/'): AiCrawlerAccess[] {
  return AI_CRAWLERS.map((c) => {
    if (!robots) return { ...c, allowed: true, matchedGroup: null };
    const token = c.token.toLowerCase();
    const specific = robots.groups.find((g) => g.userAgents.includes(token));
    const matchedGroup = specific ? c.token : robots.groups.some((g) => g.userAgents.includes('*')) ? '*' : null;
    return { ...c, allowed: isAllowed(robots, token, path), matchedGroup };
  });
}

interface Fingerprint {
  name: string;
  category: SiteProfile['technologies'][number]['category'];
  test: RegExp;
  where?: 'html' | 'headers';
}

// Evidence must be structural (asset paths, generator tags, globals) – not words in body copy,
// otherwise a page *mentioning* React would be reported as built with React.
const FINGERPRINTS: Fingerprint[] = [
  { name: 'WordPress', category: 'cms', test: /\/wp-content\/|\/wp-includes\/|<meta[^>]+generator[^>]+WordPress/i },
  { name: 'Shopify', category: 'cms', test: /cdn\.shopify\.com|Shopify\.theme/i },
  { name: 'Wix', category: 'cms', test: /static\.wixstatic\.com|<meta[^>]+generator[^>]+Wix/i },
  { name: 'Webflow', category: 'cms', test: /<html[^>]+data-wf-site|assets\.website-files\.com/i },
  { name: 'Squarespace', category: 'cms', test: /static1\.squarespace\.com/i },
  { name: 'Drupal', category: 'cms', test: /<meta[^>]+generator[^>]+Drupal|\/sites\/default\/files\//i },
  { name: 'Joomla', category: 'cms', test: /<meta[^>]+generator[^>]+Joomla/i },
  { name: 'Next.js', category: 'framework', test: /id="__NEXT_DATA__"|\/_next\/static\//i },
  { name: 'Nuxt', category: 'framework', test: /id="__NUXT_DATA__"|window\.__NUXT__|\/_nuxt\//i },
  { name: 'Gatsby', category: 'framework', test: /id="___gatsby"/i },
  { name: 'Astro', category: 'framework', test: /<astro-island|<meta[^>]+generator[^>]+Astro/i },
  { name: 'React (client-side)', category: 'framework', test: /data-reactroot|<div id="root"><\/div>|react-dom(\.production)?(\.min)?\.js/i },
  { name: 'Vue (client-side)', category: 'framework', test: /<div id="app"><\/div>|vue(\.global)?(\.prod)?(\.min)?\.js/i },
  { name: 'Angular', category: 'framework', test: /<[a-z-]+ ng-version=|ng-app=/i },
  { name: 'jQuery', category: 'library', test: /jquery(-[\d.]+)?(\.min)?\.js/i },
  { name: 'GSAP', category: 'library', test: /gsap(\.min)?\.js/i },
  { name: 'Bootstrap', category: 'library', test: /bootstrap(\.bundle)?(\.min)?\.(css|js)/i },
  { name: 'Tailwind CSS', category: 'library', test: /cdn\.tailwindcss\.com|tailwind(\.min)?\.css/i },
  { name: 'Font Awesome', category: 'library', test: /font-?awesome/i },
  { name: 'Google Fonts', category: 'library', test: /fonts\.googleapis\.com/i },
  { name: 'Google Analytics 4', category: 'analytics', test: /gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i },
  { name: 'Google Tag Manager', category: 'analytics', test: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/ },
  { name: 'Meta Pixel', category: 'analytics', test: /connect\.facebook\.net\/[^"']+\/fbevents\.js/i },
  { name: 'Microsoft Clarity', category: 'analytics', test: /clarity\.ms\/tag/i },
  { name: 'Hotjar', category: 'analytics', test: /static\.hotjar\.com/i },
  { name: 'Yoast SEO', category: 'seo_plugin', test: /yoast-schema-graph|optimized with the Yoast SEO/i },
  { name: 'Rank Math', category: 'seo_plugin', test: /rank-math|Rank Math WordPress SEO/i },
  { name: 'All in One SEO', category: 'seo_plugin', test: /All in One SEO|aioseo/i },
  { name: 'SEOPress', category: 'seo_plugin', test: /seopress/i },
  { name: 'Cloudflare', category: 'cdn', test: /server: cloudflare|cf-ray/i, where: 'headers' },
  { name: 'Fastly', category: 'cdn', test: /x-served-by: cache-|fastly/i, where: 'headers' },
  { name: 'Amazon CloudFront', category: 'cdn', test: /x-amz-cf-id|cloudfront/i, where: 'headers' },
  { name: 'Akamai', category: 'cdn', test: /akamai/i, where: 'headers' },
  { name: 'Apache', category: 'hosting', test: /^server: apache/im, where: 'headers' },
  { name: 'nginx', category: 'hosting', test: /^server: nginx/im, where: 'headers' },
  { name: 'LiteSpeed', category: 'hosting', test: /^server: litespeed/im, where: 'headers' },
  { name: 'Vercel', category: 'hosting', test: /x-vercel-id|^vercel$/i, where: 'headers' },
  { name: 'Netlify', category: 'hosting', test: /x-nf-request-id|^netlify$/i, where: 'headers' },
];

/** Technology, analytics and rendering profile from the homepage response. */
export function securityHeadersOf(headers: Record<string, string>): NonNullable<SiteProfile['securityHeaders']> {
  const h = (k: string) => headers[k] ?? null;
  return { hsts: h('strict-transport-security'), contentTypeOptions: h('x-content-type-options'), frameOptions: h('x-frame-options'), csp: h('content-security-policy'), referrerPolicy: h('referrer-policy'), permissionsPolicy: h('permissions-policy') };
}

function isEmbeddable(sec: NonNullable<SiteProfile['securityHeaders']>): boolean {
  if (sec.frameOptions && /deny|sameorigin/i.test(sec.frameOptions)) return false;
  const fa = sec.csp?.match(/frame-ancestors([^;]*)/i)?.[1]?.trim();
  return !fa || fa.includes('*');
}

export function detectSiteProfile(html: string, headers: Record<string, string>, visibleWords: number): Omit<SiteProfile, 'aiCrawlers' | 'llmsTxt'> {
  const securityHeaders = securityHeadersOf(headers);
  const headerText = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n') + '\n' + (headers.server ?? '');
  const technologies = FINGERPRINTS.filter((f) => f.test.test(f.where === 'headers' ? headerText : html)).map((f) => ({ name: f.name, category: f.category }));
  const has = (n: string) => technologies.some((t) => t.name === n);
  const ids = (re: RegExp) => [...new Set([...html.matchAll(re)].map((m) => m[1]!))];
  const csr = (has('React (client-side)') || has('Vue (client-side)') || has('Angular')) && visibleWords < 150;
  const rendering: SiteProfile['rendering'] = csr
    ? 'client-side'
    : ['Next.js', 'Nuxt', 'Gatsby', 'Astro'].some(has)
      ? 'framework-ssr'
      : technologies.some((t) => t.category === 'cms')
        ? 'cms'
        : 'static-html';
  return {
    server: headers.server ?? null,
    poweredBy: headers['x-powered-by'] ?? null,
    technologies,
    analytics: { ga4: ids(/['"(=](G-[A-Z0-9]{6,12})\b/g), gtm: ids(/\b(GTM-[A-Z0-9]{4,8})\b/g) },
    rendering,
    securityHeaders,
    embeddable: isEmbeddable(securityHeaders),
    renderingNote:
      rendering === 'client-side'
        ? 'Content is rendered by JavaScript in the browser; enable JavaScript rendering for accurate audits.'
        : rendering === 'static-html'
          ? 'Hand-built HTML pages: changes are made in the site files (Git/static adapter or manual export).'
          : rendering === 'cms'
            ? 'CMS-managed site: a CMS adapter can apply approved changes.'
            : 'Server-rendered framework: HTML responses contain the content.',
  };
}
