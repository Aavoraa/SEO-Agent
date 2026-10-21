const nf = new Intl.NumberFormat('en-IN');
const nf1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });

export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return Number.isInteger(v) ? nf.format(v) : nf1.format(v);
}

/** CTR stored as a ratio (0.043) → "4.3%". */
export function fmtCtr(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

export function fmtPos(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return v.toFixed(1);
}

export function fmtUsd(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `$${v < 1 && v > 0 ? v.toFixed(4) : v.toFixed(2)}`;
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtShortDate(v: string): string {
  const d = new Date(v.length === 10 ? `${v}T00:00:00` : v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(v: string | null | undefined): string {
  if (!v) return '—';
  const ms = Date.now() - new Date(v).getTime();
  if (Number.isNaN(ms)) return v;
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return fmtDate(v);
}

/** Percentage change from previous → current; null when previous is 0/absent. */
export function deltaPct(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current == null || previous == null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function pathOf(url: string | null | undefined): string {
  if (!url) return '—';
  try {
    const u = new URL(url);
    return u.pathname + u.search || '/';
  } catch {
    return url;
  }
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '—';
  const t = s.replace(/[_-]+/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function isCodeLike(v: string | null | undefined): boolean {
  if (!v) return false;
  return /^\s*[<{[]/.test(v) || v.includes('\n') || /^Redirect\s+\d{3}/.test(v);
}
