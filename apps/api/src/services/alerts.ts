import { dispatch } from '@phoenixx/integrations';
import { detectDrop, comparePeriods, dailySeries, type GscRow } from '@phoenixx/keyword-engine';
import { fetchWithRedirects } from '@phoenixx/crawler';
import { addDays, isoDate, SEVERITY_RANK, type Severity } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestGscDate, primaryWebsite } from './common.js';

export interface AlertInput {
  severity: Severity;
  type: string;
  title: string;
  message: string;
  evidence?: Record<string, unknown>;
  fingerprint: string;
}

/** Creates or bumps an alert (deduplicated by fingerprint while unresolved). */
export async function raiseAlert(ctx: AppContext, projectId: string, a: AlertInput): Promise<{ id: string; isNew: boolean }> {
  const existing = await ctx.db.one<{ id: string }>(`SELECT id FROM alerts WHERE project_id = $1 AND fingerprint = $2 AND status <> 'resolved'`, [projectId, a.fingerprint]);
  if (existing) {
    await ctx.db.query(`UPDATE alerts SET occurrences = occurrences + 1, last_seen_at = now(), message = $2, evidence = $3, severity = $4 WHERE id = $1`, [existing.id, a.message, a.evidence ?? {}, a.severity]);
    return { id: existing.id, isNew: false };
  }
  const row = await ctx.db.one<{ id: string }>(`INSERT INTO alerts(project_id, severity, type, title, message, evidence, fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [projectId, a.severity, a.type, a.title, a.message, a.evidence ?? {}, a.fingerprint]);
  const { emitEvent } = await import('./events.js');
  const payload = { alertId: row!.id, severity: a.severity, type: a.type, title: a.title };
  await emitEvent(ctx, projectId, 'alert.created', payload);
  if (/^ranking/.test(a.type)) await emitEvent(ctx, projectId, 'ranking.changed', payload);
  if (/^traffic/.test(a.type)) await emitEvent(ctx, projectId, 'traffic.changed', payload);
  return { id: row!.id, isNew: true };
}

/** Resolve alerts of a given type whose condition is no longer present. */
async function resolveMissing(ctx: AppContext, projectId: string, typePrefix: string, activeFingerprints: string[]) {
  await ctx.db.query(`UPDATE alerts SET status = 'resolved', resolved_at = now() WHERE project_id = $1 AND type LIKE $2 AND status <> 'resolved' AND NOT (fingerprint = ANY($3::text[]))`, [projectId, typePrefix + '%', activeFingerprints]);
}

export async function loadGscRows(ctx: AppContext, projectId: string, start: string, end: string, opts: { withQuery?: boolean } = {}): Promise<GscRow[]> {
  const where = opts.withQuery === false ? `query = '' AND page = ''` : `query <> ''`;
  return ctx.db.query<GscRow>(`SELECT date::text AS date, query, page, clicks, impressions, position FROM search_console_data WHERE project_id = $1 AND date BETWEEN $2 AND $3 AND ${where}`, [projectId, start, end]);
}

/**
 * Daily monitor: uptime, traffic anomalies and ranking losses for important pages.
 * Emits alerts, then dispatches NEW alerts to configured channels.
 */
export async function evaluateAlerts(ctx: AppContext, projectId: string) {
  const project = await getProject(ctx, projectId);
  const website = await primaryWebsite(ctx, projectId);
  const created: string[] = [];
  const dropPct = project.settings?.thresholds?.trafficDropPct ?? 30;

  // 1. Availability
  const home = await fetchWithRedirects(website.base_url, { userAgent: ctx.cfg.CRAWL_USER_AGENT, timeoutMs: 20000, readBody: false });
  const upFp = `uptime:${website.id}`;
  if (home.error || (home.status ?? 500) >= 500) {
    const r = await raiseAlert(ctx, projectId, { severity: 'critical', type: 'uptime', title: 'Website unavailable', message: `${website.base_url} returned ${home.status ?? home.error}.`, evidence: { status: home.status, error: home.error }, fingerprint: upFp });
    if (r.isNew) created.push(r.id);
  } else await resolveMissing(ctx, projectId, 'uptime', []);

  // 2. Traffic anomalies (site totals include anonymised queries)
  const end = await latestGscDate(ctx.db, projectId);
  const start = isoDate(addDays(end, -34));
  const totals = await loadGscRows(ctx, projectId, start, end, { withQuery: false });
  const series = totals.length ? dailySeries(totals, start, end) : dailySeries(await loadGscRows(ctx, projectId, start, end), start, end);
  const drops = detectDrop(series, { threshold: dropPct });
  const activeDrop: string[] = [];
  for (const d of drops.filter((x) => x.isDrop)) {
    const fp = `traffic_drop:${d.metric}`;
    activeDrop.push(fp);
    const severe = (d.changePct ?? 0) <= -50;
    const r = await raiseAlert(ctx, projectId, {
      severity: severe ? 'critical' : 'high',
      type: 'traffic_drop',
      title: `Organic ${d.metric} dropped ${Math.abs(d.changePct ?? 0)}%`,
      message: `Last 7 days averaged ${d.recent}/day vs ${d.baseline}/day over the previous 4 weeks. Check recent site changes, indexing (Search Console → Pages) and the latest crawl.`,
      evidence: d,
      fingerprint: fp,
    });
    if (r.isNew) created.push(r.id);
  }
  await resolveMissing(ctx, projectId, 'traffic_drop', activeDrop);

  // 3. Important pages losing rankings / clicks (7d vs previous 7d)
  const rows = await loadGscRows(ctx, projectId, isoDate(addDays(end, -13)), end);
  const important = new Set((await ctx.db.query<{ url: string }>(`SELECT url FROM pages WHERE website_id = $1 AND is_important`, [website.id])).map((r) => r.url));
  const activeRank: string[] = [];
  for (const c of comparePeriods(rows, 'page', 7, end)) {
    if (!important.has(c.key) || c.previous.impressions < 50) continue;
    const posLoss = c.positionChange !== null && c.positionChange >= 3;
    const clickLoss = c.previous.clicks >= 10 && (c.clicksChangePct ?? 0) <= -40;
    if (!posLoss && !clickLoss) continue;
    const fp = `ranking_loss:${c.key}`;
    activeRank.push(fp);
    const r = await raiseAlert(ctx, projectId, {
      severity: 'high',
      type: 'ranking_loss',
      title: `Important page losing visibility: ${new URL(c.key).pathname}`,
      message: `Avg position ${c.previous.position} → ${c.current.position}; clicks ${c.previous.clicks} → ${c.current.clicks} (7 days vs prior 7).`,
      evidence: c as unknown as Record<string, unknown>,
      fingerprint: fp,
    });
    if (r.isNew) created.push(r.id);
  }
  await resolveMissing(ctx, projectId, 'ranking_loss', activeRank);

  const dispatched = await dispatchPending(ctx, projectId);
  return { newAlerts: created.length, dispatched };
}

/** Sends alerts that have not been notified yet to channels meeting their minimum severity. */
export async function dispatchPending(ctx: AppContext, projectId: string) {
  const project = await getProject(ctx, projectId);
  const pending = await ctx.db.query<any>(`SELECT * FROM alerts WHERE project_id = $1 AND status = 'open' AND notified = '[]'::jsonb ORDER BY created_at LIMIT 50`, [projectId]);
  if (!ctx.notifiers.length) return { sent: 0, pending: pending.length, channels: [] as string[] };
  let sent = 0;
  for (const a of pending) {
    if (SEVERITY_RANK[a.severity as Severity] < SEVERITY_RANK.medium) continue;
    const results = await dispatch(ctx.notifiers, { severity: a.severity, title: a.title, message: a.message, url: `${ctx.cfg.FRONTEND_URL}/alerts` }, project.settings?.alertMinSeverity ?? {});
    await ctx.db.query(`UPDATE alerts SET notified = $2 WHERE id = $1`, [a.id, results.length ? results : [{ channel: 'none', ok: true, skipped: 'below threshold' }]]);
    if (results.some((r) => r.ok)) sent++;
    const failed = results.filter((r) => !r.ok);
    if (failed.length) ctx.log.warn('alerts.dispatch_failed', { alertId: a.id, failed });
  }
  return { sent, pending: pending.length, channels: ctx.notifiers.map((n) => n.channel) };
}
