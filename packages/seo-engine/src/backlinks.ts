import { normalizeUrl, round, sameSite, stem, tokenize, type LinkRef } from '@phoenixx/shared';
import type { SnapshotPage } from './migration.js';

/**
 * Backlink monitoring helpers (pure functions – no I/O).
 *
 * The agent treats backlinks as something to MONITOR and PROTECT, never to manufacture:
 * it verifies that known links still exist, spots links pointing at broken pages on our
 * site (→ 301 recommendation for admin approval) and flags lost links. It never buys,
 * requests or auto-submits links – those are link schemes under Google's spam policies.
 */

export interface ParsedBacklink {
  sourceUrl: string;
  sourceDomain: string;
  /** '' when the export only lists linking pages (GSC "Latest links"). */
  targetUrl: string;
  anchor: string | null;
  nofollow: boolean | null;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface CsvParseResult {
  rows: ParsedBacklink[];
  skipped: { line: number; reason: string }[];
  columns: { source: string | null; target: string | null; anchor: string | null; nofollow: string | null };
}

/** RFC 4180-ish CSV/TSV parser (quoted fields, escaped quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delim = (firstLine.match(/\t/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === delim) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

// Header names used by Search Console, Ahrefs, Semrush, Moz, Majestic and DataForSEO exports.
const SOURCE_COLS = /^(linking page|source url|source|referring page( url)?|url from|from url|backlink|backlink url|link url|url)$/i;
const TARGET_COLS = /^(target page|target url|target|url to|to url|linked page|destination( url)?)$/i;
const ANCHOR_COLS = /^(anchor( text)?|link text)$/i;
const NOFOLLOW_COLS = /^(nofollow|no ?follow|dofollow|link type|rel|follow)$/i;
const FIRST_COLS = /^(first seen|first indexed)$/i;
const LAST_COLS = /^(last seen|last crawled|last checked)$/i;

function parseNofollow(header: string, v: string): boolean | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (/^dofollow$|^follow$/i.test(header)) return ['false', '0', 'no', 'nofollow'].includes(s);
  if (/nofollow|ugc|sponsored/.test(s)) return true;
  if (['true', '1', 'yes'].includes(s)) return /nofollow|no ?follow/i.test(header);
  if (['false', '0', 'no', 'dofollow', 'follow'].includes(s)) return false;
  return null;
}

function toDate(v: string | undefined): string | null {
  if (!v?.trim()) return null;
  const d = new Date(v.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Parses a backlink export. Accepts any CSV/TSV with a "linking page"-style column (plus optional
 * target/anchor/nofollow/date columns) or a bare list of URLs, one per line. Rows whose source is
 * on our own site, or whose target is on another site, are skipped with a reason.
 */
export function parseBacklinkCsv(text: string, siteUrl: string): CsvParseResult {
  const table = parseCsv(text);
  const result: CsvParseResult = { rows: [], skipped: [], columns: { source: null, target: null, anchor: null, nofollow: null } };
  if (!table.length) return result;
  const header = table[0]!.map((h) => h.trim());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h.replace(/[_-]+/g, ' ')));
  let src = find(SOURCE_COLS);
  const tgt = find(TARGET_COLS);
  const anc = find(ANCHOR_COLS);
  const nof = find(NOFOLLOW_COLS);
  const first = find(FIRST_COLS);
  const last = find(LAST_COLS);
  let start = 1;
  if (src === -1) {
    // No recognised header: a bare URL list, or a header-less export whose first column is a URL.
    if (!/^https?:\/\//i.test(header[0] ?? '')) {
      result.skipped.push({ line: 1, reason: `No linking-page column found (headers: ${header.join(', ') || 'none'})` });
      return result;
    }
    src = 0;
    start = 0;
  }
  result.columns = { source: start ? header[src]! : null, target: tgt >= 0 ? header[tgt]! : null, anchor: anc >= 0 ? header[anc]! : null, nofollow: nof >= 0 ? header[nof]! : null };
  const seen = new Set<string>();
  for (let i = start; i < table.length; i++) {
    const r = table[i]!;
    const line = i + 1;
    const sourceUrl = normalizeUrl((r[src] ?? '').trim());
    if (!sourceUrl) {
      result.skipped.push({ line, reason: 'Invalid linking page URL' });
      continue;
    }
    if (sameSite(sourceUrl, siteUrl)) {
      result.skipped.push({ line, reason: 'Linking page is on our own site (internal link)' });
      continue;
    }
    let targetUrl = '';
    if (tgt >= 0 && (r[tgt] ?? '').trim()) {
      const t = normalizeUrl((r[tgt] ?? '').trim(), siteUrl);
      if (!t || !sameSite(t, siteUrl)) {
        result.skipped.push({ line, reason: 'Target is not on this site' });
        continue;
      }
      targetUrl = t;
    }
    const key = `${sourceUrl}|${targetUrl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.rows.push({
      sourceUrl,
      sourceDomain: domainOf(sourceUrl),
      targetUrl,
      anchor: anc >= 0 ? (r[anc] ?? '').trim() || null : null,
      nofollow: nof >= 0 ? parseNofollow(header[nof]!, r[nof] ?? '') : null,
      firstSeen: first >= 0 ? toDate(r[first]) : null,
      lastSeen: last >= 0 ? toDate(r[last]) : null,
    });
  }
  return result;
}

const pathKey = (url: string) => {
  try {
    const u = new URL(url);
    return (u.pathname.replace(/\/+$/, '') || '/') + u.search;
  } catch {
    return url;
  }
};

/**
 * Links on a fetched source page that point at our site. `links` are the page's links as
 * extracted with our site as the reference (so links to us are the "internal" ones).
 * With a target, only links to that URL count (www/non-www and http/https are treated as equal,
 * as are URLs that redirect to the target).
 */
export function matchBacklink(links: LinkRef[], siteUrl: string, targetUrl: string, targetAliases: string[] = []): LinkRef | null {
  const toUs = links.filter((l) => sameSite(l.href, siteUrl));
  if (!targetUrl) return toUs.find((l) => !l.nofollow) ?? toUs[0] ?? null;
  const wanted = new Set([targetUrl, ...targetAliases].map(pathKey));
  const hits = toUs.filter((l) => wanted.has(pathKey(l.href)));
  return hits.find((l) => !l.nofollow) ?? hits[0] ?? null;
}

const URL_NOISE = new Set(['html', 'htm', 'php', 'aspx', 'asp', 'index', 'page', 'amp']);
const words = (s: string | null | undefined) => tokenize((s ?? '').replace(/[/_.-]+/g, ' ')).map(stem);
// "web" ~ "website", "develop" ~ "development": a shared prefix of 3+ letters counts as a match.
const covers = (have: Set<string>, w: string) => have.has(w) || [...have].some((h) => h.length >= 3 && w.length >= 3 && (h.startsWith(w) || w.startsWith(h)));

/**
 * For a link target that no longer works on our site, pick the best live page to 301 to.
 * The broken page's title is gone, so its URL words plus the anchor texts of the links pointing
 * at it describe it; the live page covering most of those words wins. Words found on nearly
 * every page (brand, city) are ignored. Falls back to the home page with low confidence so the
 * reviewer sees it's a guess.
 */
export function redirectForBrokenTarget(target: string, livePages: SnapshotPage[], anchors: (string | null)[] = []): { to: string; confidence: number; basis: string } {
  const path = pathKey(target);
  const candidates = livePages.filter((p) => p.statusCode === 200 && p.path !== path);
  const pageWords = candidates.map((p) => new Set([...words(p.path), ...words(p.title), ...words(p.h1)]));
  const common = new Set([...new Set(pageWords.flatMap((s) => [...s]))].filter((w) => pageWords.filter((s) => s.has(w)).length >= Math.max(2, candidates.length * 0.6)));
  const wanted = [...new Set([...words(path), ...anchors.flatMap(words)])].filter((w) => !URL_NOISE.has(w) && !common.has(w));
  let best: { to: string; confidence: number; basis: string } | null = null;
  for (const [i, c] of wanted.length ? candidates.entries() : []) {
    const hit = wanted.filter((w) => covers(pageWords[i]!, w));
    const score = round(hit.length / wanted.length, 2);
    if (score > (best?.confidence ?? 0)) best = { to: c.path, confidence: score, basis: `matches ${hit.join(', ')} (${hit.length}/${wanted.length} words from the old URL and link anchors)` };
  }
  return best && best.confidence >= 0.34 ? best : { to: '/', confidence: 0.1, basis: 'no similar page found – home page fallback' };
}

export interface BacklinkRow {
  source_domain: string;
  status: string;
  nofollow: boolean | null;
  found_nofollow: boolean | null;
}

export function summarizeBacklinks(rows: BacklinkRow[]) {
  const domains = new Map<string, { live: number; total: number }>();
  let live = 0;
  let lost = 0;
  let unverified = 0;
  let nofollow = 0;
  for (const r of rows) {
    const d = domains.get(r.source_domain) ?? { live: 0, total: 0 };
    d.total++;
    if (r.status === 'live') {
      live++;
      d.live++;
    } else if (r.status === 'lost') lost++;
    else unverified++;
    if ((r.found_nofollow ?? r.nofollow) === true) nofollow++;
    domains.set(r.source_domain, d);
  }
  return {
    backlinks: rows.length,
    referringDomains: domains.size,
    liveReferringDomains: [...domains.values()].filter((d) => d.live > 0).length,
    live,
    lost,
    unverified,
    nofollow,
  };
}
