import * as cheerio from 'cheerio';
import { fetchWithRedirects } from '@phoenixx/crawler';
import { AppError, addDays, isoDate, round } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { audit, latestGscDate, type Actor, SYSTEM_ACTOR } from './common.js';

async function transition(ctx: AppContext, changeId: string, from: string | null, to: string, actor: string, note: string, details: Record<string, unknown> = {}) {
  await ctx.db.query(`UPDATE seo_changes SET status = $2, updated_at = now() WHERE id = $1`, [changeId, to]);
  await ctx.db.query(`INSERT INTO change_events(change_id, from_status, to_status, actor, note, details) VALUES ($1,$2,$3,$4,$5,$6)`, [changeId, from, to, actor, note, details]);
}

/** Adapter types that can be applied through the configured website adapter. Others are exported for manual work. */
function adapterChangeType(changeType: string): string {
  return changeType === 'other' ? 'og_image' : changeType;
}

export async function implementChange(ctx: AppContext, projectId: string, changeId: string, actor: Actor = SYSTEM_ACTOR) {
  const ch = await ctx.db.one<any>('SELECT * FROM seo_changes WHERE id = $1 AND project_id = $2', [changeId, projectId]);
  if (!ch) throw new AppError('Change not found', 404, 'not_found');
  if (ch.approval_status !== 'approved') throw new AppError('Only approved changes can be implemented', 409, 'not_approved');
  if (!['approved', 'failed'].includes(ch.status)) throw new AppError(`Change is ${ch.status}`, 409, 'invalid_state');
  const { resolveDeployment, deployChange, FILE_DEPLOYABLE } = await import('./deployments.js');
  const target = await resolveDeployment(ctx, projectId);
  if (target.fileBased && ch.new_value && FILE_DEPLOYABLE.includes(ch.change_type)) {
    const r = await deployChange(ctx, projectId, changeId, actor, { wait: true });
    return { ok: !['failed', 'restored'].includes(r.status), applied: ['verified', 'verification_failed', 'deployed'].includes(r.status), adapter: target.provider, ref: `deployment:${r.deploymentId}`, message: `Deployment ${r.status}`, deploymentId: r.deploymentId, status: r.status };
  }
  const reviewer = ch.reviewer_id ? (await ctx.db.one<{ email: string }>('SELECT email FROM users WHERE id = $1', [ch.reviewer_id]))?.email : undefined;
  // Changes without a concrete value (e.g. "expand thin content") are always exported as developer instructions.
  const instructionOnly = !ch.new_value;
  const adapter = !instructionOnly && ctx.adapter.supports(adapterChangeType(ch.change_type)) ? ctx.adapter : null;
  const { ManualExportAdapter } = await import('@phoenixx/integrations');
  const used = adapter ?? new ManualExportAdapter(ctx.cfg.EXPORT_DIR);
  const req = { changeId, pageUrl: ch.page_url ?? '', changeType: adapterChangeType(ch.change_type), oldValue: ch.old_value, newValue: ch.new_value ?? `INSTRUCTION: ${ch.ai_recommendation?.what ?? ch.reason ?? 'See recommendation'}`, reason: ch.reason, approvedBy: reviewer };
  const res = await used.apply(req);
  if (!res.ok) {
    await transition(ctx, changeId, ch.status, 'failed', actor.label, res.message, res.details);
    return { ok: false, message: res.message };
  }
  await ctx.db.query(`UPDATE seo_changes SET adapter = $2, adapter_ref = $3, implemented_by = $4, implemented_at = CASE WHEN $5 THEN now() ELSE implemented_at END WHERE id = $1`, [changeId, used.name, res.ref, actor.label, res.applied]);
  if (res.applied) await transition(ctx, changeId, ch.status, 'implemented', actor.label, res.message, res.details);
  else await ctx.db.query(`INSERT INTO change_events(change_id, from_status, to_status, actor, note, details) VALUES ($1,$2,$2,$3,$4,$5)`, [changeId, ch.status, actor.label, `Awaiting deployment: ${res.message}`, res.details]);
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: 'change.implement', entityType: 'seo_change', entityId: changeId, details: { adapter: used.name, applied: res.applied, ref: res.ref } });
  return { ok: true, applied: res.applied, adapter: used.name, ref: res.ref, message: res.message };
}

/** Reads the live page and checks whether the new value is present. */
export async function checkLiveValue(ctx: AppContext, pageUrl: string, changeType: string, expected: string): Promise<{ live: boolean; observed: string | null }> {
  const r = await fetchWithRedirects(pageUrl, { userAgent: ctx.cfg.CRAWL_USER_AGENT, timeoutMs: ctx.cfg.CRAWL_TIMEOUT_MS, maxBytes: 5 * 1024 * 1024 });
  if (!r.body) return { live: false, observed: r.error ?? `HTTP ${r.status}` };
  const $ = cheerio.load(r.body);
  const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  let observed: string | null = null;
  switch (changeType) {
    case 'title':
      observed = $('title').first().text();
      break;
    case 'meta_description':
      observed = $('meta[name="description" i]').attr('content') ?? null;
      break;
    case 'h1':
      observed = $('h1').first().text();
      break;
    case 'canonical':
      observed = $('link[rel="canonical" i]').attr('href') ?? null;
      break;
    case 'schema': {
      const blocks = $('script[type="application/ld+json" i]').map((_, el) => $(el).text()).get();
      const expectedTypes = [...expected.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
      const validTypes = blocks.flatMap((b) => {
        try {
          return [...JSON.stringify(JSON.parse(b)).matchAll(/"@type":"([^"]+)"/g)].map((m) => m[1]);
        } catch {
          return [];
        }
      });
      observed = validTypes.join(',');
      return { live: expectedTypes.every((t) => validTypes.includes(t)) && blocks.every((b) => { try { JSON.parse(b); return true; } catch { return false; } }), observed };
    }
    case 'internal_link': {
      const href = expected.match(/href="([^"]+)"/)?.[1];
      observed = href ? String($(`a[href="${href}"], a[href$="${href}"]`).length) : null;
      return { live: !!href && $(`a[href="${href}"], a[href$="${href}"]`).length > 0, observed };
    }
    default:
      observed = null;
      return { live: norm($('body').text()).includes(norm(expected).slice(0, 120)), observed: null };
  }
  return { live: norm(observed) === norm(expected), observed };
}

async function pageMetrics(ctx: AppContext, projectId: string, pageUrl: string, start: string, end: string) {
  const r = await ctx.db.one<any>(
    `SELECT COALESCE(SUM(clicks),0)::int AS clicks, COALESCE(SUM(impressions),0)::int AS impressions, (SUM(position*impressions)/NULLIF(SUM(impressions),0))::float AS position
     FROM search_console_data WHERE project_id = $1 AND page = $2 AND query <> '' AND date BETWEEN $3 AND $4`,
    [projectId, pageUrl, start, end],
  );
  return { start, end, clicks: r.clicks, impressions: r.impressions, ctr: r.impressions ? round(r.clicks / r.impressions, 4) : 0, position: r.position ? round(r.position, 2) : null };
}

/** Verification: live check → Verified → start an experiment (Monitoring) for measurable change types. */
export async function verifyChange(ctx: AppContext, projectId: string, changeId: string, actor: Actor = SYSTEM_ACTOR, opts: { manualConfirm?: boolean; note?: string } = {}) {
  const ch = await ctx.db.one<any>('SELECT * FROM seo_changes WHERE id = $1 AND project_id = $2', [changeId, projectId]);
  if (!ch) throw new AppError('Change not found', 404, 'not_found');
  if (!['approved', 'implemented'].includes(ch.status)) throw new AppError(`Change is ${ch.status}; only approved/implemented changes can be verified`, 409, 'invalid_state');
  if (!ch.page_url) throw new AppError('Change has no page URL', 400, 'bad_request');
  if (!ch.new_value && !opts.manualConfirm) return { verified: false, checkedAt: new Date().toISOString(), live: false, observed: null, note: 'Instruction-only change: a reviewer must confirm it is deployed (verify with manualConfirm).' };
  if (opts.manualConfirm && actor.type !== 'user') throw new AppError('Only a human reviewer can confirm a change manually', 403, 'forbidden');
  const res = opts.manualConfirm ? { live: true, observed: `Confirmed by ${actor.label}${opts.note ? `: ${opts.note}` : ''}` } : await checkLiveValue(ctx, ch.page_url, ch.change_type, ch.new_value ?? '');
  const verification = { checkedAt: new Date().toISOString(), live: res.live, observed: res.observed };
  await ctx.db.query('UPDATE seo_changes SET verification = $2 WHERE id = $1', [changeId, verification]);
  if (!res.live) {
    await ctx.db.query(`INSERT INTO change_events(change_id, from_status, to_status, actor, note, details) VALUES ($1,$2,$2,$3,'Not live yet',$4)`, [changeId, ch.status, actor.label, verification]);
    return { verified: false, ...verification };
  }
  if (ch.status === 'approved') {
    await ctx.db.query('UPDATE seo_changes SET implemented_at = COALESCE(implemented_at, now()) WHERE id = $1', [changeId]);
    await transition(ctx, changeId, 'approved', 'implemented', actor.label, 'Detected live on the website');
  }
  const { experimentId } = await completeVerification(ctx, projectId, changeId, actor.label, verification, 'implemented');
  return { verified: true, experimentId, ...verification };
}

/** A change is confirmed live: mark verified, close the recommendation, start an experiment where measurable. */
export async function completeVerification(ctx: AppContext, projectId: string, changeId: string, actorLabel: string, verification: Record<string, unknown>, fromStatus: string) {
  const ch = await ctx.db.one<any>('SELECT * FROM seo_changes WHERE id = $1 AND project_id = $2', [changeId, projectId]);
  await ctx.db.query('UPDATE seo_changes SET verified_at = now() WHERE id = $1', [changeId]);
  await transition(ctx, changeId, fromStatus, 'verified', actorLabel, 'New value confirmed on the live page', verification);
  await ctx.db.query(`UPDATE recommendations SET status = 'verified', updated_at = now() WHERE id = $1`, [ch.recommendation_id]);

  let experimentId: string | null = null;
  if (['title', 'meta_description', 'h1', 'content', 'schema', 'faq', 'internal_link'].includes(ch.change_type)) {
    const today = isoDate(new Date());
    const baselineEnd = isoDate(addDays(today, -1));
    const baseline = await pageMetrics(ctx, projectId, ch.page_url, isoDate(addDays(baselineEnd, -27)), baselineEnd);
    const metric = ch.change_type === 'title' || ch.change_type === 'meta_description' ? 'ctr' : 'clicks';
    const row = await ctx.db.one<{ id: string }>(
      `INSERT INTO experiments(project_id, change_id, page_url, name, hypothesis, primary_metric, monitor_days, start_date, baseline, status) VALUES ($1,$2,$3,$4,$5,$6,28,$7,$8,'running') RETURNING id`,
      [projectId, changeId, ch.page_url, `${ch.change_type.replace('_', ' ')} change on ${new URL(ch.page_url).pathname}`, `Changing the ${ch.change_type.replace('_', ' ')} will improve ${metric} for this page.`, metric, today, baseline],
    );
    experimentId = row!.id;
    await transition(ctx, changeId, 'verified', 'monitoring', actorLabel, `Monitoring for 28 days (experiment ${experimentId.slice(0, 8)})`);
  }
  return { experimentId };
}

export async function rollbackChange(ctx: AppContext, projectId: string, changeId: string, actor: Actor, reason?: string) {
  if (actor.role !== 'admin') throw new AppError('Only admins can roll back changes', 403, 'forbidden');
  const ch = await ctx.db.one<any>('SELECT * FROM seo_changes WHERE id = $1 AND project_id = $2', [changeId, projectId]);
  if (!ch) throw new AppError('Change not found', 404, 'not_found');
  if (!['implemented', 'verified', 'monitoring', 'completed', 'approved', 'deployed', 'verification_failed'].includes(ch.status)) throw new AppError(`Cannot roll back a change that is ${ch.status}`, 409, 'invalid_state');
  if (String(ch.adapter_ref ?? '').startsWith('deployment:')) {
    const { rollbackDeployment } = await import('./deployments.js');
    const r = await rollbackDeployment(ctx, projectId, changeId, actor, reason);
    return { ok: r.ok, applied: true, message: r.message, deploymentId: r.deploymentId, verified: r.verified };
  }
  const { ManualExportAdapter } = await import('@phoenixx/integrations');
  const adapter = ch.adapter && ch.adapter === ctx.adapter.name ? ctx.adapter : new ManualExportAdapter(ctx.cfg.EXPORT_DIR);
  const res = await adapter.rollback({ changeId, pageUrl: ch.page_url ?? '', changeType: adapterChangeType(ch.change_type), oldValue: ch.old_value, newValue: ch.new_value, reason: reason ?? 'Rollback' }, ch.adapter_ref);
  if (!res.ok) throw new AppError(`Rollback failed: ${res.message}`, 502, 'rollback_failed');
  await ctx.db.query('UPDATE seo_changes SET rolled_back_at = now() WHERE id = $1', [changeId]);
  await ctx.db.query("UPDATE recommendations SET status = 'recommended', updated_at = now() WHERE id = $1", [ch.recommendation_id]);
  await transition(ctx, changeId, ch.status, 'rolled_back', actor.label, reason ?? res.message, { adapter: adapter.name, ref: res.ref, applied: res.applied });
  await ctx.db.query(`UPDATE experiments SET status = 'cancelled', conclusion = 'Change rolled back', updated_at = now() WHERE change_id = $1 AND status = 'running'`, [changeId]);
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: 'change.rollback', entityType: 'seo_change', entityId: changeId, details: { reason, adapter: adapter.name } });
  return { ok: true, applied: res.applied, message: res.message };
}

/** Scheduled job: implement approved changes (only through automatic adapters) and verify pending ones. */
export async function processApprovedChanges(ctx: AppContext, projectId: string) {
  const approved = await ctx.db.query<{ id: string; adapter_ref: string | null; change_type: string }>(`SELECT id, adapter_ref, change_type FROM seo_changes WHERE project_id = $1 AND status = 'approved' AND COALESCE(risk, 'medium') <> 'critical' ORDER BY created_at LIMIT 25`, [projectId]);
  const out = { implemented: 0, exported: 0, verified: 0, notLive: 0, errors: [] as string[] };
  for (const c of approved) {
    try {
      if (!c.adapter_ref) {
        const r = await implementChange(ctx, projectId, c.id);
        if (r.ok && r.applied) out.implemented++;
        else if (r.ok) out.exported++;
      }
    } catch (e) {
      out.errors.push(`${c.id}: ${(e as Error).message}`);
    }
  }
  const pending = await ctx.db.query<{ id: string }>(`SELECT id FROM seo_changes WHERE project_id = $1 AND status IN ('approved','implemented') AND page_url IS NOT NULL AND new_value IS NOT NULL AND (adapter_ref IS NOT NULL OR status = 'implemented') ORDER BY created_at LIMIT 25`, [projectId]);
  for (const c of pending) {
    try {
      const v = await verifyChange(ctx, projectId, c.id);
      if (v.verified) out.verified++;
      else out.notLive++;
    } catch (e) {
      out.errors.push(`${c.id}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Experiment evaluation: compares equal windows before/after; never claims causation. */
export async function evaluateExperiments(ctx: AppContext, projectId: string) {
  const latest = await latestGscDate(ctx.db, projectId);
  const running = await ctx.db.query<any>(`SELECT * FROM experiments WHERE project_id = $1 AND status = 'running'`, [projectId]);
  const results = [];
  for (const ex of running) {
    const afterStart = isoDate(addDays(ex.start_date, 1));
    const afterEnd = isoDate(addDays(ex.start_date, ex.monitor_days));
    if (afterEnd > latest) {
      results.push({ id: ex.id, status: 'running', note: `Waiting for data until ${afterEnd}` });
      continue;
    }
    const after = await pageMetrics(ctx, projectId, ex.page_url, afterStart, afterEnd);
    const before = ex.baseline ?? (await pageMetrics(ctx, projectId, ex.page_url, isoDate(addDays(ex.start_date, -ex.monitor_days)), isoDate(addDays(ex.start_date, -1))));
    const metric = ex.primary_metric as 'ctr' | 'clicks' | 'impressions' | 'position';
    const b = before[metric] ?? 0;
    const a = after[metric] ?? 0;
    const change = b ? round(((a - b) / b) * 100, 1) : null;
    const enoughData = before.impressions >= 100 && after.impressions >= 100;
    const direction = metric === 'position' ? (a < b ? 'improved' : a > b ? 'worsened' : 'unchanged') : a > b ? 'improved' : a < b ? 'worsened' : 'unchanged';
    const status = enoughData ? 'completed' : 'inconclusive';
    const conclusion = enoughData
      ? `${metric.toUpperCase()} ${direction} from ${b} to ${a}${change !== null ? ` (${change > 0 ? '+' : ''}${change}%)` : ''} in the ${ex.monitor_days} days after the change. This coincided with the change; seasonality, algorithm updates and other site changes can also explain it, so treat it as correlation, not proof.`
      : `Not enough data to judge (${before.impressions} impressions before, ${after.impressions} after; 100+ needed in each window).`;
    await ctx.db.query(`UPDATE experiments SET status = $2, end_date = $3, result = $4, conclusion = $5, updated_at = now() WHERE id = $1`, [ex.id, status, afterEnd, { before, after, metric, changePct: change, direction }, conclusion]);
    if (ex.change_id) {
      await ctx.db.query(`UPDATE seo_changes SET result = $2 WHERE id = $1`, [ex.change_id, { before, after, metric, changePct: change, direction, conclusion }]);
      await transition(ctx, ex.change_id, 'monitoring', 'completed', 'system', conclusion);
    }
    results.push({ id: ex.id, status, conclusion });
  }
  return { evaluated: results.length, results };
}
