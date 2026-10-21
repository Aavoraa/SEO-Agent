import { createHash, randomUUID } from 'node:crypto';

export const newId = (): string => randomUUID();

export const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Normalise a URL for identity comparison: lowercase host, strip hash, default ports, and a trailing slash on non-root paths. */
export function normalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = base ? new URL(input, base) : new URL(input);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  // Sort query params for stable identity.
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  u.search = params.length ? '?' + new URLSearchParams(params).toString() : '';
  return u.toString();
}

export function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Host equality that treats www. and bare domain as the same site. */
export function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, '');
    const hb = new URL(b).hostname.replace(/^www\./, '');
    return ha === hb;
  } catch {
    return false;
  }
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function pctChange(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return round(((current - previous) / previous) * 100, 1);
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(date: Date | string, days: number): Date {
  const d = typeof date === 'string' ? new Date(date + (date.length === 10 ? 'T00:00:00Z' : '')) : new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** Simple english tokenizer with stopword removal – used by clustering, similarity and quality checks. */
export const STOPWORDS = new Set(
  'a an the and or but of in on at to for with by from as is are was were be been being it its this that these those your you we our us they their i me my he she his her them what which who whom how why when where do does did can could should would will shall may might must not no yes than then so if into over under about up down out off near best top vs versus'.split(
    ' ',
  ),
);

export function tokenize(text: string, { keepStopwords = false } = {}): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length > 1 && (keepStopwords || !STOPWORDS.has(t)));
}

/** Very small plural stemmer – good enough for keyword grouping ("companies" → "company"). */
export function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && token.endsWith('es') && /(ss|x|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size && !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function groupBy<T, K extends string | number>(arr: T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of arr) (out[key(item)] ??= []).push(item);
  return out;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
