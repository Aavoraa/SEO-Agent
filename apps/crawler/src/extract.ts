import * as cheerio from 'cheerio';
import { normalizeUrl, sameSite, sha256, type ImageRef, type LinkRef, type PageSignals, type StructuredDataBlock } from '@phoenixx/shared';

export interface ExtractedHtml {
  title: string | null;
  metaDescription: string | null;
  canonical: string | null;
  robotsMeta: string | null;
  h1s: string[];
  h2s: string[];
  h3s: string[];
  wordCount: number;
  images: ImageRef[];
  internalLinks: LinkRef[];
  externalLinks: LinkRef[];
  structuredData: StructuredDataBlock[];
  openGraph: Record<string, string>;
  hreflang: { lang: string; href: string }[];
  lang: string | null;
  contentHash: string;
  textSample: string;
  signals: PageSignals;
}

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();

// Double-encoded UTF-8 as seen on phoenixxit.com service pages ("â€”", "â€™", "Ã©"…).
const MOJIBAKE = /(?:â€[\u0080-¿‘-›€™ŒœŠšŸŽžˆ˜"]|Ã[\u0080-¿]|Â[ -¿])/g;

const PHONE = /(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g;
const CLAIM = /(\b\d{1,3}(?:\.\d+)?\s?%|\b\d{2,}\+?\s+(?:clients|projects|customers|years|brands|businesses)\b|#1\b|\bnumber one\b|\bguarantee[ds]?\b|100% (?:satisfaction|guaranteed))/gi;
const digitsOnly = (s: string) => s.replace(/\D/g, '').replace(/^(91|0)(?=\d{10}$)/, '');

function schemaTypes(data: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const t = o['@type'];
      if (typeof t === 'string') out.add(t);
      if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.add(x));
      if (o['@graph']) walk(o['@graph']);
      for (const [k, x] of Object.entries(o)) if (k !== '@graph' && typeof x === 'object') walk(x);
    }
  };
  walk(data);
  return [...out];
}

export function extractHtml(html: string, pageUrl: string, siteUrl: string): ExtractedHtml {
  const $ = cheerio.load(html);
  const baseHref = $('base[href]').attr('href');
  const base = baseHref ? new URL(baseHref, pageUrl).toString() : pageUrl;

  const meta = (name: string) => clean($(`meta[name="${name}" i]`).first().attr('content')) || null;
  const title = clean($('head title').first().text() || $('title').first().text()) || null;
  const canonicalHref = $('link[rel="canonical" i]').first().attr('href');
  const canonical = canonicalHref ? normalizeUrl(canonicalHref, base) : null;

  const headings = (sel: string) => $(sel).map((_, el) => clean($(el).text())).get().filter(Boolean);

  // Structured data (validate JSON before any schema checks).
  const structuredData: StructuredDataBlock[] = $('script[type="application/ld+json" i]')
    .map((_, el) => {
      const raw = $(el).contents().text().trim();
      try {
        const data = JSON.parse(raw);
        return { valid: true, types: schemaTypes(data), raw: raw.slice(0, 20000), data };
      } catch (e) {
        return { valid: false, error: (e as Error).message, types: [], raw: raw.slice(0, 20000) };
      }
    })
    .get();

  const openGraph: Record<string, string> = {};
  $('meta[property^="og:" i], meta[name^="twitter:" i]').each((_, el) => {
    const k = ($(el).attr('property') || $(el).attr('name') || '').toLowerCase();
    const v = clean($(el).attr('content'));
    if (k && !(k in openGraph)) openGraph[k] = v;
  });

  const hreflang = $('link[rel="alternate" i][hreflang]')
    .map((_, el) => ({ lang: $(el).attr('hreflang') ?? '', href: normalizeUrl($(el).attr('href') ?? '', base) ?? '' }))
    .get();

  // Links
  const internalLinks: LinkRef[] = [];
  const externalLinks: LinkRef[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#|data:|sms:|whatsapp:)/i.test(href)) return;
    const abs = normalizeUrl(href, base);
    if (!abs) return;
    const rel = $(el).attr('rel') ?? null;
    const anchor = clean($(el).text()) || clean($(el).attr('aria-label')) || clean($(el).find('img').attr('alt')) || '';
    const ref: LinkRef = { href: abs, anchor: anchor.slice(0, 200), rel, nofollow: /\bnofollow\b/i.test(rel ?? '') };
    (sameSite(abs, siteUrl) ? internalLinks : externalLinks).push(ref);
  });

  const images: ImageRef[] = $('img')
    .map((_, el) => {
      const alt = $(el).attr('alt');
      const src = $(el).attr('src') || $(el).attr('data-src') || '';
      return {
        src: src ? (normalizeUrl(src, base) ?? src) : '',
        alt: alt ?? null,
        hasAlt: alt !== undefined && alt.trim() !== '',
        width: $(el).attr('width') ?? null,
        height: $(el).attr('height') ?? null,
        loading: $(el).attr('loading') ?? null,
      };
    })
    .get();

  // Signals
  const metaCounts: Record<string, number> = {};
  $('meta[name], meta[property]').each((_, el) => {
    const k = (($(el).attr('name') || $(el).attr('property')) ?? '').toLowerCase();
    metaCounts[k] = (metaCounts[k] ?? 0) + 1;
  });
  const duplicateMetaTags = Object.entries(metaCounts)
    .filter(([k, n]) => n > 1 && ['description', 'robots', 'viewport', 'google-site-verification', 'og:title', 'og:description', 'title'].includes(k))
    .map(([k]) => k);
  const pageIsHttps = pageUrl.startsWith('https:');
  const mixedContent = pageIsHttps
    ? $('img[src^="http:"], script[src^="http:"], link[rel="stylesheet"][href^="http:"], iframe[src^="http:"]')
        .map((_, el) => $(el).attr('src') || $(el).attr('href') || '')
        .get()
        .slice(0, 20)
    : [];
  const ogImage = openGraph['og:image'];
  const headingLevels = $('h1,h2,h3,h4,h5,h6')
    .map((_, el) => Number((el as any).tagName?.slice(1) ?? (el as any).name?.slice(1)))
    .get();
  let skips = 0;
  for (let i = 1; i < headingLevels.length; i++) if (headingLevels[i]! - headingLevels[i - 1]! > 1) skips++;

  // Visible text (strip non-content)
  const $body = $('body').clone();
  $body.find('script, style, noscript, svg, template, iframe').remove();
  const text = clean($body.text());
  const words = text ? text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)) : [];
  const mainText = clean($('main').text()) || text;
  const mojibakeCount = (text.match(MOJIBAKE) ?? []).length + (title?.match(MOJIBAKE) ?? []).length;
  const siteHost = (() => {
    try {
      return new URL(siteUrl).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  })();
  const hotlinkedImages = images.filter((i) => {
    try {
      const h = new URL(i.src).hostname.replace(/^www\./, '');
      return h !== siteHost && !/cdn|cloudfront|googleusercontent/.test(h) && /unsplash|pexels|pixabay|freepik/.test(h);
    } catch {
      return false;
    }
  }).length;

  return {
    title,
    metaDescription: meta('description'),
    canonical,
    robotsMeta: [meta('robots'), meta('googlebot')].filter(Boolean).join(', ') || null,
    h1s: headings('h1'),
    h2s: headings('h2'),
    h3s: headings('h3'),
    wordCount: words.length,
    images,
    internalLinks,
    externalLinks,
    structuredData,
    openGraph,
    hreflang,
    lang: $('html').attr('lang') ?? null,
    contentHash: sha256(mainText.toLowerCase()),
    textSample: mainText.slice(0, 3000),
    signals: {
      hasViewport: $('meta[name="viewport" i]').length > 0,
      hasCharset: $('meta[charset]').length > 0 || /charset=/i.test($('meta[http-equiv="content-type" i]').attr('content') ?? ''),
      mojibakeCount,
      mixedContent,
      duplicateMetaTags,
      relativeOgImage: !!ogImage && !/^https?:\/\//i.test(ogImage),
      htmlLang: $('html').attr('lang') ?? null,
      headingOrderSkips: skips,
      hotlinkedImages,
      phones: [...new Set([...$('a[href^="tel:" i]').map((_, el) => $(el).attr('href') ?? '').get(), ...(text.match(PHONE) ?? [])].map(digitsOnly).filter((d) => d.length >= 10))],
      claims: [...new Set((text.match(CLAIM) ?? []).map((s) => s.trim()))].slice(0, 30),
    },
  };
}
