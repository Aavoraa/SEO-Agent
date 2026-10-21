import { addDays, isoDate, pctChange, round } from '@phoenixx/shared';

export interface GscRow {
  date: string; // YYYY-MM-DD
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface AggMetrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

export interface PeriodComparison {
  key: string;
  current: AggMetrics;
  previous: AggMetrics;
  clicksChangePct: number | null;
  impressionsChangePct: number | null;
  positionChange: number | null; // negative = improved
  trend: 'rising' | 'declining' | 'stable' | 'new' | 'lost';
  topPage: string | null;
  pages: number;
}

export function aggregate(rows: GscRow[]): AggMetrics {
  let clicks = 0;
  let impressions = 0;
  let posWeighted = 0;
  for (const r of rows) {
    clicks += r.clicks;
    impressions += r.impressions;
    posWeighted += r.position * r.impressions;
  }
  return { clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? round(posWeighted / impressions, 2) : null };
}

export function windowRange(endDate: string, days: number): { start: string; end: string; prevStart: string; prevEnd: string } {
  const end = endDate;
  const start = isoDate(addDays(endDate, -(days - 1)));
  const prevEnd = isoDate(addDays(start, -1));
  const prevStart = isoDate(addDays(prevEnd, -(days - 1)));
  return { start, end, prevStart, prevEnd };
}

function trendOf(cur: AggMetrics, prev: AggMetrics): PeriodComparison['trend'] {
  if (!prev.impressions && cur.impressions) return 'new';
  if (prev.impressions && !cur.impressions) return 'lost';
  const imp = pctChange(cur.impressions, prev.impressions) ?? 0;
  const clk = prev.clicks >= 5 ? (pctChange(cur.clicks, prev.clicks) ?? 0) : 0;
  const pos = cur.position !== null && prev.position !== null ? cur.position - prev.position : 0;
  const score = (imp > 20 ? 1 : imp < -20 ? -1 : 0) + (clk > 20 ? 1 : clk < -20 ? -1 : 0) + (pos < -1.5 ? 1 : pos > 1.5 ? -1 : 0);
  return score >= 1 ? 'rising' : score <= -1 ? 'declining' : 'stable';
}

/**
 * Compares the last `days` days (ending `endDate`) with the preceding equal-length period,
 * grouped by query or page. GSC data lags ~2–3 days; callers should pass endDate accordingly.
 */
export function comparePeriods(rows: GscRow[], by: 'query' | 'page', days: number, endDate: string): PeriodComparison[] {
  const { start, end, prevStart, prevEnd } = windowRange(endDate, days);
  const cur = new Map<string, GscRow[]>();
  const prev = new Map<string, GscRow[]>();
  for (const r of rows) {
    const key = r[by];
    if (!key) continue;
    if (r.date >= start && r.date <= end) (cur.get(key) ?? cur.set(key, []).get(key)!).push(r);
    else if (r.date >= prevStart && r.date <= prevEnd) (prev.get(key) ?? prev.set(key, []).get(key)!).push(r);
  }
  const keys = new Set([...cur.keys(), ...prev.keys()]);
  const out: PeriodComparison[] = [];
  for (const key of keys) {
    const c = aggregate(cur.get(key) ?? []);
    const p = aggregate(prev.get(key) ?? []);
    const other = by === 'query' ? 'page' : 'query';
    const byOther = new Map<string, number>();
    for (const r of cur.get(key) ?? []) byOther.set(r[other], (byOther.get(r[other]) ?? 0) + r.impressions);
    const top = [...byOther.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    out.push({
      key,
      current: c,
      previous: p,
      clicksChangePct: pctChange(c.clicks, p.clicks),
      impressionsChangePct: pctChange(c.impressions, p.impressions),
      positionChange: c.position !== null && p.position !== null ? round(c.position - p.position, 2) : null,
      trend: trendOf(c, p),
      topPage: by === 'query' ? top : null,
      pages: by === 'query' ? byOther.size : 0,
    });
  }
  return out.sort((a, b) => b.current.impressions - a.current.impressions);
}

export function dailySeries(rows: GscRow[], start: string, end: string) {
  const byDate = new Map<string, GscRow[]>();
  for (const r of rows) if (r.date >= start && r.date <= end) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)!).push(r);
  const out: ({ date: string } & AggMetrics)[] = [];
  for (let d = new Date(start + 'T00:00:00Z'); isoDate(d) <= end; d = addDays(d, 1)) {
    const k = isoDate(d);
    out.push({ date: k, ...aggregate(byDate.get(k) ?? []) });
  }
  return out;
}

/** Simple anomaly detection: compares the latest N days to the trailing baseline mean/stdev. */
export function detectDrop(series: { date: string; clicks: number; impressions: number }[], opts: { recentDays?: number; minBaseline?: number; threshold?: number } = {}) {
  const recentDays = opts.recentDays ?? 7;
  const recent = series.slice(-recentDays);
  const base = series.slice(0, -recentDays);
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const out: { metric: 'clicks' | 'impressions'; baseline: number; recent: number; changePct: number | null; isDrop: boolean }[] = [];
  for (const metric of ['clicks', 'impressions'] as const) {
    const b = mean(base.map((s) => s[metric]));
    const r = mean(recent.map((s) => s[metric]));
    const change = pctChange(r, b);
    out.push({ metric, baseline: round(b, 1), recent: round(r, 1), changePct: change, isDrop: b >= (opts.minBaseline ?? (metric === 'clicks' ? 3 : 30)) && change !== null && change <= -(opts.threshold ?? 30) });
  }
  return out;
}
