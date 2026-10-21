import { extractHtml, fetchWithRedirects, type FetchResult } from '@phoenixx/crawler';
import { backlinkProviderFromConfig, type BacklinkProvider } from '@phoenixx/integrations';
import { domainOf, matchBacklink, parseBacklinkCsv, redirectForBrokenTarget, scorePriority, summarizeBacklinks, type ParsedBacklink, type SnapshotPage } from '@phoenixx/seo-engine';
import { AppError, normalizeUrl, sleep } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { latestCrawledPages, primaryWebsite } from './common.js';
import { raiseAlert } from './alerts.js';
import { assertPublicHost } from './net-guard.js';
import { fingerprint, upsertRecommendation } from './recommendations.js';

/**
 * Backlink monitor. Backlinks come from a CSV export (Search Console → Links → Export, or any
 * SEO tool) or from DataForSEO when configured. The agent then:
 *  1. checks every linking page live and records whether the link is still there (anchor, nofollow),
 *  2. checks the linked page on OUR site – links to 404s get a 301 recommendation (admin approval),
 *  3. alerts when links disappear.
 * It never contacts other sites, requests links or submits to directories.
 */

type BacklinkOrigin = 'import' | 'dataforseo' | 'manual' | 'demo';

export async function upsertBacklinks(ctx: AppContext, projectId: string, rows: (Omit<ParsedBacklink, 'sourceDomain'> & { lost?: boolean })[], origin: BacklinkOrigin) {
  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    const row = await ctx.db.one<{ inserted: boolean }>(
      `INSERT INTO backlinks(project_id, source_url, source_domain, target_url, anchor, nofollow, origin, first_seen_at, last_seen_at, status, lost_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()), COALESCE($9::timestamptz, now()), CASE WHEN $10 THEN 'lost' ELSE 'unverified' END, CASE WHEN $10 THEN now() END)
       ON CONFLICT (project_id, source_url, target_url) DO UPDATE SET
         anchor = COALESCE(EXCLUDED.anchor, backlinks.anchor),
         nofollow = COALESCE(EXCLUDED.nofollow, backlinks.nofollow),
         first_seen_at = LEAST(backlinks.first_seen_at, EXCLUDED.first_seen_at),
         last_seen_at = GREATEST(backlinks.last_seen_at, EXCLUDED.last_seen_at)
       RETURNING (xmax = 0) AS inserted`,
      [projectId, r.sourceUrl, domainOf(r.sourceUrl), r.targetUrl, r.anchor, r.nofollow, origin, r.firstSeen, r.lastSeen, !!r.lost],
    );
    if (row?.inserted) inserted++;
    else updated++;
  }
  return { inserted, updated };
}

/** CSV import (Search Console "Links" export, Ahrefs/Semrush/Moz/Majestic exports, or a plain URL list). */
export async function importBacklinks(ctx: AppContext, projectId: string, csv: string) {
  const site = await primaryWebsite(ctx, projectId);
  const parsed = parseBacklinkCsv(csv, site.base_url);
  if (!parsed.rows.length) throw new AppError(parsed.skipped[0]?.reason ?? 'No backlinks found in the file', 400, 'validation', { skipped: parsed.skipped.slice(0, 20) });
  const res = await upsertBacklinks(ctx, projectId, parsed.rows, 'import');
  return { ...res, rows: parsed.rows.length, skipped: parsed.skipped.length, skippedSample: parsed.skipped.slice(0, 20), columns: parsed.columns };
}

/** Pull backlinks from the configured provider (none configured → no-op with an explanation). */
export async function syncBacklinks(ctx: AppContext, projectId: string, input: { limit?: number } = {}, provider: BacklinkProvider | null = backlinkProviderFromConfig(ctx.cfg)) {
  if (!provider) return { provider: 'none', skipped: true, message: 'No backlink provider configured (BACKLINK_PROVIDER). Import a CSV from Search Console → Links instead; verification still runs on imported links.' };
  const site = await primaryWebsite(ctx, projectId);
  const links = await provider.fetchBacklinks(domainOf(site.base_url), { limit: input.limit ?? 1000 });
  const rows = links
    .map((l) => ({ ...l, sourceUrl: normalizeUrl(l.sourceUrl), targetUrl: normalizeUrl(l.targetUrl) ?? '' }))
    .filter((l): l is typeof l & { sourceUrl: string } => !!l.sourceUrl);
  const res = await upsertBacklinks(ctx, projectId, rows, provider.name as BacklinkOrigin);
  return { provider: provider.name, fetched: links.length, ...res };
}

/* ───────────────────────── Live verification ───────────────────────── */

/** fetch that re-checks the host on every redirect hop. */
async function safeFetch(ctx: AppContext, url: string, opts: { readBody: boolean }): Promise<FetchResult> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    try {
      await assertPublicHost(current, ctx.cfg.BACKLINK_ALLOW_PRIVATE_HOSTS);
    } catch (e) {
      return { url, finalUrl: current, status: null, headers: {}, body: null, redirectChain: [], redirectLoop: false, timeMs: 0, error: (e as Error).message };
    }
    const r = await fetchWithRedirects(current, { userAgent: ctx.cfg.CRAWL_USER_AGENT, timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS, maxRedirects: 0, maxBytes: 3_000_000, readBody: opts.readBody });
    const next = r.redirectChain[0]?.location;
    if (!next || !r.error?.startsWith('Too many redirects')) return { ...r, url, finalUrl: current };
    current = next;
  }
  return { url, finalUrl: current, status: null, headers: {}, body: null, redirectChain: [], redirectLoop: false, timeMs: 0, error: 'Too many redirects' };
}

interface BacklinkDbRow {
  id: string;
  source_url: string;
  source_domain: string;
  target_url: string;
  status: string;
}

/**
 * Checks the oldest-checked backlinks (up to `limit`): each linking page is fetched once
 * (one request per linking site at a time, with a delay), each linked page on our site once.
 */
export async function verifyBacklinks(ctx: AppContext, projectId: string, input: { limit?: number } = {}) {
  const site = await primaryWebsite(ctx, projectId);
  const siteUrl = site.base_url;
  const limit = input.limit ?? ctx.cfg.BACKLINK_VERIFY_LIMIT;
  const rows = await ctx.db.query<BacklinkDbRow>(`SELECT id, source_url, source_domain, target_url, status FROM backlinks WHERE project_id = $1 AND origin <> 'demo' ORDER BY last_checked_at NULLS FIRST, created_at LIMIT $2`, [projectId, limit]);

  // Our own pages: status + where they redirect to (a link to /old that 301s to /new still counts).
  const targetCache = new Map<string, Promise<{ status: number | null; finalUrl: string }>>();
  const checkTarget = (url: string) => {
    if (!targetCache.has(url)) {
      targetCache.set(
        url,
        fetchWithRedirects(url, { userAgent: ctx.cfg.CRAWL_USER_AGENT, timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS, readBody: false }).then((r) => ({ status: r.status, finalUrl: normalizeUrl(r.finalUrl) ?? r.finalUrl })),
      );
    }
    return targetCache.get(url)!;
  };

  const bySource = new Map<string, BacklinkDbRow[]>();
  for (const r of rows) bySource.set(r.source_url, [...(bySource.get(r.source_url) ?? []), r]);
  const byDomain = new Map<string, string[]>();
  for (const [src, list] of bySource) byDomain.set(list[0]!.source_domain, [...(byDomain.get(list[0]!.source_domain) ?? []), src]);

  const stats = { checked: 0, sources: bySource.size, live: 0, lost: 0, errors: 0, newlyLost: [] as { domain: string; source: string; target: string }[] };
  const perDomainDelay = ctx.cfg.CRAWL_DELAY_MS * 4;

  const checkSource = async (sourceUrl: string) => {
    const page = await safeFetch(ctx, sourceUrl, { readBody: true });
    const html = page.status === 200 && page.body && /html/i.test(page.headers['content-type'] ?? 'text/html');
    const links = html ? [...extractHtml(page.body!, page.finalUrl, siteUrl).internalLinks] : [];
    for (const row of bySource.get(sourceUrl)!) {
      stats.checked++;
      if (!html && !(page.status === 404 || page.status === 410)) {
        // Network error, 5xx, blocked, non-HTML: don't declare the link lost on a transient failure.
        stats.errors++;
        await ctx.db.query(`UPDATE backlinks SET last_checked_at = now(), check_error = $2, status = CASE WHEN status = 'unverified' THEN 'error' ELSE status END WHERE id = $1`, [row.id, page.error ?? `HTTP ${page.status ?? '—'}${page.status === 200 ? ' (not HTML)' : ''}`]);
        continue;
      }
      let aliases: string[] = [];
      if (row.target_url) aliases = [(await checkTarget(row.target_url)).finalUrl];
      const hit = html ? matchBacklink(links, siteUrl, row.target_url, aliases) : null;
      const target = row.target_url || hit?.href || null;
      const t = target ? await checkTarget(target) : null;
      if (hit) {
        stats.live++;
        await ctx.db.query(
          `UPDATE backlinks SET status = 'live', last_checked_at = now(), last_seen_at = now(), check_error = NULL, lost_at = NULL, found_anchor = $2, found_nofollow = $3, target_status = $4, target_final_url = $5 WHERE id = $1`,
          [row.id, hit.anchor || null, hit.nofollow, t?.status ?? null, t?.finalUrl ?? hit.href],
        );
      } else {
        stats.lost++;
        if (row.status === 'live') stats.newlyLost.push({ domain: row.source_domain, source: row.source_url, target: row.target_url });
        await ctx.db.query(`UPDATE backlinks SET status = 'lost', last_checked_at = now(), check_error = $2, lost_at = COALESCE(lost_at, now()), target_status = $3, target_final_url = $4 WHERE id = $1`, [row.id, page.status === 200 ? null : `Linking page returned HTTP ${page.status}`, t?.status ?? null, t?.finalUrl ?? null]);
      }
    }
  };

  const queue = [...byDomain.values()];
  const worker = async () => {
    for (let sources = queue.shift(); sources; sources = queue.shift()) {
      for (const [i, s] of sources.entries()) {
        if (i && perDomainDelay) await sleep(perDomainDelay);
        await checkSource(s).catch((e) => ctx.log.warn('backlinks.check_failed', { source: s, error: (e as Error).message }));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));

  if (stats.newlyLost.length) {
    const domains = [...new Set(stats.newlyLost.map((l) => l.domain))];
    await raiseAlert(ctx, projectId, {
      severity: domains.length >= 5 ? 'high' : 'medium',
      type: 'backlinks_lost',
      title: `${stats.newlyLost.length} backlink(s) lost from ${domains.length} site(s)`,
      message: `Links that were live are no longer on: ${domains.slice(0, 8).join(', ')}${domains.length > 8 ? ` and ${domains.length - 8} more` : ''}. Review them in Backlinks; if a link was removed by mistake, the site owner can be contacted manually.`,
      evidence: { lost: stats.newlyLost.slice(0, 50) },
      fingerprint: `backlinks:lost:${projectId}`,
    });
  }
  const broken = await recommendBrokenTargets(ctx, projectId);
  return { checked: stats.checked, sources: stats.sources, live: stats.live, lost: stats.lost, newlyLost: stats.newlyLost.length, errors: stats.errors, brokenTargets: broken.targets, recommendations: broken.created };
}

/**
 * Links pointing at pages that are broken on our site waste their value. For each broken target,
 * propose a single-hop 301 to the most similar live page (high risk → admin approval, never auto-applied).
 */
export async function recommendBrokenTargets(ctx: AppContext, projectId: string) {
  const site = await primaryWebsite(ctx, projectId);
  const broken = await ctx.db.query<{ target: string; status: number; links: number; domains: number; top_domains: string[]; anchors: (string | null)[] }>(
    `SELECT COALESCE(NULLIF(target_url, ''), target_final_url) AS target, MAX(target_status)::int AS status, COUNT(*)::int AS links, COUNT(DISTINCT source_domain)::int AS domains,
            (ARRAY_AGG(DISTINCT source_domain))[1:5] AS top_domains, ARRAY_AGG(DISTINCT COALESCE(found_anchor, anchor)) AS anchors
     FROM backlinks WHERE project_id = $1 AND status IN ('live','unverified') AND target_status >= 400 AND COALESCE(NULLIF(target_url, ''), target_final_url) IS NOT NULL
     GROUP BY 1`,
    [projectId],
  );
  if (!broken.length) return { targets: 0, created: 0 };
  const { pages } = await latestCrawledPages(ctx, projectId);
  const candidates: SnapshotPage[] = pages
    .filter((p) => p.statusCode === 200 && p.indexable && !p.redirectChain.length)
    .map((p) => ({ path: new URL(p.url).pathname, url: p.url, statusCode: 200, title: p.title, metaDescription: p.metaDescription, h1: p.h1s[0] ?? null, canonical: p.canonical, indexable: p.indexable, inlinks: 0, clicks: 0, impressions: 0 }));
  let created = 0;
  for (const b of broken) {
    const from = new URL(b.target).pathname;
    const r = redirectForBrokenTarget(b.target, candidates, b.anchors);
    const res = await upsertRecommendation(ctx, {
      projectId,
      source: 'backlinks',
      type: 'redirect',
      pageUrl: new URL(from, site.base_url).toString(),
      title: `Recover backlinks: 301 ${from} → ${r.to}`,
      what: `Add a single-hop 301 redirect from ${from} to ${r.to}. ${b.links} backlink(s) from ${b.domains} site(s) point at ${from}, which returns HTTP ${b.status}.`,
      why: `Links to a broken page pass no value and send visitors to an error. A redirect to the closest matching live page (${r.basis}) recovers them without contacting anyone.`,
      evidence: [
        { label: 'Target status', value: b.status },
        { label: 'Backlinks', value: b.links },
        { label: 'Referring domains', value: b.domains },
        { label: 'Linking sites', value: b.top_domains.join(', ') },
        { label: 'Match confidence', value: r.confidence },
      ],
      currentValue: from,
      proposedValue: `Redirect 301 ${from} ${r.to}`,
      expectedPurpose: 'Recover the value of existing backlinks that point at a broken URL.',
      risk: 'high',
      confidence: r.confidence >= 0.5 ? 'medium' : 'low',
      priority: scorePriority({ impact: Math.min(5, 3 + b.domains * 0.5), effort: 1, severity: b.domains >= 3 ? 'high' : 'medium', businessRelevance: 4, confidence: Math.max(0.3, r.confidence), notes: [`${b.domains} referring domain(s)`] }),
      fingerprint: fingerprint('backlink-redirect', projectId, from),
      queueForApproval: true,
    });
    if (res.created) created++;
  }
  return { targets: broken.length, created };
}

/* ───────────────────────── Dashboard data ───────────────────────── */

export async function backlinkOverview(ctx: AppContext, projectId: string) {
  const rows = await ctx.db.query<any>(
    `SELECT id, source_url, source_domain, target_url, anchor, nofollow, origin, status, first_seen_at, last_seen_at, last_checked_at, check_error, found_anchor, found_nofollow, lost_at, target_status, target_final_url
     FROM backlinks WHERE project_id = $1 ORDER BY CASE status WHEN 'lost' THEN 0 WHEN 'error' THEN 1 WHEN 'unverified' THEN 2 ELSE 3 END, source_domain, source_url LIMIT 2000`,
    [projectId],
  );
  const domains = await ctx.db.query(
    `SELECT source_domain AS domain, COUNT(*)::int AS links, COUNT(*) FILTER (WHERE status = 'live')::int AS live, COUNT(*) FILTER (WHERE status = 'lost')::int AS lost,
            COUNT(*) FILTER (WHERE COALESCE(found_nofollow, nofollow) IS NOT TRUE AND status = 'live')::int AS followed, MIN(first_seen_at) AS first_seen_at
     FROM backlinks WHERE project_id = $1 GROUP BY source_domain ORDER BY live DESC, links DESC LIMIT 500`,
    [projectId],
  );
  const brokenTargets = await ctx.db.query(
    `SELECT COALESCE(NULLIF(target_url, ''), target_final_url) AS target, MAX(target_status)::int AS status, COUNT(*)::int AS links, COUNT(DISTINCT source_domain)::int AS domains
     FROM backlinks WHERE project_id = $1 AND status IN ('live','unverified') AND target_status >= 400 GROUP BY 1 ORDER BY domains DESC`,
    [projectId],
  );
  const lastRun = await ctx.db.one(`SELECT job_type, status, finished_at, output FROM job_runs WHERE project_id = $1 AND job_type = 'backlinks-verify' ORDER BY created_at DESC LIMIT 1`, [projectId]);
  return {
    summary: summarizeBacklinks(rows),
    provider: { name: ctx.cfg.BACKLINK_PROVIDER, configured: ctx.cfg.BACKLINK_PROVIDER !== 'none' },
    domains,
    backlinks: rows,
    brokenTargets,
    lastVerify: lastRun,
    note: 'Links are monitored, not built: the agent never contacts sites, buys links or submits to directories.',
  };
}
