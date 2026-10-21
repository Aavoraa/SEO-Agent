import PDFDocument from 'pdfkit';
import type { AppContext } from '../context.js';
import { auditReport } from './audits.js';

/** PDF export of an SEO audit. Contains only data from the stored audit and current open findings. */

const BRAND = '#E4572E';
const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';

// Standard PDF fonts are WinAnsi – map common typography to safe characters.
const safe = (s: unknown) =>
  String(s ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/→/g, '->')
    .replace(/…/g, '...')
    .replace(/×/g, 'x')
    .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '');

const GRADE: Record<string, string> = { good: 'Good health', fair: 'Fair', needs_work: 'Needs work', poor: 'Poor', not_measured: 'Not measured' };

export async function auditPdf(ctx: AppContext, projectId: string, auditId?: string): Promise<{ buffer: Buffer; filename: string }> {
  const r = await auditReport(ctx, projectId, { auditId });
  if (!r.audit) throw new Error('No audit to export – run an audit first');
  const a = r.audit;
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `SEO Audit – ${r.project.name}`, Author: 'Phoenixx SEO Agent' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 96;

  const h2 = (t: string) => {
    if (doc.y > doc.page.height - 140) doc.addPage();
    doc.moveDown(0.8).fillColor(INK).font('Helvetica-Bold').fontSize(13).text(safe(t));
    doc.moveTo(48, doc.y + 2).lineTo(48 + W, doc.y + 2).strokeColor(LINE).stroke();
    doc.moveDown(0.5);
  };
  const p = (t: string, opts: { color?: string; size?: number; bold?: boolean } = {}) => {
    if (doc.y > doc.page.height - 80) doc.addPage();
    doc.fillColor(opts.color ?? INK).font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.size ?? 10).text(safe(t), { width: W });
  };

  // ── Cover block ──
  doc.rect(48, 48, W, 4).fill(BRAND);
  doc.moveDown(0.6).fillColor(BRAND).font('Helvetica-Bold').fontSize(10).text('PHOENIXX IT · SEO AUDIT', 48, 62);
  doc.fillColor(INK).fontSize(22).text(safe(r.project.name), 48, 78);
  p(a.siteUrl, { color: MUTED });
  p(`Audited ${new Date(a.createdAt).toUTCString()} · ${a.device} · ${a.pagesCrawled} URLs crawled · ${a.checksPassed}/${a.checksTotal} checks passed`, { color: MUTED, size: 9 });
  if (a.isDemo) p('DEMO MODE – sample data, not the live website.', { color: BRAND, bold: true });

  doc.moveDown(1);
  const y = doc.y;
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(44).text(String(a.overall), 48, y, { continued: true }).fontSize(16).fillColor(MUTED).text(' / 100');
  p(`${GRADE[a.grade] ?? a.grade}${r.previous ? ` · ${r.previous.delta >= 0 ? '+' : ''}${r.previous.delta} since previous audit` : ''}`, { bold: true });
  const sev = a.issuesBySeverity as Record<string, number>;
  p(`Issues: ${sev.critical ?? 0} critical · ${sev.high ?? 0} high · ${sev.medium ?? 0} medium · ${sev.low ?? 0} low · ${sev.info ?? 0} info`, { color: MUTED, size: 9 });

  h2('Category scores');
  for (const c of r.categories) {
    if (doc.y > doc.page.height - 70) doc.addPage();
    const rowY = doc.y;
    doc.fillColor(INK).font('Helvetica').fontSize(10).text(safe(c.label), 48, rowY, { width: 150 });
    const barX = 200;
    const barW = 220;
    doc.rect(barX, rowY + 2, barW, 7).fill(LINE);
    if (c.score !== null) doc.rect(barX, rowY + 2, (barW * c.score) / 100, 7).fill(c.score >= 85 ? '#059669' : c.score >= 70 ? '#65A30D' : c.score >= 50 ? '#D97706' : '#DC2626');
    doc.fillColor(INK).font('Helvetica-Bold').text(c.score === null ? 'n/a' : String(c.score), barX + barW + 10, rowY, { width: 40 });
    doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`${c.passed}/${c.checks} checks${c.coverage === 'partial' ? ' · partial' : ''}`, barX + barW + 45, rowY + 1, { width: 90 });
    doc.x = 48;
    doc.moveDown(0.6);
  }
  const partial = r.categories.filter((c) => c.note);
  for (const c of partial) p(`${c.label}: ${c.note}`, { color: MUTED, size: 8 });

  h2('Quick wins');
  if (!r.quickWins.length) p('No low-effort fixes open.', { color: MUTED });
  for (const q of r.quickWins) {
    p(`${q.title} – ${q.affected} page(s)`, { bold: true });
    p(`Impact ${q.impact}/5 · effort ${q.effort}/5 · risk ${q.risk ?? 'n/a'}. ${q.action ?? ''}`, { color: MUTED, size: 9 });
    doc.moveDown(0.3);
  }

  h2('Recommendations & action plan');
  r.recommendations.slice(0, 25).forEach((g, i) => {
    p(`${i + 1}. ${g.title}`, { bold: true });
    p(`${g.category.replace('_', ' ')} · priority ${g.priority ?? 'n/a'} · severity ${g.severity} · ${g.affected} page(s) · confidence ${g.confidence ?? 'n/a'} · risk ${g.risk ?? 'n/a'}`, { color: MUTED, size: 8 });
    if (g.action) p(`Action: ${g.action}`, { size: 9 });
    const urls = g.pages.map((x: { url: string | null }) => x.url).filter(Boolean).slice(0, 8);
    if (urls.length) p(`Pages: ${urls.map((u: string) => new URL(u).pathname).join(', ')}${g.affected > 8 ? ` (+${g.affected - 8} more)` : ''}`, { color: MUTED, size: 8 });
    doc.moveDown(0.4);
  });

  const sections: [string, string][] = [
    ['technical', 'Technical findings'],
    ['performance', 'Performance findings'],
    ['links', 'Link findings'],
    ['ai_search', 'AI search findings'],
    ['local', 'Local SEO findings'],
    ['structured_data', 'Structured data findings'],
    ['security', 'Security findings'],
    ['usability', 'Usability findings'],
  ];
  for (const [cat, title] of sections) {
    const failing = (r.checks as { category: string; label: string; evaluated: number; passed: number; severity: string; detail: string | null }[]).filter((c) => c.category === cat && c.passed < c.evaluated);
    h2(title);
    if (!failing.length) {
      p('All checks passed.', { color: MUTED });
      continue;
    }
    for (const c of failing) p(`• ${c.label} – ${c.evaluated - c.passed} of ${c.evaluated} failing (${c.severity})${c.detail ? ` · ${c.detail}` : ''}`, { size: 9 });
  }

  h2('About this report');
  p('Scores are internal diagnostics calculated from pass/fail checks on the crawled pages; they are not Google metrics and do not predict rankings. Search volume, traffic, rankings and backlinks appear only when the corresponding data source is connected.', { color: MUTED, size: 8 });
  doc.end();
  const buffer = await done;
  const date = new Date(a.createdAt).toISOString().slice(0, 10);
  return { buffer, filename: `seo-audit-${new URL(a.siteUrl).hostname}-${date}.pdf` };
}
