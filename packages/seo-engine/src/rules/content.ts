import { isHtmlOk, pathOf, type RuleContext, type RuleDefinition } from './types.js';

const cfg = (severity: RuleDefinition['defaults']['severity'], params: RuleDefinition['defaults']['params'] = {}) => ({ enabled: true, severity, params });

/** Groups indexable pages by a value to find duplicates. */
function duplicates(ctx: RuleContext, get: (p: RuleContext['pages'][number]) => string | null) {
  const map = new Map<string, string[]>();
  for (const p of ctx.pages) {
    if (!isHtmlOk(p) || !p.indexable) continue;
    const v = get(p)?.trim().toLowerCase();
    if (!v) continue;
    map.set(v, [...(map.get(v) ?? []), p.url]);
  }
  return [...map.entries()].filter(([, urls]) => urls.length > 1);
}


export const contentRules: RuleDefinition[] = [
  {
    id: 'missing_title',
    category: 'content',
    title: 'Missing title tag',
    rationale: 'The title is the main clickable headline in search results.',
    scope: 'page',
    defaults: cfg('high'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && !p.title ? [{ url: p.url, title: 'Missing <title>', description: 'No title tag found.', recommendation: 'Write a unique, descriptive title (≈50–60 characters).', evidence: {} }] : []),
  },
  {
    id: 'title_length',
    category: 'content',
    title: 'Title length outside recommended range',
    rationale: 'Very long titles are truncated in results; very short titles waste space to communicate relevance.',
    scope: 'page',
    defaults: cfg('low', { min: 30, max: 60 }),
    check: (_ctx, c, p) => {
      if (!p || !isHtmlOk(p) || !p.title) return [];
      const len = p.title.length;
      if (len > Number(c.params.max)) return [{ url: p.url, title: `Title too long (${len} chars)`, description: p.title, recommendation: `Aim for ≤${c.params.max} characters so it is not truncated.`, evidence: { title: p.title, length: len } }];
      if (len < Number(c.params.min)) return [{ url: p.url, title: `Title too short (${len} chars)`, description: p.title, recommendation: 'Add the primary service/keyword and brand.', evidence: { title: p.title, length: len } }];
      return [];
    },
  },
  {
    id: 'duplicate_title',
    category: 'content',
    title: 'Duplicate titles',
    rationale: 'Pages with identical titles compete with each other and confuse searchers.',
    scope: 'site',
    defaults: cfg('medium'),
    check: (ctx) => duplicates(ctx, (p) => p.title).flatMap(([title, urls]) => urls.map((u) => ({ url: u, title: 'Duplicate title', description: `"${title}" is used on ${urls.length} pages.`, recommendation: 'Give each page a unique title that reflects its specific topic.', evidence: { title, urls } }))),
  },
  {
    id: 'missing_meta_description',
    category: 'content',
    title: 'Missing meta description',
    rationale: 'Without a description Google picks arbitrary page text for the snippet, which often lowers click-through.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && p.indexable && !p.metaDescription ? [{ url: p.url, title: 'Missing meta description', description: '', recommendation: 'Write a unique 120–160 character description with a clear benefit and CTA.', evidence: {} }] : []),
  },
  {
    id: 'meta_description_length',
    category: 'content',
    title: 'Meta description length outside recommended range',
    rationale: 'Long descriptions are cut off; short ones under-sell the page.',
    scope: 'page',
    defaults: cfg('low', { min: 70, max: 160 }),
    check: (_ctx, c, p) => {
      if (!p || !isHtmlOk(p) || !p.metaDescription) return [];
      const len = p.metaDescription.length;
      if (len > Number(c.params.max)) return [{ url: p.url, title: `Meta description too long (${len} chars)`, description: p.metaDescription, recommendation: `Keep it under ~${c.params.max} characters.`, evidence: { length: len } }];
      if (len < Number(c.params.min)) return [{ url: p.url, title: `Meta description too short (${len} chars)`, description: p.metaDescription, recommendation: 'Expand with a concrete benefit and call to action.', evidence: { length: len } }];
      return [];
    },
  },
  {
    id: 'duplicate_meta_description',
    category: 'content',
    title: 'Duplicate meta descriptions',
    rationale: 'Unique descriptions help each page earn its own clicks.',
    scope: 'site',
    defaults: cfg('low'),
    check: (ctx) => duplicates(ctx, (p) => p.metaDescription).flatMap(([d, urls]) => urls.map((u) => ({ url: u, title: 'Duplicate meta description', description: `Shared by ${urls.length} pages.`, recommendation: 'Write a unique description per page.', evidence: { description: d, urls } }))),
  },
  {
    id: 'missing_h1',
    category: 'content',
    title: 'Missing H1',
    rationale: 'The H1 tells users and search engines what the page is about. Service pages should state the service (and location where relevant).',
    scope: 'page',
    defaults: cfg('medium'),
    check: (ctx, _c, p) => {
      if (!p || !isHtmlOk(p) || !p.indexable || p.h1s.length) return [];
      const important = ctx.importantPaths.has(pathOf(p.url));
      return [{ url: p.url, title: 'No H1 heading', description: p.h2s[0] ? `The first heading is an H2: "${p.h2s[0]}".` : 'No H1 found.', recommendation: 'Promote the main page heading to a single, descriptive H1.', evidence: { firstH2: p.h2s[0] ?? null }, severityOverride: important ? 'high' : undefined }];
    },
  },
  {
    id: 'multiple_h1',
    category: 'content',
    title: 'Multiple H1s',
    rationale: 'Not an error for Google, but one clear H1 keeps the page topic unambiguous.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && p.h1s.length > 1 ? [{ url: p.url, title: `${p.h1s.length} H1 headings`, description: p.h1s.join(' | '), recommendation: 'Keep one H1 and demote the rest to H2.', evidence: { h1s: p.h1s } }] : []),
  },
  {
    id: 'thin_content',
    category: 'content',
    title: 'Thin content',
    rationale: 'Pages with very little unique text rarely rank for competitive commercial queries.',
    scope: 'page',
    defaults: cfg('medium', { minWords: 400 }),
    check: (ctx, c, p) => {
      if (!p || !isHtmlOk(p) || !p.indexable || p.wordCount >= Number(c.params.minWords)) return [];
      const path = pathOf(p.url);
      if (/privacy|terms|cookie|contact|login|thank/i.test(path)) return [];
      return [{ url: p.url, title: `Thin content (${p.wordCount} words incl. navigation)`, description: 'The page has little text to demonstrate expertise or match search intent.', recommendation: 'Expand with process, deliverables, FAQs, use-cases and proof that is true and verifiable.', evidence: { wordCount: p.wordCount }, severityOverride: ctx.importantPaths.has(path) ? 'high' : undefined }];
    },
  },
  {
    id: 'duplicate_content',
    category: 'content',
    title: 'Duplicate content',
    rationale: 'Identical content on multiple URLs splits ranking signals.',
    scope: 'site',
    defaults: cfg('medium'),
    check: (ctx) => duplicates(ctx, (p) => p.contentHash).flatMap(([, urls]) => urls.map((u) => ({ url: u, title: 'Duplicate page content', description: `Same main content as: ${urls.filter((x) => x !== u).join(', ')}`, recommendation: 'Consolidate, differentiate, or canonicalise (approval required).', evidence: { urls } }))),
  },
  {
    id: 'images_missing_alt',
    category: 'content',
    title: 'Images missing alt text',
    rationale: 'Alt text improves accessibility and helps image search understand images.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => {
      if (!p || !isHtmlOk(p)) return [];
      const missing = p.images.filter((i) => !i.hasAlt && i.src);
      return missing.length ? [{ url: p.url, title: `${missing.length} image(s) without alt text`, description: missing.slice(0, 5).map((i) => i.src).join(', '), recommendation: 'Describe each meaningful image; use alt="" only for decorative images.', evidence: { images: missing.map((i) => i.src).slice(0, 50) }, severityOverride: missing.length >= 10 ? 'medium' : undefined }] : [];
    },
  },
  {
    id: 'encoding_errors',
    category: 'content',
    title: 'Character encoding errors visible on the page',
    rationale: 'Garbled characters (e.g. "â€”" instead of "—") look broken to visitors and can appear in search snippets.',
    scope: 'page',
    defaults: cfg('medium'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && p.signals.mojibakeCount > 0 ? [{ url: p.url, title: `${p.signals.mojibakeCount} garbled character sequence(s)`, description: 'Text contains double-encoded UTF-8 (e.g. "â€”").', recommendation: 'Re-save the HTML file as UTF-8 (without re-encoding) and serve Content-Type: text/html; charset=utf-8.', evidence: { count: p.signals.mojibakeCount } }] : []),
  },
  {
    id: 'missing_social_meta',
    category: 'content',
    title: 'Open Graph tags missing or incomplete',
    rationale: 'OG tags control how links look when shared on LinkedIn, WhatsApp and Facebook.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => {
      if (!p || !isHtmlOk(p) || !p.indexable) return [];
      const missing = ['og:title', 'og:description', 'og:image'].filter((k) => !p.openGraph[k]);
      const issues = [];
      if (missing.length) issues.push({ url: p.url, title: `Missing ${missing.join(', ')}`, description: '', recommendation: 'Add Open Graph title, description and an absolute image URL.', evidence: { missing }, key: 'missing' });
      if (p.signals.relativeOgImage) issues.push({ url: p.url, title: 'og:image uses a relative URL', description: `og:image="${p.openGraph['og:image']}"`, recommendation: 'Use an absolute https:// URL – social platforms cannot resolve relative paths.', evidence: { ogImage: p.openGraph['og:image'] }, key: 'relative' });
      return issues;
    },
  },
  {
    id: 'missing_lang',
    category: 'content',
    title: 'Missing html lang attribute',
    rationale: 'Declares the page language for accessibility and search engines.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && !p.signals.htmlLang ? [{ url: p.url, title: 'No <html lang>', description: '', recommendation: 'Add lang="en" (or the correct language) to <html>.', evidence: {} }] : []),
  },
  {
    id: 'heading_hierarchy',
    category: 'content',
    title: 'Heading levels skipped',
    rationale: 'A logical heading outline helps accessibility and content understanding.',
    scope: 'page',
    defaults: cfg('info'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && p.signals.headingOrderSkips > 0 ? [{ url: p.url, title: `Heading levels skipped ${p.signals.headingOrderSkips} time(s)`, description: '', recommendation: 'Use headings in order (H1 → H2 → H3).', evidence: {} }] : []),
  },
  {
    id: 'hotlinked_stock_images',
    category: 'content',
    title: 'Stock images hot-linked from third-party sites',
    rationale: 'Hot-linked stock photos load from another domain (slower, no control) and signal generic content.',
    scope: 'page',
    defaults: cfg('info'),
    check: (_ctx, _c, p) => (p && isHtmlOk(p) && p.signals.hotlinkedImages > 0 ? [{ url: p.url, title: `${p.signals.hotlinkedImages} hot-linked stock image(s)`, description: '', recommendation: 'Self-host optimised images (WebP/AVIF) and prefer original photos of real work/team.', evidence: {} }] : []),
  },
  {
    id: 'unverified_claims',
    category: 'content',
    title: 'Precise claims that need evidence',
    rationale: 'Statistics and superlatives without a source weaken trust (E-E-A-T) and must be verifiable.',
    scope: 'page',
    defaults: cfg('low'),
    check: (_ctx, _c, p) => {
      if (!p || !isHtmlOk(p)) return [];
      const claims = p.signals.claims ?? [];
      return claims.length ? [{ url: p.url, title: `${claims.length} claim(s) to verify`, description: claims.slice(0, 6).join(', '), recommendation: 'Keep only claims you can substantiate; add context or a case-study link for each.', evidence: { claims } }] : [];
    },
  },
];
