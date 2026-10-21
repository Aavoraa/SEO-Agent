import { useMemo, useState } from 'react';
import { Check, Download, EyeOff, Pencil, RotateCcw, X, CheckCheck } from 'lucide-react';
import { api, download } from '../api/client';
import type { Issue, IssuesResponse } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtDate, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorBox, Loading, Tooltip } from '../components/ui';
import { FilterBar, FilterField, MultiSelect, SearchFilter, SelectFilter } from '../components/FilterBar';
import { DataTable, type Column } from '../components/DataTable';
import { RiskBadge, SeverityBadge, SeverityDot, StatusPill } from '../components/Badges';
import { JsonView } from '../components/JsonView';
import { CurrentVsProposed, isHighRisk } from '../components/RecommendationCard';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
const initial = { severity: [] as string[], category: '', status: 'open', rule: '', page: '', from: '', to: '', q: '' };

function IssueDetail({ issue, onChanged }: { issue: Issue; onChanged: () => void }) {
  const { canEdit, isAdmin } = useAuth();
  const { base, refreshCounts } = useProject();
  const { busy, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(issue.proposed_value ?? '');
  const recOpen = !!issue.recommendation_id && ['recommended', 'pending_approval', 'analyzed', 'detected'].includes(issue.recommendation_status ?? '');
  const blocked = isHighRisk({ risk: issue.risk ?? 'low', type: '' }) && !isAdmin;

  const decide = (decision: 'approve' | 'reject', editedValue?: string) =>
    run(decision, () => api(`${base}/recommendations/${issue.recommendation_id}/decision`, { body: { decision, editedValue } }), decision === 'approve' ? 'Fix approved – change queued' : 'Fix rejected').then((r) => {
      if (r) {
        refreshCounts();
        onChanged();
      }
    });
  const setStatus = (status: 'open' | 'acknowledged' | 'ignored') => run(status, () => api(`${base}/issues/${issue.id}`, { method: 'PATCH', body: { status } }), `Issue marked ${status}`).then((r) => r && onChanged());

  const approve = (
    <Button size="sm" variant="success" icon={<Check className="h-3.5 w-3.5" />} loading={busy === 'approve'} disabled={!!busy || blocked} onClick={() => decide('approve')}>
      Approve Fix
    </Button>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-4">
        <div>
          <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Description</h4>
          <p className="text-sm text-gray-800">{issue.description ?? '—'}</p>
        </div>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Evidence</h4>
          <JsonView value={issue.evidence} />
        </div>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Recommendation</h4>
          <p className="text-sm text-gray-800">{issue.recommendation ?? '—'}</p>
        </div>
        <p className="text-xs text-gray-500">
          Rule <code className="rounded bg-gray-100 px-1 font-mono">{issue.rule_id}</code> · first detected {fmtDate(issue.first_detected_at)} · last seen {fmtDate(issue.last_detected_at)}
        </p>
      </div>
      <div className="space-y-3">
        {issue.recommendation_id ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Proposed fix</span>
              <StatusPill status={issue.recommendation_status} />
              <RiskBadge risk={issue.risk} />
            </div>
            {editing ? (
              <div className="space-y-2">
                <textarea className="input w-full font-mono text-xs" rows={8} value={edited} onChange={(e) => setEdited(e.target.value)} aria-label="Edited value" />
                <div className="flex gap-2">
                  <Button size="sm" variant="success" loading={busy === 'approve'} disabled={!edited.trim()} onClick={() => decide('approve', edited)}>
                    Approve edited value
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <CurrentVsProposed current={issue.current_value} proposed={issue.proposed_value} />
            )}
          </>
        ) : (
          <p className="text-sm text-gray-500">No recommendation is linked to this issue yet.</p>
        )}
        {canEdit && (
          <div className="flex flex-wrap gap-2 border-t border-gray-200 pt-3">
            {recOpen && !editing && (
              <>
                {blocked ? <Tooltip content="Admin approval required">{approve}</Tooltip> : approve}
                <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={busy === 'reject'} disabled={!!busy} onClick={() => decide('reject')}>
                  Reject
                </Button>
                <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} disabled={!!busy || blocked} onClick={() => { setEdited(issue.proposed_value ?? issue.current_value ?? ''); setEditing(true); }}>
                  Edit
                </Button>
                <span className="mx-1 w-px self-stretch bg-gray-200" />
              </>
            )}
            {issue.status !== 'acknowledged' && issue.status !== 'resolved' && (
              <Button size="sm" variant="ghost" icon={<CheckCheck className="h-3.5 w-3.5" />} loading={busy === 'acknowledged'} onClick={() => setStatus('acknowledged')}>
                Acknowledge
              </Button>
            )}
            {issue.status !== 'ignored' && issue.status !== 'resolved' && (
              <Button size="sm" variant="ghost" icon={<EyeOff className="h-3.5 w-3.5" />} loading={busy === 'ignored'} onClick={() => setStatus('ignored')}>
                Ignore
              </Button>
            )}
            {(issue.status === 'ignored' || issue.status === 'acknowledged') && (
              <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={busy === 'open'} onClick={() => setStatus('open')}>
                Reopen
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function IssuesPage() {
  const [f, setF] = useState(initial);
  const { base } = useProject();
  const { run, busy } = useAction();
  const query = { severity: f.severity.join(','), category: f.category, status: f.status, rule: f.rule, page: f.page, from: f.from, to: f.to, q: f.q, limit: 500 };
  const { data, error, loading, reload } = useProjectApi<IssuesResponse>('/issues', query);

  const sevCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of data?.summary ?? []) m[s.severity] = (m[s.severity] ?? 0) + s.n;
    return m;
  }, [data]);
  const categories = useMemo(() => [...new Set((data?.rules ?? []).map((r) => r.category))].sort(), [data]);
  const rules = useMemo(() => (data?.rules ?? []).filter((r) => !f.category || r.category === f.category), [data, f.category]);

  const cols: Column<Issue>[] = [
    { key: 'severity', header: 'Severity', sort: (r) => SEVERITIES.indexOf(r.severity), render: (r) => <SeverityBadge severity={r.severity} />, width: '110px' },
    {
      key: 'title',
      header: 'Issue',
      sort: (r) => r.title,
      render: (r) => (
        <div className="min-w-0">
          <div className="font-medium text-gray-900">{r.title}</div>
          <div className="text-xs text-gray-500">{humanize(r.category)} · {r.rule_id}</div>
        </div>
      ),
    },
    { key: 'url', header: 'Page', sort: (r) => r.url, render: (r) => <span className="font-mono text-xs whitespace-nowrap text-gray-600">{pathOf(r.url)}</span> },
    { key: 'fix', header: 'Fix', render: (r) => (r.recommendation_id ? <StatusPill status={r.recommendation_status} /> : <span className="text-xs text-gray-400">—</span>) },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
    { key: 'last', header: 'Last seen', sort: (r) => r.last_detected_at, render: (r) => <span className="text-xs text-gray-600">{fmtDate(r.last_detected_at)}</span> },
  ];

  return (
    <div>
      <PageHeader
        title="SEO Issues"
        description="Deterministic rule checks from the latest crawl. Expand a row for evidence and the proposed fix."
        actions={
          <>
            <JobButton type="crawl" label="Run crawl" onDone={reload} />
            <Button icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'csv'} onClick={() => run('csv', () => download(`${base}/issues`, 'seo-issues.csv', { ...query, format: 'csv' }))}>
              Export CSV
            </Button>
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {SEVERITIES.map((s) => (
          <button
            key={s}
            onClick={() => setF((x) => ({ ...x, severity: x.severity.length === 1 && x.severity[0] === s ? [] : [s] }))}
            className={cx('card flex items-center justify-between px-3 py-2 text-left transition-colors hover:border-gray-300', f.severity.includes(s) && 'border-brand-500 ring-1 ring-brand-500')}
          >
            <span className="flex items-center gap-2 text-xs font-medium text-gray-600">
              <SeverityDot severity={s} /> {humanize(s)}
            </span>
            <span className="text-lg font-semibold tabular text-gray-900">{sevCounts[s] ?? 0}</span>
          </button>
        ))}
      </div>
      <p className="-mt-2 mb-3 text-[11px] text-gray-400">Counts are open issues across the project; the table below reflects your filters.</p>
      <FilterBar onReset={() => setF(initial)}>
        <MultiSelect label="Severity" values={f.severity} onChange={(v) => setF({ ...f, severity: v })} options={SEVERITIES.map((s) => ({ value: s, label: humanize(s) }))} />
        <SelectFilter label="Category" value={f.category} onChange={(v) => setF({ ...f, category: v, rule: '' })} options={categories.map((c) => ({ value: c, label: humanize(c) }))} />
        <SelectFilter label="Status" value={f.status} allLabel={null} onChange={(v) => setF({ ...f, status: v })} options={['open', 'acknowledged', 'ignored', 'resolved', 'all'].map((s) => ({ value: s, label: humanize(s) }))} />
        <SelectFilter label="Rule" value={f.rule} onChange={(v) => setF({ ...f, rule: v })} options={rules.map((r) => ({ value: r.id, label: r.title }))} className="max-w-56" />
        <SearchFilter label="Page contains" value={f.page} onChange={(v) => setF({ ...f, page: v })} placeholder="/services" />
        <FilterField label="From">
          <input type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </FilterField>
        <FilterField label="To">
          <input type="date" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </FilterField>
        <SearchFilter value={f.q} onChange={(v) => setF({ ...f, q: v })} placeholder="Title or description" />
      </FilterBar>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
            {data.items.length} issue{data.items.length === 1 ? '' : 's'} {loading && '· refreshing…'}
          </div>
          <DataTable
            columns={cols}
            rows={data.items}
            rowKey={(r) => r.id}
            expand={(r) => <IssueDetail issue={r} onChanged={reload} />}
            empty={<EmptyState title="No issues match these filters" description="Try widening the filters, or run a crawl to detect issues on the latest version of the site." />}
          />
        </>
      )}
    </div>
  );
}
