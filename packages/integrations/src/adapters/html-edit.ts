/**
 * Minimal, surgical HTML edits for static sites. We do NOT re-serialise the document
 * (which would reformat the whole file); each function changes only the targeted tag
 * and returns null when the edit cannot be made safely.
 */
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function setTitle(html: string, title: string): string | null {
  const re = /<title[^>]*>[\s\S]*?<\/title>/i;
  if (re.test(html)) return html.replace(re, `<title>${escapeText(title)}</title>`);
  return insertInHead(html, `<title>${escapeText(title)}</title>`);
}

export function setMetaName(html: string, name: string, content: string): string | null {
  const re = new RegExp(`<meta\\s+[^>]*name=["']${name}["'][^>]*>`, 'i');
  const tag = `<meta name="${name}" content="${escapeAttr(content)}">`;
  if (re.test(html)) return html.replace(re, tag);
  return insertInHead(html, tag);
}

export function setMetaProperty(html: string, property: string, content: string): string | null {
  const re = new RegExp(`<meta\\s+[^>]*property=["']${property}["'][^>]*>`, 'i');
  const tag = `<meta property="${property}" content="${escapeAttr(content)}">`;
  if (re.test(html)) return html.replace(re, tag);
  return insertInHead(html, tag);
}

export function setCanonical(html: string, href: string): string | null {
  const re = /<link\s+[^>]*rel=["']canonical["'][^>]*>/i;
  const tag = `<link rel="canonical" href="${escapeAttr(href)}">`;
  if (re.test(html)) return html.replace(re, tag);
  return insertInHead(html, tag);
}

/** Sets the H1 text. If there is no H1, promotes the first H2 (keeping its attributes and inner markup unless new text is given). */
export function setH1(html: string, text: string): string | null {
  const h1 = /<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/i;
  if (h1.test(html)) return html.replace(h1, (_m, attrs = '') => `<h1${attrs}>${escapeText(text)}</h1>`);
  const h2 = /<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/i;
  if (h2.test(html)) return html.replace(h2, (_m, attrs = '') => `<h1${attrs}>${escapeText(text)}</h1>`);
  return null;
}

/**
 * Replace JSON-LD: removes blocks matching `replaceWhere` (default: blocks that fail to parse
 * or contain the same @type) and inserts the new block(s) before </head>.
 */
export function replaceJsonLd(html: string, newBlocks: string, types: string[] = []): string | null {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>\s*/gi;
  const cleaned = html.replace(re, (block, body: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return ''; // invalid JSON-LD is always removed
    }
    const text = JSON.stringify(parsed);
    return types.some((t) => text.includes(`"@type":"${t}"`)) ? '' : block;
  });
  return insertInHead(cleaned, newBlocks.trim());
}

export function removeDuplicateMeta(html: string, name: string): string {
  let seen = false;
  return html.replace(new RegExp(`\\s*<meta\\s+[^>]*name=["']${name}["'][^>]*>`, 'gi'), (m) => {
    if (seen) return '';
    seen = true;
    return m;
  });
}

function insertInHead(html: string, fragment: string): string | null {
  const idx = html.search(/<\/head>/i);
  if (idx < 0) return null;
  return html.slice(0, idx) + fragment + '\n' + html.slice(idx);
}

/** Map a page path to a file in a static-site repository. */
export function candidateFilesForPath(pathname: string): string[] {
  const clean = decodeURIComponent(pathname).replace(/^\/+|\/+$/g, '');
  if (!clean) return ['index.html'];
  if (/\.html?$/.test(clean)) return [clean];
  return [`${clean}.html`, `${clean}/index.html`];
}
