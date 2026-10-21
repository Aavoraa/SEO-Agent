import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { newId } from '@phoenixx/shared';
import type { AppContext } from '../context.js';

/**
 * Demo session recordings: real rrweb recordings of the local demo copy (scripted visits: navigation,
 * a contact form with masked inputs, a rage click, dead clicks, a JS error, a mobile visit), shipped as
 * database/seed/sample-recordings.json.gz and shifted to the last two days. Labelled "Demo" in the UI.
 */

interface FixtureSession {
  device: string;
  browser: string;
  os: string;
  viewport_w: number;
  viewport_h: number;
  entry_path: string;
  exit_path: string;
  pages: { v: string; path: string; title: string | null; ts: number }[];
  page_count: number;
  click_count: number;
  rage_clicks: number;
  dead_clicks: number;
  error_count: number;
  event_count: number;
  events: { type: number; timestamp: number }[];
}

function fixtureFile() {
  const name = 'database/seed/sample-recordings.json.gz';
  return [process.env.DEMO_RECORDINGS_FILE, path.resolve(process.cwd(), name), path.resolve(process.cwd(), '../../', name), '/app/' + name].find((c): c is string => !!c && existsSync(c));
}

export async function seedDemoRecordings(ctx: AppContext, projectId: string) {
  const have = await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM session_recordings WHERE project_id = $1`, [projectId]);
  if (have?.n) return 0;
  const file = fixtureFile();
  if (!file) return 0;
  const { sessions } = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as { sessions: FixtureSession[] };
  let n = 0;
  for (const [i, s] of sessions.entries()) {
    if (s.events.length < 2) continue;
    const first = s.events[0]!.timestamp;
    const start = Date.now() - (i * 9 + 2) * 3600_000 - Math.round(Math.random() * 1800_000);
    const delta = start - first;
    const events = s.events.map((e) => ({ ...e, timestamp: e.timestamp + delta }));
    const pages = s.pages.map((p) => ({ ...p, ts: p.ts + delta }));
    const last = events[events.length - 1]!.timestamp;
    const rec = await ctx.db.one<{ id: string }>(
      `INSERT INTO session_recordings(project_id, session_key, started_at, ended_at, first_ts, last_ts, duration_ms, device, browser, os, viewport_w, viewport_h, entry_path, exit_path, pages, page_count,
                                      click_count, rage_clicks, dead_clicks, error_count, event_count, bytes, is_demo)
       VALUES ($1,$2,to_timestamp($3::float / 1000),to_timestamp($4::float / 1000),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,0,true) RETURNING id`,
      [projectId, `demo${newId().replace(/-/g, '').slice(0, 20)}`, start, last, last - start, s.device, s.browser, s.os, s.viewport_w, s.viewport_h, s.entry_path, s.exit_path, JSON.stringify(pages), s.page_count, s.click_count, s.rage_clicks, s.dead_clicks, s.error_count, events.length],
    );
    // one chunk per page view (a page view starts at each rrweb Meta event)
    const starts = events.map((e, idx) => (e.type === 4 ? idx : -1)).filter((x) => x >= 0);
    if (starts[0] !== 0) starts.unshift(0);
    let bytes = 0;
    for (const [k, from] of starts.entries()) {
      const part = events.slice(from, starts[k + 1] ?? events.length);
      if (!part.length) continue;
      const data = gzipSync(JSON.stringify(part)).toString('base64');
      bytes += data.length;
      await ctx.db.query(`INSERT INTO recording_chunks(recording_id, view_id, seq, first_ts, last_ts, event_count, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [rec!.id, pages[k]?.v ?? `v${k}`, k, part[0]!.timestamp, part[part.length - 1]!.timestamp, part.length, data]);
    }
    await ctx.db.query(`UPDATE session_recordings SET bytes = $2 WHERE id = $1`, [rec!.id, bytes]);
    n++;
  }
  return n;
}
