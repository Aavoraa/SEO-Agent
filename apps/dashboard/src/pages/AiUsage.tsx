import { Info } from 'lucide-react';
import type { AiUsage } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { cx, fmtDateTime, fmtNum, fmtUsd } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Card, ErrorBox, Loading, Stat } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pill } from '../components/Badges';
import { SimpleBarChart } from '../components/charts';

export function AiUsagePage() {
  const { data, error, loading, reload } = useProjectApi<AiUsage>('/ai-usage', { days: 30 });
  const budget = data?.ai.monthlyBudgetUsd ?? 0;
  const mtd = data?.monthToDate.cost ?? 0;
  const pct = budget ? Math.min(100, (mtd / budget) * 100) : 0;

  const promptCols: Column<AiUsage['byPrompt'][number]>[] = [
    { key: 'p', header: 'Prompt', sort: (r) => r.prompt_name, render: (r) => <span className="font-mono text-xs">{r.prompt_name}</span> },
    { key: 'm', header: 'Model', render: (r) => <span className="text-xs">{r.provider} / {r.model}</span> },
    { key: 'c', header: 'Calls', align: 'right', sort: (r) => r.calls, render: (r) => fmtNum(r.calls) },
    { key: 'h', header: 'Cache hits', align: 'right', sort: (r) => r.cache_hits, render: (r) => fmtNum(r.cache_hits) },
    { key: 'f', header: 'Failures', align: 'right', sort: (r) => r.failures, render: (r) => <span className={r.failures ? 'text-red-700' : ''}>{fmtNum(r.failures)}</span> },
    { key: 'i', header: 'Input tokens', align: 'right', sort: (r) => r.input_tokens, render: (r) => fmtNum(r.input_tokens) },
    { key: 'o', header: 'Output tokens', align: 'right', sort: (r) => r.output_tokens, render: (r) => fmtNum(r.output_tokens) },
    { key: 'cost', header: 'Est. cost', align: 'right', sort: (r) => r.cost, render: (r) => fmtUsd(r.cost) },
  ];
  const recentCols: Column<AiUsage['recent'][number]>[] = [
    { key: 't', header: 'Time', sort: (r) => r.created_at, render: (r) => <span className="text-xs whitespace-nowrap">{fmtDateTime(r.created_at)}</span> },
    { key: 'p', header: 'Prompt', render: (r) => <span className="font-mono text-xs">{r.prompt_name}</span> },
    { key: 'm', header: 'Model', render: (r) => <span className="text-xs">{r.model}</span> },
    { key: 'tok', header: 'Tokens in / out', align: 'right', render: (r) => `${fmtNum(r.input_tokens)} / ${fmtNum(r.output_tokens)}` },
    { key: 'cache', header: 'Cached', render: (r) => (r.cached ? <Pill tone="green">cache</Pill> : <span className="text-xs text-gray-400">—</span>) },
    { key: 'ms', header: 'Duration', align: 'right', render: (r) => `${fmtNum(r.duration_ms)} ms` },
    { key: 'cost', header: 'Est. cost', align: 'right', render: (r) => fmtUsd(r.estimated_cost_usd) },
    { key: 's', header: 'Result', render: (r) => (r.success ? <Pill tone="green">OK</Pill> : <Pill tone="red" title={r.error ?? ''}>Failed</Pill>) },
  ];

  return (
    <div>
      <PageHeader title="AI Usage" description="Every AI call is logged with tokens and an estimated cost. Last 30 days unless noted." />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <p className="flex items-center gap-1.5 text-xs text-gray-500">
            <Info className="h-3.5 w-3.5" /> {data.note}
          </p>
          <div className="grid gap-3 md:grid-cols-5">
            <div className="card px-4 py-3 md:col-span-2">
              <div className="text-xs font-medium text-gray-500">Month-to-date estimated cost vs budget</div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular">{fmtUsd(mtd)}</span>
                <span className="text-sm text-gray-500">of {fmtUsd(budget)}</span>
              </div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                <div className={cx('h-full rounded-full', pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-brand-500')} style={{ width: `${Math.max(pct, mtd > 0 ? 1 : 0)}%` }} />
              </div>
              <div className="mt-1 text-xs text-gray-500">
                Provider <strong>{data.ai.provider}</strong> · model <strong>{data.ai.model}</strong>
                {data.ai.lightModel && <> · light model {data.ai.lightModel}</>}
              </div>
            </div>
            <Stat label="Calls (30d)" value={fmtNum(data.totals.calls)} />
            <Stat label="Tokens (30d)" value={fmtNum(data.totals.input_tokens + data.totals.output_tokens)} hint={`${fmtNum(data.totals.input_tokens)} in · ${fmtNum(data.totals.output_tokens)} out`} />
            <Stat label="Cache hit rate" value={`${(data.totals.cache_hit_rate * 100).toFixed(0)}%`} hint={`Est. ${fmtUsd(data.totals.cost)} in 30d`} />
          </div>
          <Card title="Estimated cost by day (USD)">
            {data.byDay.length ? <SimpleBarChart data={data.byDay.map((d) => ({ ...d, date: d.day }))} xKey="day" yKey="cost" name="Est. cost (USD)" height={220} /> : <p className="text-sm text-gray-500">No AI calls in this period.</p>}
          </Card>
          <Card title="By prompt" bodyClassName="p-0">
            <DataTable className="rounded-none border-0" dense columns={promptCols} rows={data.byPrompt} rowKey={(r) => `${r.prompt_name}|${r.model}`} empty={<p className="p-4 text-sm text-gray-500">No calls yet.</p>} />
          </Card>
          <Card title="Recent calls" bodyClassName="p-0">
            <DataTable className="rounded-none border-0" dense columns={recentCols} rows={data.recent} rowKey={(r) => `${r.created_at}|${r.prompt_name}`} maxHeight="480px" empty={<p className="p-4 text-sm text-gray-500">No calls yet.</p>} />
          </Card>
        </div>
      )}
    </div>
  );
}
