import { round } from '@phoenixx/shared';

/** Report data model shared by the weekly report, the initial SEO report and the dashboard. */
export interface Kpi {
  label: string;
  current: number | null;
  previous: number | null;
  format: 'int' | 'pct' | 'pos' | 'score';
  /** true when a lower value is better (average position). */
  lowerIsBetter?: boolean;
  note?: string;
}

export interface ReportRow {
  label: string;
  url?: string | null;
  values: (string | number | null)[];
}

export interface ReportSection {
  title: string;
  intro?: string;
  columns?: string[];
  rows?: ReportRow[];
  bullets?: string[];
}

export interface ReportData {
  title: string;
  siteUrl: string;
  periodLabel: string;
  generatedAt: string;
  isDemo: boolean;
  dataNotes: string[];
  executive: { headline: string; summary: string; wins: string[]; concerns: string[]; nextActions: string[]; aiGenerated: boolean };
  kpis: Kpi[];
  sections: ReportSection[];
  dashboardUrl?: string;
}

export function fmt(v: number | null, f: Kpi['format']): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  if (f === 'pct') return `${round(v * 100, 2)}%`;
  if (f === 'pos') return round(v, 1).toFixed(1);
  if (f === 'score') return `${Math.round(v)}/100`;
  return Math.round(v).toLocaleString('en-IN');
}

export function kpiDelta(k: Kpi): { text: string; direction: 'up' | 'down' | 'flat' | 'na'; good: boolean | null } {
  if (k.current === null || k.previous === null) return { text: 'n/a', direction: 'na', good: null };
  const diff = k.current - k.previous;
  if (Math.abs(diff) < 1e-9) return { text: 'no change', direction: 'flat', good: null };
  const up = diff > 0;
  const good = k.lowerIsBetter ? !up : up;
  let text: string;
  if (k.format === 'pct') text = `${up ? '+' : ''}${round(diff * 100, 2)} pp`;
  else if (k.format === 'pos') text = `${up ? '+' : ''}${round(diff, 1)}`;
  else text = k.previous ? `${up ? '+' : ''}${round((diff / k.previous) * 100, 1)}%` : `${up ? '+' : ''}${Math.round(diff)}`;
  return { text, direction: up ? 'up' : 'down', good };
}

/** Plain-language summary used when no AI provider is configured (or as the AI's factual input). */
export function deterministicExecutive(kpis: Kpi[], extras: { criticalIssues: number; resolvedIssues: number; newOpportunities: number; changesImplemented: number }): ReportData['executive'] {
  const find = (l: string) => kpis.find((k) => k.label === l);
  const clicks = find('Organic clicks');
  const imp = find('Impressions');
  const d = clicks ? kpiDelta(clicks) : null;
  const wins: string[] = [];
  const concerns: string[] = [];
  for (const k of kpis) {
    const delta = kpiDelta(k);
    if (delta.good === true) wins.push(`${k.label}: ${fmt(k.current, k.format)} (${delta.text})`);
    if (delta.good === false) concerns.push(`${k.label}: ${fmt(k.current, k.format)} (${delta.text})`);
  }
  if (extras.criticalIssues) concerns.unshift(`${extras.criticalIssues} critical technical issue(s) need attention`);
  if (extras.resolvedIssues) wins.push(`${extras.resolvedIssues} issue(s) resolved since the last crawl`);
  const headline = clicks && clicks.current !== null ? `Organic clicks ${d?.direction === 'up' ? 'rose' : d?.direction === 'down' ? 'fell' : 'held'} at ${fmt(clicks.current, 'int')} (${d?.text ?? 'n/a'} vs previous period).` : 'Search Console is not connected yet – this report covers technical and content findings only.';
  const summary = [
    clicks && imp ? `The site received ${fmt(clicks.current, 'int')} organic clicks from ${fmt(imp.current, 'int')} impressions in this period.` : '',
    extras.criticalIssues ? `There are ${extras.criticalIssues} critical issue(s) that could affect visibility.` : 'No critical technical issues are open.',
    extras.newOpportunities ? `${extras.newOpportunities} new opportunities were identified.` : '',
    extras.changesImplemented ? `${extras.changesImplemented} approved change(s) were implemented; effects on rankings typically take weeks and cannot be attributed with certainty.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { headline, summary, wins: wins.slice(0, 5), concerns: concerns.slice(0, 5), nextActions: [], aiGenerated: false };
}

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Email-safe HTML (inline styles, tables). */
export function renderReportHtml(r: ReportData): string {
  const brand = '#E85D04';
  const kpiCells = r.kpis
    .map((k) => {
      const d = kpiDelta(k);
      const color = d.good === null ? '#6b7280' : d.good ? '#15803d' : '#b91c1c';
      return `<td style="padding:12px 14px;border:1px solid #e5e7eb;vertical-align:top;width:25%"><div style="font-size:12px;color:#6b7280">${esc(k.label)}</div><div style="font-size:22px;font-weight:600;color:#111827;margin-top:4px">${fmt(k.current, k.format)}</div><div style="font-size:12px;color:${color};margin-top:2px">${esc(d.text)}${k.previous !== null ? ` <span style="color:#9ca3af">(prev ${fmt(k.previous, k.format)})</span>` : ''}</div></td>`;
    })
    .reduce<string[]>((rows, cell, i) => {
      if (i % 4 === 0) rows.push('');
      rows[rows.length - 1] += cell;
      return rows;
    }, [])
    .map((row) => `<tr>${row}</tr>`)
    .join('');
  const list = (items: string[], color: string) => (items.length ? `<ul style="margin:6px 0 0 18px;padding:0;color:#374151">${items.map((i) => `<li style="margin:3px 0"><span style="color:${color}">●</span> ${esc(i)}</li>`).join('')}</ul>` : '<p style="color:#9ca3af;margin:6px 0">None</p>');
  const sections = r.sections
    .map(
      (s) => `<h2 style="font-size:16px;color:#111827;margin:28px 0 6px">${esc(s.title)}</h2>${s.intro ? `<p style="color:#4b5563;margin:0 0 8px;font-size:13px">${esc(s.intro)}</p>` : ''}${
        s.rows?.length
          ? `<table style="width:100%;border-collapse:collapse;font-size:13px">${s.columns ? `<tr>${s.columns.map((c, i) => `<th style="text-align:${i ? 'right' : 'left'};padding:6px 8px;border-bottom:2px solid #e5e7eb;color:#6b7280;font-weight:600">${esc(c)}</th>`).join('')}</tr>` : ''}${s.rows
              .map((row) => `<tr><td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;color:#111827">${row.url ? `<a href="${esc(row.url)}" style="color:${brand};text-decoration:none">${esc(row.label)}</a>` : esc(row.label)}</td>${row.values.map((v) => `<td style="padding:6px 8px;border-bottom:1px solid #f3f4f6;text-align:right;color:#374151">${esc(v ?? '—')}</td>`).join('')}</tr>`)
              .join('')}</table>`
          : ''
      }${s.bullets?.length ? list(s.bullets, brand) : ''}${!s.rows?.length && !s.bullets?.length ? '<p style="color:#9ca3af;font-size:13px">Nothing to report.</p>' : ''}`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.title)}</title></head>
<body style="margin:0;background:#f9fafb;font-family:Inter,Segoe UI,Arial,sans-serif">
<div style="max-width:760px;margin:0 auto;padding:24px 16px">
${r.isDemo ? '<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:12px"><strong>DEMO DATA</strong> – generated from clearly-marked sample data, not real Phoenixx IT performance.</div>' : ''}
<div style="background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:24px">
<div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${brand};font-weight:600">Phoenixx IT · SEO Report</div>
<h1 style="font-size:22px;color:#111827;margin:6px 0 2px">${esc(r.title)}</h1>
<div style="color:#6b7280;font-size:13px">${esc(r.siteUrl)} · ${esc(r.periodLabel)}</div>
<h2 style="font-size:16px;color:#111827;margin:24px 0 6px">Executive summary${r.executive.aiGenerated ? ' <span style="font-size:11px;color:#9ca3af;font-weight:400">(AI-drafted from the data below)</span>' : ''}</h2>
<p style="font-size:15px;color:#111827;font-weight:600;margin:0 0 6px">${esc(r.executive.headline)}</p>
<p style="color:#374151;font-size:14px;line-height:1.55;margin:0">${esc(r.executive.summary)}</p>
<table style="width:100%;border-collapse:collapse;margin-top:16px">${kpiCells}</table>
<table style="width:100%;margin-top:16px"><tr><td style="vertical-align:top;width:50%;padding-right:8px"><strong style="font-size:13px;color:#15803d">What went well</strong>${list(r.executive.wins, '#15803d')}</td><td style="vertical-align:top;width:50%;padding-left:8px"><strong style="font-size:13px;color:#b91c1c">Needs attention</strong>${list(r.executive.concerns, '#b91c1c')}</td></tr></table>
${r.executive.nextActions.length ? `<h2 style="font-size:16px;color:#111827;margin:24px 0 6px">Recommended next actions</h2><ol style="margin:0 0 0 18px;padding:0;color:#374151;font-size:14px">${r.executive.nextActions.map((a) => `<li style="margin:4px 0">${esc(a)}</li>`).join('')}</ol>` : ''}
${sections}
<p style="margin-top:28px;font-size:11px;color:#9ca3af;line-height:1.5">${r.dataNotes.map(esc).join('<br>')}<br>Generated ${esc(new Date(r.generatedAt).toUTCString())}${r.dashboardUrl ? ` · <a href="${esc(r.dashboardUrl)}" style="color:${brand}">Open dashboard</a>` : ''}</p>
</div></div></body></html>`;
}

export function renderReportMarkdown(r: ReportData): string {
  const lines: string[] = [];
  if (r.isDemo) lines.push('> **DEMO DATA** – sample data, not real Phoenixx IT performance.', '');
  lines.push(`# ${r.title}`, '', `${r.siteUrl} · ${r.periodLabel}`, '', '## Executive summary', '', `**${r.executive.headline}**`, '', r.executive.summary, '');
  lines.push('| KPI | Current | Previous | Change |', '|---|---:|---:|---:|');
  for (const k of r.kpis) lines.push(`| ${k.label} | ${fmt(k.current, k.format)} | ${fmt(k.previous, k.format)} | ${kpiDelta(k).text} |`);
  lines.push('');
  if (r.executive.wins.length) lines.push('**What went well**', ...r.executive.wins.map((w) => `- ${w}`), '');
  if (r.executive.concerns.length) lines.push('**Needs attention**', ...r.executive.concerns.map((w) => `- ${w}`), '');
  if (r.executive.nextActions.length) lines.push('## Recommended next actions', ...r.executive.nextActions.map((a, i) => `${i + 1}. ${a}`), '');
  for (const s of r.sections) {
    lines.push(`## ${s.title}`, '');
    if (s.intro) lines.push(s.intro, '');
    if (s.rows?.length) {
      const cols = s.columns ?? ['Item', ...s.rows[0]!.values.map((_, i) => `Value ${i + 1}`)];
      lines.push(`| ${cols.join(' | ')} |`, `|${cols.map((_, i) => (i ? '---:' : '---')).join('|')}|`);
      for (const row of s.rows) lines.push(`| ${row.url ? `[${row.label}](${row.url})` : row.label} | ${row.values.map((v) => v ?? '—').join(' | ')} |`);
      lines.push('');
    }
    if (s.bullets?.length) lines.push(...s.bullets.map((b) => `- ${b}`), '');
  }
  lines.push('---', ...r.dataNotes.map((n) => `_${n}_`));
  return lines.join('\n');
}
