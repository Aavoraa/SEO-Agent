import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ShieldAlert } from 'lucide-react';
import type { MigrationFinding, MigrationResponse } from '../api/types';
import { useAuth } from '../context/auth';
import { useProjectApi } from '../hooks/useApi';
import { useJob } from '../hooks/useJob';
import { fmtDateTime, fmtNum, humanize } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Field, Loading, Stat } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pill, SeverityBadge } from '../components/Badges';
import { CodeBlock } from '../components/CodeBlock';
import { JobStatusLine } from '../components/JobButton';
import { EmptyState } from '../components/EmptyState';

const SEV_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

export function MigrationPage() {
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useProjectApi<MigrationResponse>('/migration');
  const baselineJob = useJob({ onDone: reload });
  const compJob = useJob({ onDone: reload });
  const compareJob = useJob({ onDone: reload });
  const [label, setLabel] = useState(`Baseline ${new Date().toISOString().slice(0, 10)}`);
  const [compLabel, setCompLabel] = useState('New site (staging)');
  const [sourceUrl, setSourceUrl] = useState('');
  const [baselineId, setBaselineId] = useState('');
  const [comparisonId, setComparisonId] = useState('');
  const [reportIdx, setReportIdx] = useState(0);

  const baselines = useMemo(() => (data?.snapshots ?? []).filter((s) => s.kind === 'baseline'), [data]);
  const comparisons = useMemo(() => (data?.snapshots ?? []).filter((s) => s.kind === 'comparison'), [data]);
  useEffect(() => {
    if (!baselineId && baselines[0]) setBaselineId(baselines[0].id);
    if (!comparisonId && comparisons[0]) setComparisonId(comparisons[0].id);
  }, [baselines, comparisons, baselineId, comparisonId]);

  const report = data?.reports[reportIdx] ?? null;
  const rd = report?.data;

  const cols: Column<MigrationFinding>[] = [
    { key: 'sev', header: 'Severity', sort: (r) => SEV_ORDER.indexOf(r.severity), render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'type', header: 'Type', sort: (r) => r.type, render: (r) => <span className="text-xs">{humanize(r.type)}</span> },
    { key: 'path', header: 'Path', sort: (r) => r.path, render: (r) => <span className="font-mono text-xs">{r.path}</span> },
    {
      key: 'ba',
      header: 'Before → After',
      render: (r) => (
        <span className="block max-w-sm text-xs">
          <span className="text-gray-500">{r.before ?? '—'}</span> <ArrowRight className="inline h-3 w-3 text-gray-400" /> <span className="text-gray-900">{r.after ?? '—'}</span>
        </span>
      ),
    },
    { key: 'msg', header: 'Message', render: (r) => <span className="block max-w-md text-xs text-gray-700">{r.message}</span> },
    { key: 'clicks', header: 'Clicks (90d)', align: 'right', sort: (r) => r.clicks, render: (r) => fmtNum(r.clicks) },
    { key: 'redir', header: 'Suggested redirect', render: (r) => (r.suggestedRedirect ? <span className="font-mono text-xs">{r.suggestedRedirect.to} <span className="text-gray-400">({Math.round(r.suggestedRedirect.confidence * 100)}%)</span></span> : <span className="text-gray-400">—</span>) },
  ];

  return (
    <div>
      <PageHeader
        title="Migration Monitor"
        description="Protect SEO equity during the website redesign: capture a baseline of today's site, crawl the new or staging site, and compare URLs, titles, headings, canonicals, indexability, internal links and traffic at risk before launch."
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          {canEdit && (
            <div className="grid gap-5 lg:grid-cols-3">
              <Card title="1. Capture baseline" subtitle="Snapshot of the current live site from the latest crawl">
                <div className="space-y-3">
                  <Field label="Label">
                    <input className="input w-full" value={label} onChange={(e) => setLabel(e.target.value)} />
                  </Field>
                  <Button variant="primary" loading={baselineJob.busy} disabled={!label.trim()} onClick={() => baselineJob.run('migration-snapshot', { label, kind: 'baseline' })}>
                    Capture baseline from latest crawl
                  </Button>
                  <JobStatusLine job={baselineJob} className="block" />
                </div>
              </Card>
              <Card title="2. Snapshot new site" subtitle="Crawls the staging or newly launched site (paths are compared, so a staging host works)">
                <div className="space-y-3">
                  <Field label="Label">
                    <input className="input w-full" value={compLabel} onChange={(e) => setCompLabel(e.target.value)} />
                  </Field>
                  <Field label="New / staging site URL">
                    <input className="input w-full" placeholder="https://staging.example.com" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
                  </Field>
                  <Button variant="primary" loading={compJob.busy} disabled={!sourceUrl.trim() || !compLabel.trim()} onClick={() => compJob.run('migration-snapshot', { label: compLabel, kind: 'comparison', sourceUrl })}>
                    Crawl & snapshot new site
                  </Button>
                  <JobStatusLine job={compJob} className="block" />
                </div>
              </Card>
              <Card title="3. Compare" subtitle="Produces a migration report and queues redirect proposals for admin approval">
                <div className="space-y-3">
                  <Field label="Baseline">
                    <select className="input w-full" value={baselineId} onChange={(e) => setBaselineId(e.target.value)}>
                      <option value="">Select…</option>
                      {baselines.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label} ({s.page_count} pages)
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Comparison">
                    <select className="input w-full" value={comparisonId} onChange={(e) => setComparisonId(e.target.value)}>
                      <option value="">Select…</option>
                      {[...comparisons, ...baselines].map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label} ({s.kind}, {s.page_count} pages)
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Button variant="primary" loading={compareJob.busy} disabled={!baselineId || !comparisonId || baselineId === comparisonId} onClick={() => compareJob.run('migration-compare', { baselineId, comparisonId })}>
                    Run comparison
                  </Button>
                  <JobStatusLine job={compareJob} className="block" />
                </div>
              </Card>
            </div>
          )}

          <Card title="Snapshots" bodyClassName="p-0">
            {data.snapshots.length ? (
              <ul className="divide-y divide-gray-100">
                {data.snapshots.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                    <Pill tone={s.kind === 'baseline' ? 'blue' : 'violet'}>{humanize(s.kind)}</Pill>
                    <span className="font-medium text-gray-900">{s.label}</span>
                    <span className="text-xs text-gray-500">{s.source_url}</span>
                    <span className="ml-auto text-xs text-gray-500">
                      {fmtNum(s.page_count)} pages · {fmtDateTime(s.created_at)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4">
                <EmptyState compact title="No snapshots yet" description="Capture a baseline now, before the redesign goes live." />
              </div>
            )}
          </Card>

          {report && rd && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-sm font-semibold text-gray-900">{report.title}</h2>
                <span className="text-xs text-gray-500">{fmtDateTime(report.created_at)}</span>
                {data.reports.length > 1 && (
                  <select className="input ml-auto" value={reportIdx} onChange={(e) => setReportIdx(Number(e.target.value))} aria-label="Migration report">
                    {data.reports.map((r, i) => (
                      <option key={r.id} value={i}>
                        {r.title} – {fmtDateTime(r.created_at)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 2xl:grid-cols-8">
                <Stat label="Baseline pages" value={fmtNum(rd.summary.baselinePages)} />
                <Stat label="New pages" value={fmtNum(rd.summary.newPages)} />
                <Stat label="Preserved" value={fmtNum(rd.summary.preserved)} />
                <Stat label="Missing" value={<span className={rd.summary.missing ? 'text-red-700' : ''}>{fmtNum(rd.summary.missing)}</span>} />
                <Stat label="Redirected" value={fmtNum(rd.summary.redirected)} />
                <Stat label="Clicks at risk (90d)" value={<span className={rd.summary.atRiskClicks ? 'text-red-700' : ''}>{fmtNum(rd.summary.atRiskClicks)}</span>} hint={`${fmtNum(rd.summary.atRiskImpressions)} impressions`} />
                <Stat label="Critical" value={<span className={rd.summary.critical ? 'text-red-700' : ''}>{fmtNum(rd.summary.critical)}</span>} />
                <Stat label="High" value={fmtNum(rd.summary.high)} />
              </div>
              {rd.summary.critical > 0 && (
                <p className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" /> Critical regressions found. Do not launch until missing URLs are redirected or restored. Redirect proposals are in Approvals (admin-only, high risk).
                </p>
              )}
              <Card title={`Findings (${rd.findings.length})`} bodyClassName="p-0">
                <DataTable className="rounded-none border-0" dense columns={cols} rows={rd.findings} rowKey={(r) => `${r.type}:${r.path}`} initialSort={{ key: 'sev', dir: 'asc' }} maxHeight="520px" empty={<p className="p-4 text-sm text-gray-500">No differences found.</p>} />
              </Card>
              <div className="grid gap-5 lg:grid-cols-2">
                <Card title={`Redirect map (${rd.redirectMap.length})`} bodyClassName="p-0">
                  {rd.redirectMap.length ? (
                    <div className="max-h-96 overflow-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 bg-gray-50 text-xs text-gray-500">
                          <tr>
                            <th className="px-4 py-2 text-left font-medium">From</th>
                            <th className="px-4 py-2 text-left font-medium">To</th>
                            <th className="px-4 py-2 text-right font-medium">Confidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rd.redirectMap.map((r) => (
                            <tr key={r.from} className="border-t border-gray-100">
                              <td className="px-4 py-2 font-mono text-xs">{r.from}</td>
                              <td className="px-4 py-2 font-mono text-xs">{r.to}</td>
                              <td className="px-4 py-2 text-right text-xs tabular" title={r.basis}>{Math.round(r.confidence * 100)}%</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="p-4 text-sm text-gray-500">No redirects needed.</p>
                  )}
                </Card>
                <Card title="Apache redirect rules" subtitle="Review before deploying – single-hop 301s">
                  <CodeBlock code={rd.apacheRules} title=".htaccess" maxHeight="320px" />
                </Card>
              </div>
            </>
          )}
          {!report && data.snapshots.length > 0 && <EmptyState title="No migration report yet" description="Select a baseline and a comparison snapshot, then run the comparison." />}
        </div>
      )}
    </div>
  );
}
