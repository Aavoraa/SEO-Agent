import { Info } from 'lucide-react';
import type { Experiment } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { fmtCtr, fmtDate, fmtNum, fmtPos, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { ErrorBox, Loading } from '../components/ui';
import { Pill, StatusPill } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

const CAVEAT = 'Results show correlation, not causation: seasonality, Google algorithm updates and other site changes can also move these metrics.';

type Metrics = { clicks?: number; impressions?: number; ctr?: number; position?: number };

function MetricCell({ label, m }: { label: string; m: Metrics | null | undefined }) {
  return (
    <div className="min-w-0 rounded-md border border-gray-200 bg-white px-3 py-2">
      <div className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase">{label}</div>
      {m ? (
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-gray-500">Clicks</dt>
          <dd className="text-right tabular">{fmtNum(m.clicks)}</dd>
          <dt className="text-gray-500">Impressions</dt>
          <dd className="text-right tabular">{fmtNum(m.impressions)}</dd>
          <dt className="text-gray-500">CTR</dt>
          <dd className="text-right tabular">{fmtCtr(m.ctr)}</dd>
          <dt className="text-gray-500">Position</dt>
          <dd className="text-right tabular">{fmtPos(m.position)}</dd>
        </dl>
      ) : (
        <p className="mt-1 text-xs text-gray-400">Pending</p>
      )}
    </div>
  );
}

export function ExperimentsPage() {
  const { data, error, loading, reload } = useProjectApi<Experiment[]>('/experiments');
  return (
    <div>
      <PageHeader title="Experiments" description="Each implemented change is monitored against a baseline for its monitoring window." actions={<JobButton type="experiments-evaluate" label="Evaluate now" onDone={reload} />} />
      <p className="mb-4 flex items-start gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
        <Info className="mt-px h-3.5 w-3.5 shrink-0" /> {CAVEAT}
      </p>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && !data.length && <EmptyState title="No experiments yet" description="An experiment starts automatically when an approved change is implemented and verified." />}
      {data && data.length > 0 && (
        <div className="space-y-3">
          {data.map((e) => {
            const r = e.result as { before?: Metrics; after?: Metrics; changePct?: number | null; direction?: string } | null;
            const baseline = (r?.before ?? e.baseline) as Metrics | null;
            return (
              <article key={e.id} className="card p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <StatusPill status={e.status} />
                      {e.change_type && <Pill>{humanize(e.change_type)}</Pill>}
                      <Pill tone="blue">Metric: {e.primary_metric.toUpperCase()}</Pill>
                      {e.baseline && (e.baseline as Record<string, unknown>).sample === true && <Pill tone="amber">sample</Pill>}
                    </div>
                    <h3 className="text-sm font-semibold text-gray-900">{e.name}</h3>
                    <p className="text-xs text-gray-500">
                      <span className="font-mono">{pathOf(e.page_url)}</span> · started {fmtDate(e.start_date)} · {e.monitor_days}-day window{e.end_date && ` · ended ${fmtDate(e.end_date)}`}
                    </p>
                    {e.hypothesis && <p className="mt-1 text-sm text-gray-700">{e.hypothesis}</p>}
                  </div>
                  {r?.changePct != null && (
                    <div className="text-right">
                      <div className={`text-lg font-semibold tabular ${r.direction === 'improved' ? 'text-emerald-700' : r.direction === 'worsened' ? 'text-red-700' : 'text-gray-700'}`}>
                        {r.changePct > 0 ? '+' : ''}
                        {r.changePct}%
                      </div>
                      <div className="text-[11px] text-gray-500">{e.primary_metric} change</div>
                    </div>
                  )}
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <MetricCell label="Baseline (before)" m={baseline} />
                  <MetricCell label="Result (after)" m={r?.after} />
                </div>
                <div className="mt-3 rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-700">
                  {e.conclusion ?? 'No conclusion yet – the monitoring window is still running.'}
                  <p className="mt-1 text-[11px] text-gray-500">{CAVEAT}</p>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
