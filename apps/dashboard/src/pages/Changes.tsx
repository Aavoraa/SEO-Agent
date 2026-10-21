import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, PlugZap, Rocket, RotateCcw } from 'lucide-react';
import { api } from '../api/client';
import type { ChangeRequest, ChangeRequestStatus, DeploymentRow, DeploymentSettings } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useApi, useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { fmtDateTime, fmtRelative, humanize, isCodeLike, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Field, Loading, Tabs } from '../components/ui';
import { Pill, RiskBadge, type Tone } from '../components/Badges';
import { DataTable, type Column } from '../components/DataTable';
import { Modal } from '../components/Overlay';
import { DeploymentProgress, DeploymentStatusPill, WordDiff } from '../components/ChangeWorkflow';
import { ValueBox } from '../components/RecommendationCard';

const TONE: Record<ChangeRequestStatus, Tone> = {
  DRAFT: 'gray',
  PENDING_APPROVAL: 'amber',
  APPROVED: 'blue',
  REJECTED: 'red',
  DEPLOYING: 'blue',
  DEPLOYED: 'blue',
  VERIFIED: 'green',
  FAILED: 'red',
  VERIFICATION_FAILED: 'orange',
  ROLLED_BACK: 'dark',
};

type Filter = 'all' | 'pending' | 'approved' | 'live' | 'failed' | 'rolled_back' | 'rejected';
const FILTERS: Record<Filter, ChangeRequestStatus[] | null> = {
  all: null,
  pending: ['DRAFT', 'PENDING_APPROVAL'],
  approved: ['APPROVED', 'DEPLOYING'],
  live: ['DEPLOYED', 'VERIFIED'],
  failed: ['FAILED', 'VERIFICATION_FAILED'],
  rolled_back: ['ROLLED_BACK'],
  rejected: ['REJECTED'],
};
const DEPLOYABLE = ['title', 'meta_description', 'h1', 'canonical', 'schema', 'other'];

export function ConnectionBanner({ s }: { s: DeploymentSettings | null }) {
  if (!s) return null;
  const live = s.mode === 'live';
  const ok = s.mode === 'demo' ? s.configured : s.configured && (!s.fileBased || s.connected);
  return (
    <div className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-xs ${s.mode === 'demo' ? 'border-violet-200 bg-violet-50 text-violet-900' : ok && s.liveEnabled ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
      <PlugZap className="h-3.5 w-3.5" />
      {s.mode === 'demo' ? (
        <span><strong>DEMO MODE</strong> – deployments go to a local copy of the site; the real website is never touched.</span>
      ) : !s.configured ? (
        <span><strong>NOT CONNECTED</strong> – {s.missing.join(', ')}.</span>
      ) : !s.fileBased ? (
        <span><strong>{s.description}</strong> – approved changes are implemented through this adapter.</span>
      ) : !s.connected ? (
        <span><strong>Connection not tested</strong> – {s.description}.</span>
      ) : live && !s.liveEnabled ? (
        <span><strong>Connected, live deployment OFF</strong> – {s.description}. An admin must switch it on.</span>
      ) : (
        <span><strong>LIVE deployment ON</strong> – {s.description} (enabled by {s.liveEnabledBy} {fmtRelative(s.liveEnabledAt)}).</span>
      )}
      <Link to="/settings?tab=deployment" className="ml-auto font-medium underline">Deployment settings</Link>
    </div>
  );
}

function ChangeDetail({ c, settings, onChanged }: { c: ChangeRequest; settings: DeploymentSettings | null; onChanged: () => void }) {
  const { base } = useProject();
  const { canEdit, isAdmin } = useAuth();
  const { busy, run } = useAction();
  const deps = useApi<DeploymentRow[]>(c.changeId ? `${base}/deployments` : null, { changeId: c.changeId ?? undefined });
  const [running, setRunning] = useState<string | null>(null);
  const [rollback, setRollback] = useState(false);
  const [reason, setReason] = useState('');
  const textual = !!c.oldValue && !!c.newValue && !isCodeLike(c.oldValue) && !isCodeLike(c.newValue);
  const canDeploy = canEdit && c.changeId && ['APPROVED', 'FAILED', 'VERIFICATION_FAILED'].includes(c.status) && DEPLOYABLE.includes(c.changeType) && !!c.newValue && settings?.fileBased;
  const latest = deps.data?.[0];
  const reload = () => {
    deps.reload();
    onChanged();
  };
  return (
    <div className="space-y-3 bg-gray-50/60 px-4 py-3">
      <div className="grid gap-3 md:grid-cols-2">
        <ValueBox label="Before" value={c.oldValue} tone="old" />
        <ValueBox label="After" value={c.newValue} tone="new" />
      </div>
      {textual && <WordDiff before={c.oldValue} after={c.newValue} />}
      {c.aiReason && <p className="text-xs text-gray-600"><strong>Reason:</strong> {c.aiReason}</p>}
      <div className="flex flex-wrap gap-2">
        {c.kind === 'recommendation' && <Link to="/approvals" className="text-xs font-medium text-brand-700 hover:underline">Review in Approvals →</Link>}
        {canDeploy && (
          <Button size="sm" variant="primary" icon={<Rocket className="h-3.5 w-3.5" />} loading={busy === 'deploy'} onClick={() => run('deploy', () => api<{ deploymentId: string }>(`${base}/changes/${c.changeId}/deploy`, { method: 'POST' })).then((r) => r && setRunning(r.deploymentId))}>
            {c.status === 'APPROVED' ? 'Deploy' : 'Retry deployment'}
          </Button>
        )}
        {isAdmin && c.changeId && c.rollbackAvailable && c.status !== 'ROLLED_BACK' && (
          <Button size="sm" variant="danger" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setRollback(true)}>
            Rollback
          </Button>
        )}
      </div>
      {running && <DeploymentProgress deploymentId={running} onDone={() => { setRunning(null); reload(); }} />}
      {!running && latest && (
        <div className="space-y-2">
          <DeploymentProgress key={latest.id} deploymentId={latest.id} />
          {deps.data && deps.data.length > 1 && (
            <details className="text-xs">
              <summary className="cursor-pointer font-medium text-gray-600">Earlier attempts ({deps.data.length - 1})</summary>
              <ul className="mt-1 space-y-1">
                {deps.data.slice(1).map((d) => (
                  <li key={d.id} className="flex items-center gap-2">
                    <span className="font-mono">{d.id.slice(0, 8)}</span> {humanize(d.action)} <DeploymentStatusPill status={d.status} /> {fmtDateTime(d.deployment_started_at)} {d.error_message && <span className="text-red-700">{d.error_message}</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      <Modal
        open={rollback}
        onClose={() => setRollback(false)}
        title="Roll back this change?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRollback(false)}>Cancel</Button>
            <Button
              variant="danger"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              loading={busy === 'rollback'}
              onClick={() =>
                run('rollback', () => api<{ message: string; verified?: boolean }>(`${base}/changes/${c.changeId}/rollback`, { body: { reason: reason.trim() || undefined } }), (r) => `Rolled back – ${r.message}${r.verified === false ? ' (verification pending)' : ''}`).then((r) => {
                  if (r) {
                    setRollback(false);
                    reload();
                  }
                })
              }
            >
              Confirm rollback
            </Button>
          </>
        }
        width="max-w-2xl"
      >
        <div className="space-y-3 text-sm">
          <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-gray-500">Affected page</dt><dd className="font-mono">{c.page}</dd>
            <dt className="text-gray-500">Change</dt><dd>{humanize(c.changeType)} · {c.changeId?.slice(0, 8)}</dd>
            <dt className="text-gray-500">Deployment</dt><dd className="font-mono">{c.deployment?.id ?? 'adapter / manual'}</dd>
          </dl>
          <div className="grid gap-3 md:grid-cols-2">
            <ValueBox label="Current version (will be removed)" value={c.newValue} tone="old" />
            <ValueBox label="Previous version (will be restored)" value={c.oldValue} tone="new" />
          </div>
          <Field label="Reason (audit trail)">
            <input className="input w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. CTR dropped after the change" />
          </Field>
          <p className="text-xs text-gray-500">The backup is restored (or, if the file was edited since, only this element is reverted), then the page is re-crawled, verified and the audit re-scored.</p>
        </div>
      </Modal>
    </div>
  );
}

export function ChangesPage() {
  const { data, error, loading, reload } = useProjectApi<ChangeRequest[]>('/change-requests');
  const settings = useProjectApi<DeploymentSettings>('/deployment');
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(() => (data ?? []).filter((c) => !FILTERS[filter] || FILTERS[filter]!.includes(c.status)), [data, filter]);
  const count = (f: Filter) => (data ?? []).filter((c) => !FILTERS[f] || FILTERS[f]!.includes(c.status)).length;

  const cols: Column<ChangeRequest>[] = [
    { key: 'id', header: 'ID', render: (r) => <span className="font-mono text-[11px] text-gray-500">{(r.changeId ?? r.id).slice(0, 8)}</span> },
    { key: 'page', header: 'Page', sort: (r) => r.page ?? '', render: (r) => <span className="font-mono text-xs">{r.page ? pathOf(r.page) : 'site-wide'}</span> },
    { key: 'type', header: 'Change', sort: (r) => r.changeType, render: (r) => <span className="text-xs">{humanize(r.changeType)}</span> },
    { key: 'new', header: 'New value', render: (r) => <span className="block max-w-xs truncate text-xs text-gray-700" title={r.newValue ?? ''}>{r.newValue ?? '—'}</span> },
    { key: 'risk', header: 'Risk', sort: (r) => r.risk ?? '', render: (r) => <RiskBadge risk={r.risk} /> },
    { key: 'conf', header: 'Confidence', render: (r) => <span className="text-xs">{r.confidence ? humanize(r.confidence) : '—'}</span> },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <Pill tone={TONE[r.status]}>{r.status.replace('_', ' ')}</Pill> },
    { key: 'verify', header: 'Verification', render: (r) => (r.verificationStatus === 'passed' ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : r.verificationStatus === 'failed' ? <AlertTriangle className="h-4 w-4 text-orange-600" /> : <span className="text-xs text-gray-400">—</span>) },
    { key: 'by', header: 'Created by', render: (r) => <span className="text-xs text-gray-600">{r.createdBy}</span> },
    { key: 'approved', header: 'Approved', sort: (r) => r.approvedAt ?? '', render: (r) => (r.approvedBy ? <span className="text-xs">{r.approvedBy}<br /><span className="text-gray-400">{fmtDateTime(r.approvedAt)}</span></span> : <span className="text-xs text-gray-400">—</span>) },
    { key: 'updated', header: 'Updated', sort: (r) => r.updatedAt, render: (r) => <span className="text-xs text-gray-500">{fmtRelative(r.updatedAt)}</span> },
  ];

  return (
    <div>
      <PageHeader title="Changes" description="Every proposed and completed website change: approval, deployment, verification and rollback." />
      <div className="space-y-4">
        <ConnectionBanner s={settings.data} />
        {error && <ErrorBox error={error} onRetry={reload} />}
        {!data && loading && <Loading />}
        {data && (
          <Card bodyClassName="p-0">
            <div className="px-4 pt-2">
              <Tabs<Filter>
                value={filter}
                onChange={setFilter}
                tabs={[
                  { id: 'all', label: 'All', count: count('all') },
                  { id: 'pending', label: 'Draft / pending', count: count('pending') },
                  { id: 'approved', label: 'Approved', count: count('approved') },
                  { id: 'live', label: 'Deployed / verified', count: count('live') },
                  { id: 'failed', label: 'Failed', count: count('failed') },
                  { id: 'rolled_back', label: 'Rolled back', count: count('rolled_back') },
                  { id: 'rejected', label: 'Rejected', count: count('rejected') },
                ]}
              />
            </div>
            <DataTable className="rounded-none border-0" columns={cols} rows={rows} rowKey={(r) => `${r.kind}:${r.id}`} expand={(r) => <ChangeDetail c={r} settings={settings.data} onChanged={reload} />} maxHeight="70vh" empty={<p className="p-4 text-sm text-gray-500">No changes in this view.</p>} />
          </Card>
        )}
      </div>
    </div>
  );
}

