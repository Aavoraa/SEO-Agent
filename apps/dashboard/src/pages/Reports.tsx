import { useEffect, useState } from 'react';
import { Download, Eye } from 'lucide-react';
import { download, fetchText } from '../api/client';
import type { ReportRow } from '../api/types';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { fmtDate, fmtDateTime, humanize } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorBox, Loading } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pill } from '../components/Badges';
import { Drawer } from '../components/Overlay';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

function ReportViewer({ report, onClose }: { report: ReportRow; onClose: () => void }) {
  const { base } = useProject();
  const { busy, run } = useAction();
  const [html, setHtml] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  useEffect(() => {
    fetchText(`${base}/reports/${report.id}`, { format: 'html' }).then(setHtml, setErr);
  }, [base, report.id]);
  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-5xl"
      title={report.title}
      subtitle={`${humanize(report.type)} · ${fmtDateTime(report.created_at)}`}
      actions={
        <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'md'} onClick={() => run('md', () => download(`${base}/reports/${report.id}`, `report-${report.id}.md`, { format: 'md' }))}>
          Markdown
        </Button>
      }
    >
      {err ? <ErrorBox error={err} /> : html === null ? <Loading /> : <iframe title={report.title} srcDoc={html} sandbox="" className="h-[calc(100vh-120px)] w-full rounded-md border border-gray-200 bg-white" />}
    </Drawer>
  );
}

export function ReportsPage() {
  const { data, error, loading, reload } = useProjectApi<ReportRow[]>('/reports');
  const [open, setOpen] = useState<ReportRow | null>(null);
  const cols: Column<ReportRow>[] = [
    { key: 'type', header: 'Type', sort: (r) => r.type, render: (r) => <Pill tone={r.type === 'migration' ? 'violet' : r.type === 'weekly' ? 'blue' : 'gray'}>{humanize(r.type)}</Pill> },
    {
      key: 'title',
      header: 'Title',
      sort: (r) => r.title,
      render: (r) => (
        <div className="min-w-60">
          <div className="font-medium text-gray-900">{r.title}</div>
          {r.summary && <div className="line-clamp-2 max-w-2xl text-xs text-gray-500">{r.summary}</div>}
        </div>
      ),
    },
    { key: 'period', header: 'Period', sort: (r) => r.period_start, render: (r) => <span className="text-xs whitespace-nowrap">{r.period_start ? `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}` : '—'}</span> },
    { key: 'ai', header: 'AI generated', render: (r) => (r.ai_generated ? <Pill tone="violet">AI-assisted</Pill> : <span className="text-xs text-gray-500">No</span>) },
    { key: 'sent', header: 'Sent', render: (r) => <span className="text-xs text-gray-600">{r.sent_to?.length ? r.sent_to.join(', ') : 'Not sent'}</span> },
    { key: 'created', header: 'Created', sort: (r) => r.created_at, render: (r) => <span className="text-xs">{fmtDate(r.created_at)}</span> },
    { key: 'view', header: '', align: 'right', render: () => <Eye className="ml-auto h-4 w-4 text-gray-400" /> },
  ];
  return (
    <div>
      <PageHeader
        title="Reports"
        description="Weekly and initial SEO reports. AI-assisted summaries are based only on the data in each report."
        actions={
          <>
            <JobButton type="initial-report" label="Generate initial report" onDone={reload} />
            <JobButton type="weekly-report" body={{ send: false }} label="Generate weekly report" variant="primary" onDone={reload} />
          </>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && <DataTable columns={cols} rows={data} rowKey={(r) => r.id} onRowClick={setOpen} empty={<EmptyState title="No reports yet" description="Generate the initial report after the first crawl, then weekly reports." />} />}
      {open && <ReportViewer report={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
