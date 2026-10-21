import { useState } from 'react';
import { Download, Hammer, RotateCcw, ShieldCheck, TrendingDown, TrendingUp } from 'lucide-react';
import { api, download } from '../api/client';
import type { Change, ChangeDetail, DeploymentRow, TimelineItem } from '../api/types';
import { DeploymentProgress } from '../components/ChangeWorkflow';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useApi, useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtDate, fmtDateTime, humanize, pathOf } from '../lib/format';
import { RECOMMENDATION_TYPES } from '../lib/constants';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, KeyValues, Loading, Tabs, Tooltip } from '../components/ui';
import { FilterBar, FilterField, SearchFilter, SelectFilter } from '../components/FilterBar';
import { DataTable, type Column } from '../components/DataTable';
import { Pill, StatusPill } from '../components/Badges';
import { Drawer } from '../components/Overlay';
import { CurrentVsProposed } from '../components/RecommendationCard';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

const FLOW = ['approved', 'implemented', 'verified', 'monitoring', 'completed'];

function Lifecycle({ status }: { status: string }) {
  const idx = FLOW.indexOf(status);
  const bad = status === 'rolled_back' || status === 'failed' || status === 'rejected';
  return (
    <span className="inline-flex items-center gap-1">
      {FLOW.map((s, i) => (
        <Tooltip key={s} content={humanize(s)}>
          <span className={cx('h-1.5 w-4 rounded-full', bad ? 'bg-red-200' : i <= idx ? 'bg-brand-500' : 'bg-gray-200')} />
        </Tooltip>
      ))}
      <span className="ml-1.5">
        <StatusPill status={status} />
      </span>
    </span>
  );
}

/** Deployments & rollbacks of this change: steps, verification (expected vs actual) and backups. */
function Deployments({ changeId }: { changeId: string }) {
  const { base } = useProject();
  const deps = useApi<DeploymentRow[]>(`${base}/deployments`, { changeId });
  if (!deps.data?.length) return null;
  return (
    <Card title={`Deployments (${deps.data.length})`} subtitle="Backup, deployment, verification and rollback records" bodyClassName="space-y-2 p-3">
      {deps.data.map((d) => <DeploymentProgress key={d.id} deploymentId={d.id} />)}
    </Card>
  );
}

function ChangeDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { base } = useProject();
  const { canEdit, isAdmin } = useAuth();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useApi<ChangeDetail>(`${base}/changes/${id}`);
  const act = (kind: 'implement' | 'verify' | 'rollback', confirm = false) => {
    let body: Record<string, unknown> | undefined;
    if (confirm) {
      const note = window.prompt('Confirm this change is live on the website. Optional note (recorded in the audit trail):');
      if (note === null) return;
      body = { manualConfirm: true, note: note || undefined };
    }
    if (kind === 'rollback') {
      const reason = window.prompt('Reason for rolling back this change (recorded in the audit log):');
      if (reason === null) return;
      body = { reason: reason || undefined };
    }
    run(kind, () => api(`${base}/changes/${id}/${kind}`, { method: 'POST', body }), `Change ${kind === 'implement' ? 'implemented' : kind === 'verify' ? 'verification run' : 'rolled back'}`).then((r) => {
      if (r !== undefined) {
        reload();
        onChanged();
      }
    });
  };
  const exp = (fmt: 'json' | 'csv' | 'md') => run(`exp-${fmt}`, () => (fmt === 'json' ? download(`${base}/changes/${id}`, `change-${id}.json`) : download(`${base}/changes/${id}`, `change-${id}.${fmt}`, { format: fmt })));

  return (
    <Drawer
      open
      onClose={onClose}
      title={data ? `${humanize(data.change_type)} change` : 'Change'}
      subtitle={data && <span className="font-mono">{data.page_url}</span>}
      actions={
        <span className="hidden gap-1 sm:inline-flex">
          {(['json', 'csv', 'md'] as const).map((f) => (
            <Button key={f} size="sm" variant="ghost" icon={<Download className="h-3.5 w-3.5" />} loading={busy === `exp-${f}`} onClick={() => exp(f)}>
              {f.toUpperCase()}
            </Button>
          ))}
        </span>
      }
    >
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <Lifecycle status={data.status} />
          </div>
          {canEdit && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" icon={<Hammer className="h-3.5 w-3.5" />} loading={busy === 'implement'} disabled={!['approved', 'failed'].includes(data.status) || !!busy} title={!data.new_value ? 'Instruction-only change: exports developer instructions. Confirm deployment afterwards.' : undefined} onClick={() => act('implement')}>
                Implement
              </Button>
              <Button size="sm" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={busy === 'verify'} disabled={!['approved', 'implemented'].includes(data.status) || !!busy} onClick={() => act('verify')}>
                Verify
              </Button>
              {!data.new_value && (
                <Button size="sm" icon={<ShieldCheck className="h-3.5 w-3.5" />} loading={busy === 'verify'} disabled={!['approved', 'implemented'].includes(data.status) || !!busy} title="No value can be checked automatically – confirm once the developer has deployed it" onClick={() => act('verify', true)}>
                  Confirm deployed
                </Button>
              )}
              <Tooltip content={!isAdmin ? 'Admin only' : null}>
                <Button size="sm" variant="danger" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy === 'rollback'} disabled={!isAdmin || !['implemented', 'verified', 'monitoring', 'completed', 'approved'].includes(data.status) || !!busy} onClick={() => act('rollback')}>
                  Rollback (admin)
                </Button>
              </Tooltip>
            </div>
          )}
          <KeyValues
            items={[
              { label: 'Reason', value: data.reason ?? '—' },
              { label: 'Approved by', value: data.reviewer_email ?? '—' },
              { label: 'Adapter', value: data.adapter ?? '—' },
              { label: 'Implemented', value: fmtDateTime(data.implemented_at) },
              { label: 'Verified', value: fmtDateTime(data.verified_at) },
              { label: 'Rolled back', value: fmtDateTime(data.rolled_back_at) },
            ]}
          />
          <CurrentVsProposed current={data.old_value} proposed={data.new_value} />
          <Deployments changeId={id} />
          <Card title="History" bodyClassName="p-0">
            <ol className="divide-y divide-gray-100">
              {data.events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                  <span className="w-40 text-xs text-gray-500">{fmtDateTime(e.created_at)}</span>
                  <span className="text-xs text-gray-500">{e.from_status ? humanize(e.from_status) : '—'} →</span>
                  <StatusPill status={e.to_status} />
                  <span className="text-xs text-gray-600">{e.actor}</span>
                  {e.note && <span className="text-xs text-gray-500">· {e.note}</span>}
                </li>
              ))}
            </ol>
          </Card>
          {data.experiment && (
            <Card title="Experiment" actions={<StatusPill status={data.experiment.status} />}>
              <p className="text-sm text-gray-800">{data.experiment.conclusion ?? `Monitoring ${data.experiment.primary_metric.toUpperCase()} for ${data.experiment.monitor_days} days from ${fmtDate(data.experiment.start_date)}.`}</p>
              <p className="mt-1 text-[11px] text-gray-500">Correlation, not causation – other factors can move these metrics.</p>
            </Card>
          )}
        </div>
      )}
    </Drawer>
  );
}

function Timeline({ onOpen }: { onOpen: (id: string) => void }) {
  const [f, setF] = useState({ page: '', type: '', from: '', to: '', user: '' });
  const { data, error, loading, reload } = useProjectApi<TimelineItem[]>('/changelog', f);
  return (
    <>
      <FilterBar onReset={() => setF({ page: '', type: '', from: '', to: '', user: '' })}>
        <SearchFilter label="Page" value={f.page} onChange={(v) => setF({ ...f, page: v })} placeholder="/services" />
        <SelectFilter label="Change type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={RECOMMENDATION_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
        <FilterField label="From">
          <input type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </FilterField>
        <FilterField label="To">
          <input type="date" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </FilterField>
        <SearchFilter label="User" value={f.user} onChange={(v) => setF({ ...f, user: v })} placeholder="email or system" />
      </FilterBar>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && !data.length && <EmptyState title="Nothing in the change log yet" description="Approved changes and their lifecycle events appear here, along with notable organic traffic shifts." />}
      {data && data.length > 0 && (
        <ol className="relative ml-3 border-l border-gray-200">
          {data.map((t, i) => {
            const traffic = t.kind === 'traffic';
            return (
              <li key={i} className="relative mb-3 ml-5">
                <span className={cx('absolute top-3 -left-[27px] flex h-3.5 w-3.5 items-center justify-center rounded-full ring-4 ring-gray-50', traffic ? (t.impact === 'improved' ? 'bg-emerald-500' : 'bg-red-500') : 'bg-brand-500')} />
                <div className={cx('rounded-lg border px-4 py-2.5', traffic ? 'border-dashed border-gray-300 bg-gray-50' : 'border-gray-200 bg-white')}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-500 tabular">{fmtDateTime(t.at)}</span>
                    {traffic ? (
                      <Pill tone={t.impact === 'improved' ? 'green' : 'red'}>
                        {t.impact === 'improved' ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />} Traffic marker
                      </Pill>
                    ) : (
                      t.impact && <Pill tone={t.impact === 'improved' ? 'green' : t.impact === 'worsened' ? 'red' : 'gray'}>Impact: {humanize(t.impact)}</Pill>
                    )}
                    {t.actor && <span className="text-xs text-gray-500">by {t.actor}</span>}
                  </div>
                  <div className="mt-0.5 text-sm font-medium text-gray-900">{humanize(t.title)}</div>
                  <div className="text-xs text-gray-600">
                    {t.detail}
                    {t.page && <span className="ml-1 font-mono text-gray-500">{t.detail ? "· " : ""}{pathOf(t.page)}</span>}
                  </div>
                  {t.changeId && (
                    <button onClick={() => onOpen(t.changeId!)} className="mt-1 text-xs font-medium text-brand-600 hover:underline">
                      Open change
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function ChangesTable({ onOpen }: { onOpen: (id: string) => void }) {
  const [status, setStatus] = useState('');
  const { data, error, loading, reload } = useProjectApi<Change[]>('/changes', { status });
  const cols: Column<Change>[] = [
    { key: 'created', header: 'Created', sort: (r) => r.created_at, render: (r) => <span className="text-xs">{fmtDate(r.created_at)}</span> },
    { key: 'type', header: 'Type', sort: (r) => r.change_type, render: (r) => <Pill>{humanize(r.change_type)}</Pill> },
    { key: 'page', header: 'Page', sort: (r) => r.page_url, render: (r) => <span className="font-mono text-xs">{pathOf(r.page_url)}</span> },
    { key: 'title', header: 'Recommendation', render: (r) => <span className="text-xs text-gray-700">{r.recommendation_title ?? '—'}</span> },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <Lifecycle status={r.status} /> },
    { key: 'reviewer', header: 'Approved by', render: (r) => <span className="text-xs text-gray-600">{r.reviewer_email ?? '—'}</span> },
  ];
  return (
    <>
      <FilterBar>
        <SelectFilter label="Status" value={status} onChange={setStatus} options={['approved', 'implemented', 'verified', 'monitoring', 'completed', 'rolled_back', 'failed'].map((s) => ({ value: s, label: humanize(s) }))} />
      </FilterBar>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && <DataTable columns={cols} rows={data} rowKey={(r) => r.id} onRowClick={(r) => onOpen(r.id)} empty={<EmptyState title="No changes yet" description="Approve a recommendation to create a change." />} />}
    </>
  );
}

export function ChangeLogPage() {
  const [tab, setTab] = useState<'timeline' | 'changes'>('timeline');
  const [open, setOpen] = useState<string | null>(null);
  const [k, setK] = useState(0);
  return (
    <div>
      <PageHeader title="Change Log" description="Every approved change with its lifecycle, plus week-over-week organic traffic markers for context." actions={<JobButton type="process-changes" label="Process approved changes" onDone={() => setK((x) => x + 1)} />} />
      <Tabs tabs={[{ id: 'timeline', label: 'Timeline' }, { id: 'changes', label: 'Changes' }]} value={tab} onChange={setTab} />
      {tab === 'timeline' ? <Timeline key={k} onOpen={setOpen} /> : <ChangesTable key={k} onOpen={setOpen} />}
      {open && <ChangeDrawer id={open} onClose={() => setOpen(null)} onChanged={() => setK((x) => x + 1)} />}
    </div>
  );
}
