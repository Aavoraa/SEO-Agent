import { gunzipSync, gzipSync } from 'node:zlib';
import { AppError } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject } from './common.js';
import { authorizeBeacon, forgetSiteKeys, normalizePath, type Device } from './heatmaps.js';

/**
 * Session recordings (rrweb). The hm.js tracker loads the recorder only when recordings are enabled for
 * the project and the session is sampled; every input is masked in the browser before anything is sent.
 * Events are stored gzip-compressed per page-view chunk; session stats (clicks, rage/dead clicks, errors,
 * pages) are kept on the session row so the list can be filtered like Clarity's.
 */

export type Masking = 'balanced' | 'strict';
export interface RecordingSettings { enabled: boolean; sampleRate: number; masking: Masking }
export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = { enabled: true, sampleRate: 1, masking: 'balanced' };
const MAX_SESSION_MS = 3 * 60 * 60_000;

export function recordingSettingsOf(settings: object | null | undefined): RecordingSettings {
  const r = ((settings ?? {}) as { recordings?: Partial<RecordingSettings> }).recordings ?? {};
  return {
    enabled: r.enabled ?? DEFAULT_RECORDING_SETTINGS.enabled,
    sampleRate: typeof r.sampleRate === 'number' ? Math.min(1, Math.max(0, r.sampleRate)) : DEFAULT_RECORDING_SETTINGS.sampleRate,
    masking: r.masking === 'strict' ? 'strict' : 'balanced',
  };
}

export async function saveRecordingSettings(ctx: AppContext, projectId: string, s: RecordingSettings) {
  await ctx.db.query(`UPDATE projects SET settings = jsonb_set(settings, '{recordings}', $2::jsonb), updated_at = now() WHERE id = $1`, [projectId, s]);
  forgetSiteKeys();
  return s;
}

/* ── browser/OS from the User-Agent (only the names are stored, never the UA string) ── */

export function parseUserAgent(ua: string | undefined): { browser: string; os: string } {
  const u = ua ?? '';
  const browser = /Edg(e|A|iOS)?\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /SamsungBrowser/.test(u) ? 'Samsung Internet' : /Firefox\/|FxiOS/.test(u) ? 'Firefox' : /Chrome\/|CriOS/.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'Other';
  const os = /Windows/.test(u) ? 'Windows' : /iPhone|iPad|iPod/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /CrOS/.test(u) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /Linux/.test(u) ? 'Linux' : 'Other';
  return { browser, os };
}

/* ── ingestion ── */

export interface RecPayload { k: string; s: string; v: string; p: string; t?: string; d: Device; vw: number; vh: number; q: number; e: unknown[] }
interface RrEvent { type: number; timestamp: number; data?: { source?: number; type?: number; tag?: string } }

/** Counts what the session list filters on: clicks (rrweb MouseInteraction.Click) and the tracker's markers. */
export function eventStats(events: RrEvent[]) {
  let clicks = 0, rage = 0, dead = 0, errors = 0;
  for (const e of events) {
    if (e.type === 3 && e.data?.source === 2 && e.data?.type === 2) clicks++;
    else if (e.type === 5) {
      if (e.data?.tag === 'rage-click') rage++;
      else if (e.data?.tag === 'dead-click') dead++;
      else if (e.data?.tag === 'error') errors++;
    }
  }
  return { clicks, rage, dead, errors };
}

export async function ingestRecording(ctx: AppContext, b: RecPayload, meta: { origin?: string; userAgent?: string; country?: string | null }) {
  const info = await authorizeBeacon(ctx, b.k, meta.origin);
  if (!recordingSettingsOf(info.settings).enabled) return { stored: false, reason: 'disabled' };
  const events = b.e.filter((e): e is RrEvent => !!e && typeof e === 'object' && typeof (e as RrEvent).type === 'number' && Number.isFinite((e as RrEvent).timestamp));
  if (!events.length) return { stored: false, reason: 'empty' };
  events.sort((a, c) => a.timestamp - c.timestamp);
  const first = events[0]!.timestamp;
  const last = events[events.length - 1]!.timestamp;
  const data = gzipSync(JSON.stringify(events)).toString('base64');
  const stats = eventStats(events);
  const path = normalizePath(b.p);
  const title = b.t?.slice(0, 200) || null;
  const maxBytes = ctx.cfg.RECORDING_MAX_MB * 1024 * 1024;

  let rec = await ctx.db.one<{ id: string; bytes: number; first_ts: string; pages: { v: string }[] }>(
    `SELECT id, bytes, first_ts, pages FROM session_recordings WHERE project_id = $1 AND session_key = $2`,
    [info.projectId, b.s],
  );
  if (!rec) {
    const { browser, os } = parseUserAgent(meta.userAgent);
    rec = await ctx.db.one(
      `INSERT INTO session_recordings(project_id, session_key, first_ts, last_ts, duration_ms, device, browser, os, country, viewport_w, viewport_h, entry_path, exit_path, pages, page_count,
                                      click_count, rage_clicks, dead_clicks, error_count, event_count, bytes, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,1,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (project_id, session_key) DO NOTHING
       RETURNING id, 0 AS bytes, first_ts, '[]'::jsonb AS pages`,
      [info.projectId, b.s, first, last, last - first, b.d, browser, os, meta.country ?? null, b.vw, b.vh, path, JSON.stringify([{ v: b.v, path, title, ts: first }]), stats.clicks, stats.rage, stats.dead, stats.errors, events.length, data.length, info.isDemo],
    );
    if (rec) {
      await insertChunk(ctx, rec.id, b, first, last, events.length, data);
      return { stored: true, recordingId: rec.id };
    }
    // a parallel beacon created it first
    rec = await ctx.db.one(`SELECT id, bytes, first_ts, pages FROM session_recordings WHERE project_id = $1 AND session_key = $2`, [info.projectId, b.s]);
    if (!rec) throw new AppError('Recording could not be stored', 500, 'internal_error');
  }
  if (rec.bytes + data.length > maxBytes) return { stored: false, reason: 'size_limit' };
  if (last - Number(rec.first_ts) > MAX_SESSION_MS) return { stored: false, reason: 'duration_limit' };
  const pages = Array.isArray(rec.pages) ? rec.pages : [];
  const newView = !pages.some((p) => p.v === b.v);
  await ctx.db.query(
    `UPDATE session_recordings SET
        first_ts = LEAST(first_ts, $2), last_ts = GREATEST(last_ts, $3), duration_ms = GREATEST(last_ts, $3) - LEAST(first_ts, $2),
        ended_at = now(), click_count = click_count + $4, rage_clicks = rage_clicks + $5, dead_clicks = dead_clicks + $6, error_count = error_count + $7,
        event_count = event_count + $8, bytes = bytes + $9,
        pages = CASE WHEN $10 THEN pages || $11::jsonb ELSE pages END,
        page_count = page_count + CASE WHEN $10 THEN 1 ELSE 0 END,
        exit_path = CASE WHEN $10 THEN $12 ELSE exit_path END
      WHERE id = $1`,
    [rec.id, first, last, stats.clicks, stats.rage, stats.dead, stats.errors, events.length, data.length, newView, JSON.stringify([{ v: b.v, path, title, ts: first }]), path],
  );
  await insertChunk(ctx, rec.id, b, first, last, events.length, data);
  if (Math.random() < 0.01) await pruneRecordings(ctx).catch(() => undefined);
  return { stored: true, recordingId: rec.id };
}

async function insertChunk(ctx: AppContext, recordingId: string, b: RecPayload, first: number, last: number, count: number, data: string) {
  await ctx.db.query(`INSERT INTO recording_chunks(recording_id, view_id, seq, first_ts, last_ts, event_count, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [recordingId, b.v, b.q, first, last, count, data]);
}

export async function pruneRecordings(ctx: AppContext) {
  return ctx.db.query(`DELETE FROM session_recordings WHERE ended_at < now() - ($1 || ' days')::interval`, [String(ctx.cfg.RECORDING_RETENTION_DAYS)]);
}

/* ── reading ── */

export interface RecordingFilter {
  days: number;
  device?: Device | 'all';
  minDurationSec?: number;
  page?: string;
  rage?: boolean;
  dead?: boolean;
  errors?: boolean;
  favorites?: boolean;
  unviewed?: boolean;
  sort?: 'newest' | 'oldest' | 'longest' | 'clicks' | 'pages';
  limit?: number;
  offset?: number;
}

const COLS = `id, started_at, ended_at, duration_ms, device, browser, os, country, viewport_w, viewport_h, entry_path, exit_path, pages, page_count,
              click_count, rage_clicks, dead_clicks, error_count, event_count, bytes, is_demo, favorite, viewed_at`;
const ORDER: Record<NonNullable<RecordingFilter['sort']>, string> = {
  newest: 'started_at DESC',
  oldest: 'started_at ASC',
  longest: 'duration_ms DESC, started_at DESC',
  clicks: 'click_count DESC, started_at DESC',
  pages: 'page_count DESC, started_at DESC',
};

function filterSql(projectId: string, f: RecordingFilter) {
  const where = ['project_id = $1', `started_at >= now() - ($2 || ' days')::interval`, 'duration_ms >= 1000'];
  const params: unknown[] = [projectId, String(f.days)];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.device && f.device !== 'all') add('device = ?', f.device);
  if (f.minDurationSec) add('duration_ms >= ?', f.minDurationSec * 1000);
  if (f.page) add(`EXISTS (SELECT 1 FROM jsonb_array_elements(pages) pg WHERE pg->>'path' ILIKE ?)`, `%${f.page.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  if (f.rage) where.push('rage_clicks > 0');
  if (f.dead) where.push('dead_clicks > 0');
  if (f.errors) where.push('error_count > 0');
  if (f.favorites) where.push('favorite');
  if (f.unviewed) where.push('viewed_at IS NULL');
  return { sql: where.join(' AND '), params };
}

export async function listRecordings(ctx: AppContext, projectId: string, f: RecordingFilter) {
  const { sql, params } = filterSql(projectId, f);
  const limit = Math.min(200, f.limit ?? 50);
  const [items, total, summary] = await Promise.all([
    ctx.db.query(`SELECT ${COLS} FROM session_recordings WHERE ${sql} ORDER BY ${ORDER[f.sort ?? 'newest']} LIMIT ${limit} OFFSET ${Math.max(0, f.offset ?? 0)}`, params),
    ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM session_recordings WHERE ${sql}`, params),
    ctx.db.one<{ sessions: number; avg_duration: number | null; rage: number; dead: number; errors: number; demo: boolean | null }>(
      `SELECT COUNT(*)::int AS sessions, AVG(duration_ms)::float AS avg_duration, COUNT(*) FILTER (WHERE rage_clicks > 0)::int AS rage,
              COUNT(*) FILTER (WHERE dead_clicks > 0)::int AS dead, COUNT(*) FILTER (WHERE error_count > 0)::int AS errors, BOOL_AND(is_demo) AS demo
         FROM session_recordings WHERE project_id = $1 AND started_at >= now() - ($2 || ' days')::interval AND duration_ms >= 1000`,
      [projectId, String(f.days)],
    ),
  ]);
  return {
    items,
    total: total?.n ?? 0,
    summary: { sessions: summary?.sessions ?? 0, avgDurationMs: summary?.avg_duration ?? null, withRageClicks: summary?.rage ?? 0, withDeadClicks: summary?.dead ?? 0, withErrors: summary?.errors ?? 0 },
    dataLabel: summary?.sessions && summary.demo ? 'demo' : 'verified',
  };
}

export async function getRecording(ctx: AppContext, projectId: string, id: string, opts: { markViewed?: boolean; filter?: RecordingFilter } = {}) {
  const row = await ctx.db.one<Record<string, unknown> & { started_at: string }>(`SELECT ${COLS} FROM session_recordings WHERE project_id = $1 AND id = $2`, [projectId, id]);
  if (!row) throw new AppError('Recording not found', 404, 'not_found');
  if (opts.markViewed && !row.viewed_at) await ctx.db.query(`UPDATE session_recordings SET viewed_at = now() WHERE id = $1`, [id]);
  // previous = newer, next = older (the list is newest first)
  const { sql, params } = filterSql(projectId, opts.filter ?? { days: 365 });
  const n = params.length;
  const [newer, older] = await Promise.all([
    ctx.db.one<{ id: string }>(`SELECT id FROM session_recordings WHERE ${sql} AND (started_at, id) > ($${n + 1}::timestamptz, $${n + 2}::uuid) ORDER BY started_at ASC, id ASC LIMIT 1`, [...params, row.started_at, id]),
    ctx.db.one<{ id: string }>(`SELECT id FROM session_recordings WHERE ${sql} AND (started_at, id) < ($${n + 1}::timestamptz, $${n + 2}::uuid) ORDER BY started_at DESC, id DESC LIMIT 1`, [...params, row.started_at, id]),
  ]);
  const p = await getProject(ctx, projectId);
  return { ...row, previousId: newer?.id ?? null, nextId: older?.id ?? null, masking: recordingSettingsOf(p.settings).masking };
}

/** All rrweb events of a session in time order (decompressed chunk by chunk). */
export async function recordingEvents(ctx: AppContext, projectId: string, id: string) {
  const own = await ctx.db.one(`SELECT 1 FROM session_recordings WHERE project_id = $1 AND id = $2`, [projectId, id]);
  if (!own) throw new AppError('Recording not found', 404, 'not_found');
  const chunks = await ctx.db.query<{ data: string }>(`SELECT data FROM recording_chunks WHERE recording_id = $1 ORDER BY first_ts, seq, id`, [id]);
  const events: RrEvent[] = [];
  for (const c of chunks) {
    try {
      events.push(...(JSON.parse(gunzipSync(Buffer.from(c.data, 'base64')).toString('utf8')) as RrEvent[]));
    } catch {
      /* skip a damaged chunk rather than failing the whole replay */
    }
  }
  events.sort((a, b) => a.timestamp - b.timestamp);
  return events;
}

export async function setFavorite(ctx: AppContext, projectId: string, id: string, favorite: boolean) {
  const r = await ctx.db.query(`UPDATE session_recordings SET favorite = $3 WHERE project_id = $1 AND id = $2 RETURNING id`, [projectId, id, favorite]);
  if (!r.length) throw new AppError('Recording not found', 404, 'not_found');
  return { id, favorite };
}

export async function deleteRecording(ctx: AppContext, projectId: string, id: string) {
  const r = await ctx.db.query(`DELETE FROM session_recordings WHERE project_id = $1 AND id = $2 RETURNING id`, [projectId, id]);
  if (!r.length) throw new AppError('Recording not found', 404, 'not_found');
  return { deleted: true };
}
