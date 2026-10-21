import { extractHtml, fetchWithRedirects } from '@phoenixx/crawler';
import { sleep } from '@phoenixx/shared';
import type { AppContext } from '../context.js';

/**
 * Verification engine: what a page looks like to a crawler, and whether a deployment produced
 * exactly the intended change – the target field must equal the new value and every other SEO
 * field must be unchanged. Used after deployments, rollbacks and for live previews.
 */
export interface PageFields {
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  h1Count: number;
  h2: string;
  canonical: string | null;
  robots: string | null;
  indexable: boolean;
  schemaTypes: string;
  schemaValid: boolean;
  ogTitle: string | null;
  ogImage: string | null;
  internalLinks: number;
  wordCount: number;
  images: number;
  imagesMissingAlt: number;
}

export interface FieldCheck {
  field: string;
  kind: 'changed' | 'unchanged' | 'http';
  expected: string | number | boolean | null;
  actual: string | number | boolean | null;
  passed: boolean;
}

export function fieldsFromHtml(html: string, pageUrl: string, siteUrl: string): PageFields {
  const x = extractHtml(html, pageUrl, siteUrl);
  const robots = x.robotsMeta?.toLowerCase() ?? null;
  return {
    title: x.title,
    metaDescription: x.metaDescription,
    h1: x.h1s[0] ?? null,
    h1Count: x.h1s.length,
    h2: x.h2s.join(' | '),
    canonical: x.canonical,
    robots,
    indexable: !robots?.includes('noindex'),
    schemaTypes: [...new Set(x.structuredData.filter((s) => s.valid).flatMap((s) => s.types))].sort().join(','),
    schemaValid: x.structuredData.every((s) => s.valid),
    ogTitle: x.openGraph['og:title'] ?? null,
    ogImage: x.openGraph['og:image'] ?? null,
    internalLinks: new Set(x.internalLinks.map((l) => l.href)).size,
    wordCount: x.wordCount,
    images: x.images.length,
    imagesMissingAlt: x.images.filter((i) => !i.hasAlt).length,
  };
}

/** Change type → the field it is expected to change. */
export const FIELD_FOR_CHANGE: Record<string, keyof PageFields> = { title: 'title', meta_description: 'metaDescription', h1: 'h1', canonical: 'canonical', schema: 'schemaTypes', og_image: 'ogImage', other: 'ogImage' };

const norm = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().toLowerCase() : v);

export function expectedFieldValue(changeType: string, value: string, siteUrl: string): string | null {
  if (changeType === 'schema') {
    const skip = new Set(['PostalAddress', 'GeoCoordinates', 'ContactPoint', 'ListItem', 'Question', 'Answer', 'Place', 'City', 'State', 'Country', 'ImageObject', 'Person']);
    return [...new Set([...value.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!))].filter((t) => !skip.has(t)).sort().join(',');
  }
  if (changeType === 'canonical') {
    try {
      return new URL(value, siteUrl).toString().replace(/\/$/, '');
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * Expected vs actual. `before` = the page before the change (fields that must stay the same).
 * Word count may drift slightly (e.g. an H1 adds words), so it gets a tolerance.
 */
export function compareFields(changeType: string, expectedValue: string | null, before: PageFields | null, after: PageFields, siteUrl: string): FieldCheck[] {
  const target = FIELD_FOR_CHANGE[changeType];
  const checks: FieldCheck[] = [];
  if (target && expectedValue !== null) {
    const exp = expectedFieldValue(changeType, expectedValue, siteUrl);
    const act = after[target];
    let passed: boolean;
    if (changeType === 'schema') passed = !!exp && exp.split(',').every((t) => String(act).split(',').includes(t)) && after.schemaValid;
    else if (changeType === 'canonical') passed = String(act ?? '').replace(/\/$/, '') === exp;
    else passed = norm(act) === norm(exp);
    checks.push({ field: target, kind: 'changed', expected: exp, actual: act as string | null, passed });
  }
  if (before) {
    const same: (keyof PageFields)[] = ['title', 'metaDescription', 'h1', 'h2', 'canonical', 'robots', 'indexable', 'schemaTypes', 'ogTitle', 'ogImage', 'internalLinks', 'images', 'imagesMissingAlt'];
    for (const f of same) {
      if (f === target || (changeType === 'schema' && f === 'schemaTypes')) continue;
      if (changeType === 'h1' && f === 'h1') continue;
      if (changeType === 'h1' && f === 'h2' && before.h1Count === 0 && before.h2) {
        // A page without an H1 gets its first H2 promoted – exactly that heading may leave the H2 list.
        const expected = before.h2.split(' | ').slice(1).join(' | ');
        checks.push({ field: 'h2', kind: 'unchanged', expected, actual: after.h2, passed: norm(expected) === norm(after.h2) || norm(before.h2) === norm(after.h2) });
        continue;
      }
      checks.push({ field: f, kind: 'unchanged', expected: before[f], actual: after[f], passed: norm(before[f]) === norm(after[f]) });
    }
    const tolerance = Math.max(25, Math.round(before.wordCount * 0.05));
    checks.push({ field: 'wordCount', kind: 'unchanged', expected: before.wordCount, actual: after.wordCount, passed: Math.abs(after.wordCount - before.wordCount) <= tolerance });
  }
  return checks;
}

/**
 * Fetch `fetchUrl` but judge links/canonicals as if the HTML were served at `pageUrl` (the real page
 * address) – they differ when verifying through a staging/demo host.
 */
export async function fetchPageFields(ctx: AppContext, fetchUrl: string, pageUrl: string, siteUrl: string): Promise<{ status: number | null; fields: PageFields | null; html: string | null; error: string | null }> {
  const r = await fetchWithRedirects(fetchUrl, { userAgent: ctx.cfg.CRAWL_USER_AGENT, timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS, maxBytes: 5 * 1024 * 1024 });
  if (!r.body || (r.status ?? 0) >= 400) return { status: r.status, fields: null, html: null, error: r.error ?? `HTTP ${r.status}` };
  return { status: r.status, fields: fieldsFromHtml(r.body, pageUrl, siteUrl), html: r.body, error: null };
}

/** Re-crawl the page until the expected state appears (caches) or retries run out. */
export async function verifyLivePage(
  ctx: AppContext,
  input: { fetchUrl: string; pageUrl: string; siteUrl: string; changeType: string; expectedValue: string | null; before: PageFields | null },
  opts: { retries?: number; delayMs?: number } = {},
): Promise<{ httpStatus: number | null; passed: boolean; checks: FieldCheck[]; error: string | null; attempts: number; after: PageFields | null; html: string | null }> {
  const retries = opts.retries ?? ctx.cfg.DEPLOY_VERIFY_RETRIES;
  const delay = opts.delayMs ?? ctx.cfg.DEPLOY_VERIFY_DELAY_MS;
  let last: Awaited<ReturnType<typeof fetchPageFields>> | null = null;
  let checks: FieldCheck[] = [];
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    // Cache-buster: ignored by static hosting, bypasses most CDN/page caches.
    const bust = `${input.fetchUrl}${input.fetchUrl.includes('?') ? '&' : '?'}seo-agent-verify=${Date.now()}`;
    last = await fetchPageFields(ctx, bust, input.pageUrl, input.siteUrl);
    const http: FieldCheck = { field: 'httpStatus', kind: 'http', expected: 200, actual: last.status, passed: last.status === 200 };
    checks = [http, ...(last.fields ? compareFields(input.changeType, input.expectedValue, input.before, last.fields, input.siteUrl) : [])];
    if (checks.every((c) => c.passed)) return { httpStatus: last.status, passed: true, checks, error: null, attempts: attempt, after: last.fields, html: last.html };
    if (attempt <= retries && delay) await sleep(delay);
  }
  const failed = checks.filter((c) => !c.passed).map((c) => c.field);
  return { httpStatus: last?.status ?? null, passed: false, checks, error: last?.error ?? `Mismatch in: ${failed.join(', ')}`, attempts: retries + 1, after: last?.fields ?? null, html: last?.html ?? null };
}
