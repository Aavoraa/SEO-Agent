import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { bulkInsert } from '@phoenixx/database';
import type { AppContext } from '../context.js';
import { normalizePath } from '../services/heatmaps.js';

/**
 * Sample heatmap data for the demo project (labelled "Demo" in the UI): page views and clicks on the
 * real elements of the local demo copy, so the click map lines up with the page. Real clicks made on
 * the demo copy (http://127.0.0.1:4001, tracker injected) are recorded on top of it.
 */

type El = cheerio.Cheerio<any>;

/** Same algorithm as cssPath in the hm.js tracker. */
export function cssPath($: cheerio.CheerioAPI, el: El): string | null {
  const parts: string[] = [];
  let cur = el;
  while (cur.length) {
    const node = cur.get(0) as { tagName?: string; attribs?: Record<string, string> };
    const tag = (node.tagName ?? '').toLowerCase();
    if (!tag) return null;
    if (tag === 'body') return `body>${parts.join('>')}`;
    const id = node.attribs?.id;
    if (id && /^[A-Za-z][\w-]*$/.test(id)) {
      parts.unshift(`#${id}`);
      return parts.join('>');
    }
    if (parts.length >= 14) return null;
    parts.unshift(`${tag}:nth-of-type(${cur.prevAll(tag).length + 1})`);
    cur = cur.parent();
  }
  return null;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const CTA = /contact|call|quote|get started|whatsapp|book|enquire|enquiry|talk|free/i;

export async function seedDemoHeatmaps(ctx: AppContext, projectId: string) {
  const have = await ctx.db.one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM heatmap_events WHERE project_id = $1 AND is_demo`, [projectId]);
  if (have?.n) return 0;
  const dir = path.resolve(ctx.cfg.DEMO_SITE_DIR);
  if (!existsSync(dir)) return 0;
  const rand = rng(20260929);
  const gauss = () => (rand() + rand() + rand()) / 3;
  const files = readdirSync(dir).filter((f) => f.endsWith('.html'));
  const rows: Record<string, unknown>[] = [];
  for (const file of files) {
    const $ = cheerio.load(readFileSync(path.join(dir, file), 'utf8'));
    // the demo copy (like the real site) serves pages without the .html extension
    const pagePath = normalizePath(file === 'index.html' ? '/' : `/${file.replace(/\.html$/, '')}`);
    const title = $('title').first().text().trim().slice(0, 200) || null;
    const clickable = $('body a[href], body button').toArray();
    const passive = $('body h1, body h2, body img, body p').toArray().slice(0, 30);
    if (!clickable.length) continue;
    const targets = clickable.map((node, i) => {
      const el = $(node);
      const label = el.text().replace(/\s+/g, ' ').trim().slice(0, 80) || el.attr('aria-label') || null;
      const inNav = el.closest('nav, header').length > 0;
      const weight = (CTA.test(label ?? '') ? 6 : 1) * (inNav ? 3 : 1) * Math.max(0.3, 1 - i / clickable.length);
      return { selector: cssPath($, el), label, order: i / clickable.length, weight };
    }).filter((t) => t.selector);
    const passiveTargets = passive.map((node, i) => ({ selector: cssPath($, $(node)), order: i / passive.length })).filter((t) => t.selector);
    const total = targets.reduce((a, t) => a + t.weight, 0);
    const views = pagePath === '/' ? 380 : 25 + Math.floor(rand() * 60);
    for (let v = 0; v < views; v++) {
      const r = rand();
      const device = r < 0.52 ? 'desktop' : r < 0.9 ? 'mobile' : 'tablet';
      const vw = device === 'desktop' ? 1440 : device === 'mobile' ? 390 : 820;
      const vh = device === 'desktop' ? 860 : device === 'mobile' ? 760 : 1100;
      const docH = device === 'mobile' ? 9000 : 5200;
      const fold = vh / docH;
      const depth = Math.min(1, fold + (1 - fold) * Math.pow(rand(), 1.7));
      const viewId = `demo${v.toString(36)}${Math.floor(rand() * 1e9).toString(36)}`;
      const at = new Date(Date.now() - rand() * 7 * 86400_000).toISOString();
      const base = { project_id: projectId, page_path: pagePath, page_title: title, device, view_id: viewId, doc_height: docH, viewport_w: vw, viewport_h: vh, is_demo: true, created_at: at };
      rows.push({ ...base, kind: 'view', scroll_depth: depth, selector: null, label: null, rel_x: null, rel_y: null, x: null, y: null, rage: false, dead: false });
      const n = Math.floor(rand() * 3.2);
      for (let c = 0; c < n; c++) {
        let pickW = rand() * total;
        let t = targets[0]!;
        for (const cand of targets) if ((pickW -= cand.weight) <= 0) { t = cand; break; }
        const dead = rand() < 0.07 && passiveTargets.length > 0;
        const target = dead ? passiveTargets[Math.floor(rand() * passiveTargets.length)]! : t;
        if (target.order > depth + 0.05) continue; // can't click what was never scrolled to
        const rage = !dead && rand() < 0.012;
        for (let k = 0; k < (rage ? 3 : 1); k++) {
          rows.push({ ...base, kind: 'click', scroll_depth: null, selector: target.selector, label: dead ? null : (t.label ?? null), rel_x: gauss(), rel_y: gauss(), x: 0.15 + 0.7 * gauss(), y: Math.round(target.order * docH * 0.9), rage, dead });
        }
      }
    }
  }
  return bulkInsert(ctx.db, 'heatmap_events', rows, { chunkSize: 500 });
}

/**
 * Served HTML of the demo copy (browser requests only): the heatmap tracker is added and the real site's
 * third-party analytics tags are removed, so browsing the copy never adds 127.0.0.1 visits to the real
 * Clarity / Google Analytics properties.
 */
export function prepareDemoHtml(html: string, trackerTag: string | null) {
  const cleaned = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) => (/clarity\.ms|googletagmanager\.com|google-analytics\.com|gtag\(|\bfbq\(|hotjar|connect\.facebook\.net/i.test(tag) ? '' : tag));
  if (!trackerTag) return cleaned;
  return /<\/body>/i.test(cleaned) ? cleaned.replace(/<\/body>/i, `${trackerTag}\n</body>`) : `${cleaned}\n${trackerTag}`;
}
