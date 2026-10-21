import { useState } from 'react';
import { Check, CheckCheck, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import type { Alert } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { fmtDateTime, fmtRelative, humanize } from '../lib/format';
import { SEVERITIES } from '../lib/constants';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorBox, Loading, Segmented } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pill, SeverityBadge, StatusPill } from '../components/Badges';
import { JsonView } from '../components/JsonView';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

export function AlertsPage() {
  const [status, setStatus] = useState('open,acknowledged');
  const { data, error, loading, reload } = useProjectApi<Alert[]>('/alerts', { status });
  const { canEdit } = useAuth();
  const { base, refreshCounts } = useProject();
  const { busy, run } = useAction();
  const setAlert = (a: Alert, s: 'acknowledged' | 'resolved' | 'open') =>
    run(`${a.id}-${s}`, () => api(`${base}/alerts/${a.id}`, { method: 'PATCH', body: { status: s } }), `Alert ${s}`).then((r) => {
      if (r) {
        reload();
        refreshCounts();
      }
    });

  const cols: Column<Alert>[] = [
    { key: 'sev', header: 'Severity', sort: (r) => SEVERITIES.indexOf(r.severity), render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'type', header: 'Type', sort: (r) => r.type, render: (r) => <Pill>{humanize(r.type)}</Pill> },
    {
      key: 'title',
      header: 'Alert',
      render: (r) => (
        <div className="min-w-64">
          <div className="font-medium text-gray-900">{r.title}</div>
          <div className="text-xs text-gray-600">{r.message}</div>
        </div>
      ),
    },
    { key: 'occ', header: 'Occurrences', align: 'right', sort: (r) => r.occurrences, render: (r) => r.occurrences },
    { key: 'last', header: 'Last seen', sort: (r) => r.last_seen_at, render: (r) => <span className="text-xs whitespace-nowrap" title={fmtDateTime(r.last_seen_at)}>{fmtRelative(r.last_seen_at)}</span> },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) =>
        canEdit ? (
          <span className="inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
            {r.status === 'open' && (
              <Button size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={busy === `${r.id}-acknowledged`} onClick={() => setAlert(r, 'acknowledged')}>
                Acknowledge
              </Button>
            )}
            {r.status !== 'resolved' ? (
              <Button size="sm" variant="success" icon={<CheckCheck className="h-3.5 w-3.5" />} loading={busy === `${r.id}-resolved`} onClick={() => setAlert(r, 'resolved')}>
                Resolve
              </Button>
            ) : (
              <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy === `${r.id}-open`} onClick={() => setAlert(r, 'open')}>
                Reopen
              </Button>
            )}
          </span>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Alerts"
        description="Uptime, traffic drops, ranking losses and migration regressions."
        actions={
          <>
            <Segmented
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'open,acknowledged', label: 'Active' },
                { value: 'resolved', label: 'Resolved' },
                { value: 'all', label: 'All' },
              ]}
            />
            <JobButton type="alerts-evaluate" label="Evaluate now" onDone={reload} />
          </>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <DataTable
          columns={cols}
          rows={data}
          rowKey={(r) => r.id}
          expand={(r) => (
            <div className="space-y-2 text-sm">
              <div className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Evidence</div>
              <JsonView value={r.evidence} />
              <p className="text-xs text-gray-500">
                First seen {fmtDateTime(r.created_at)} · notified: {r.notified?.length ? r.notified.join(', ') : 'none'}
              </p>
            </div>
          )}
          empty={<EmptyState title="No alerts" description="Nothing needs attention. Alerts are evaluated automatically; you can also run the evaluation now." />}
        />
      )}
    </div>
  );
}
