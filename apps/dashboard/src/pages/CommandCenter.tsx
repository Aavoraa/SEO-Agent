import { Link } from 'react-router-dom';
import { ArrowDownRight, ArrowUpRight, PlugZap } from 'lucide-react';
import { api } from '../api/client';
import { OPPORTUNITY_CATEGORY_LABEL, type CcMetric, type CommandCenterData, type OpportunityCategory } from '../api/types';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtNum, fmtRelative } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { ErrorBox, Loading, Tooltip } from '../components/ui';
import { Pill } from '../components/Badges';
import { JobButton } from '../components/JobButton';
import { DataLabel } from '../components/DataLabel';
import { CATEGORY_TONE, ClosedLoop, NextBestActionCard, OpportunityCard } from '../components/Opportunity';

function MetricTile({ m }: { m: CcMetric }) {
  const delta = m.value !== null && m.previous !== null ? m.value - m.previous : null;
  const body = (
    <div className={cx('card flex h-full flex-col gap-1 px-3.5 py-3', m.value === null && 'bg-gray-50/70')}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-600">{m.label}</span>
        <DataLabel label={m.dataLabel} />
      </div>
      {m.value === null ? (
        <span className="mt-1 inline-flex items-center gap-1 text-sm text-gray-500"><PlugZap className="h-3.5 w-3.5" /> {m.note ?? 'Unavailable'}</span>
      ) : (
        <div className="flex items-end gap-2">
          <span className="text-2xl leading-none font-semibold tabular text-gray-900">{fmtNum(m.value)}{m.unit && <span className="text-sm font-normal text-gray-400">{m.unit}</span>}</span>
          {delta !== null && delta !== 0 && (
            <span className={cx('inline-flex items-center text-xs font-medium', delta > 0 ? 'text-emerald-700' : 'text-red-700')}>
              {delta > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {delta > 0 ? '+' : ''}{fmtNum(delta)}
            </span>
          )}
        </div>
      )}
      <span className="mt-auto truncate text-[11px] text-gray-400" title={m.source}>{m.source}{m.updatedAt ? ` · ${fmtRelative(m.updatedAt)}` : ''}</span>
    </div>
  );
  return m.href ? <Link to={m.href}>{m.note && m.value !== null ? <Tooltip content={m.note}>{body}</Tooltip> : body}</Link> : body;
}

export function CommandCenterPage() {
  const { base, project } = useProject();
  const { data, error, loading, reload } = useProjectApi<CommandCenterData>('/command-center');
  const { run } = useAction();
  const setStatus = (id: string, status: 'dismissed' | 'snoozed' | 'in_progress') => run(status, () => api(`${base}/opportunities/${id}`, { method: 'PATCH', body: { status } }), status === 'dismissed' ? 'Dismissed – it stays dismissed on refresh' : 'Snoozed for 14 days').then((r) => r && reload());
  return (
    <div>
      <PageHeader
        title="Command Center"
        description={`What matters most for ${project?.name ?? 'this website'} right now – from its own data.`}
        actions={
          <span className="flex gap-2">
            <JobButton type="opportunities" label="Refresh opportunities" onDone={reload} hideStatus />
            <JobButton type="seo-audit" body={{ device: 'desktop' }} label="Run audit" variant="primary" onDone={reload} hideStatus />
          </span>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <NextBestActionCard nba={data.nextBestAction} />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {data.metrics.map((m) => <MetricTile key={m.key} m={m} />)}
          </div>
          <ClosedLoop loop={data.loop} automationLevel={data.project.automationLevel} />
          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-semibold text-gray-900">Top opportunities</h2>
              {(Object.entries(data.categoryCounts) as [OpportunityCategory, number][]).map(([k, n]) => (
                <Link key={k} to={`/opportunities?category=${k}`}><Pill tone={CATEGORY_TONE[k]}>{OPPORTUNITY_CATEGORY_LABEL[k]} · {n}</Pill></Link>
              ))}
              <Link to="/opportunities" className="ml-auto text-xs font-medium text-brand-700 hover:underline">All opportunities →</Link>
            </div>
            {data.opportunities.length === 0 ? (
              <p className="card px-4 py-6 text-sm text-gray-500">No open opportunities yet. Run an audit to discover them.</p>
            ) : (
              <div className="grid gap-3 xl:grid-cols-2">
                {data.opportunities.slice(1).map((o) => <OpportunityCard key={o.id} o={o} onStatus={(s) => setStatus(o.id, s)} />)}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
