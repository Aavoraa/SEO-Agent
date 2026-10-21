import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, Circle } from 'lucide-react';
import type { Overview, SetupStatus } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { deltaPct, fmtCtr, fmtDate, fmtNum, fmtPos, fmtRelative, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { KpiCard } from '../components/KpiCard';
import { Card, DaysSelector, ErrorBox, Loading } from '../components/ui';
import { ClicksImpressionsChart, SimpleBarChart, SingleLineChart } from '../components/charts';
import { Pill, PriorityBadge, SeverityBadge, StatusPill } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

const signed = (v: number | null, digits = 1, suffix = '') => (v == null ? null : `${v > 0 ? '+' : ''}${v.toFixed(digits)}${suffix}`);

function SetupChecklist({ setup }: { setup: SetupStatus }) {
  const done = setup.steps.filter((s) => s.done).length;
  return (
    <Card title="Finish setting up" subtitle={`${done} of ${setup.steps.length} steps complete`} className="mb-5 border-brand-200" actions={<Link to="/settings" className="link text-xs font-medium">Open settings</Link>}>
      <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full bg-brand-500" style={{ width: `${(done / Math.max(1, setup.steps.length)) * 100}%` }} />
      </div>
      <ul className="grid gap-2 md:grid-cols-2">
        {setup.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-sm">
            {s.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-gray-300" />}
            <span>
              <span className={s.done ? 'text-gray-500' : 'font-medium text-gray-900'}>{s.label}</span>
              {s.detail && <span className="block text-xs text-gray-500">{s.detail}</span>}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function OverviewPage() {
  const [days, setDays] = useState(28);
  const { data, error, loading, reload } = useProjectApi<Overview>('/overview', { days });
  const setup = useProjectApi<SetupStatus>('/setup-status');

  const series = useMemo(() => {
    if (!data) return [];
    const start = data.period?.start;
    return start ? data.series.filter((p) => p.date >= start) : data.series;
  }, [data]);

  return (
    <div>
      <PageHeader
        title="Overview"
        description={data?.period ? `${fmtDate(data.period.start)} – ${fmtDate(data.period.end)} compared with the previous ${days} days` : 'Organic search performance and site health at a glance'}
        actions={<DaysSelector value={days} onChange={setDays} />}
      />
      {setup.data && !setup.data.complete && <SetupChecklist setup={setup.data} />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 2xl:grid-cols-8">
            <KpiCard
              label="SEO Health"
              value={data.health?.score != null ? `${data.health.score}` : '—'}
              info={<>Internal diagnostic score – not a Google metric. {data.health?.disclaimer}</>}
              delta={data.health?.previous != null && data.health.score != null ? signed(data.health.score - data.health.previous, 0, ' pts') : null}
              deltaValue={data.health?.previous != null && data.health.score != null ? data.health.score - data.health.previous : null}
              hint={data.health?.grade ? humanize(data.health.grade) : 'Run a crawl'}
            />
            <KpiCard label="Organic Clicks" value={fmtNum(data.kpis.clicks[0])} delta={signed(deltaPct(data.kpis.clicks[0], data.kpis.clicks[1]), 1, '%')} deltaValue={deltaPct(data.kpis.clicks[0], data.kpis.clicks[1])} />
            <KpiCard label="Impressions" value={fmtNum(data.kpis.impressions[0])} delta={signed(deltaPct(data.kpis.impressions[0], data.kpis.impressions[1]), 1, '%')} deltaValue={deltaPct(data.kpis.impressions[0], data.kpis.impressions[1])} />
            <KpiCard label="CTR" value={fmtCtr(data.kpis.ctr[0])} delta={signed(data.kpis.ctr[1] != null ? (data.kpis.ctr[0] - data.kpis.ctr[1]) * 100 : null, 2, ' pp')} deltaValue={data.kpis.ctr[1] != null ? data.kpis.ctr[0] - data.kpis.ctr[1] : null} />
            <KpiCard
              label="Avg Position"
              value={fmtPos(data.kpis.position[0])}
              info="Average ranking position across all queries. Lower is better."
              lowerIsBetter
              delta={signed(data.kpis.position[1] != null ? data.kpis.position[0] - data.kpis.position[1] : null, 1)}
              deltaValue={data.kpis.position[1] != null ? data.kpis.position[0] - data.kpis.position[1] : null}
              hint="lower is better"
            />
            <KpiCard label="Indexed Pages" value={fmtNum(data.kpis.indexedPages)} hint="indexable, from last crawl" info="Pages the crawler found indexable (200, no noindex, self-canonical). Not Google's index count." />
            <KpiCard label="Critical Issues" value={fmtNum(data.counts.critical)} tone={data.counts.critical ? 'danger' : undefined} hint={`${fmtNum(data.counts.high)} high · ${fmtNum(data.counts.open_issues)} open`} />
            <KpiCard label="Pending Approvals" value={fmtNum(data.counts.pending_approvals + data.counts.pending_content)} tone={data.counts.pending_approvals ? 'warn' : undefined} hint={<Link to="/approvals" className="link">Review</Link>} />
          </div>

          {!data.hasSearchData ? (
            <EmptyState title="No Search Console data yet" description="Connect Search Console in Settings → Integrations and run a sync to see clicks, impressions and rankings." action={<Link to="/settings?tab=integrations" className="link text-sm font-medium">Connect Search Console</Link>} />
          ) : (
            <>
              <Card title="Clicks & impressions" subtitle="Daily organic Search Console data">
                <ClicksImpressionsChart data={series} />
              </Card>
              <div className="grid gap-5 lg:grid-cols-3">
                <Card title="CTR over time">
                  <SingleLineChart data={series} dataKey="ctr" name="CTR" format={(v) => `${(v * 100).toFixed(1)}%`} />
                </Card>
                <Card title="Average position" subtitle="Lower is better (axis reversed)">
                  <SingleLineChart data={series} dataKey="position" name="Avg position" reversed format={(v) => v.toFixed(1)} />
                </Card>
                <Card title="Ranking distribution" subtitle="Queries by average position">
                  <SimpleBarChart data={data.rankingDistribution} xKey="bucket" yKey="queries" name="Queries" height={200} />
                </Card>
              </div>
            </>
          )}

          <div className="grid gap-5 lg:grid-cols-3">
            <Card title="Top opportunities" className="lg:col-span-2" bodyClassName="p-0" actions={<Link to="/recommendations" className="link text-xs font-medium">All recommendations</Link>}>
              {data.topOpportunities.length ? (
                <ul className="divide-y divide-gray-100">
                  {data.topOpportunities.map((o) => (
                    <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="w-8 text-right text-sm font-semibold tabular text-gray-900">{Math.round(o.priority_score)}</span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm text-gray-900">{o.title}</div>
                        <div className="text-xs text-gray-500">
                          {humanize(o.type)} · {pathOf(o.page_url)}
                        </div>
                      </div>
                      <PriorityBadge priority={o.priority} />
                      <StatusPill status={o.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="p-4">
                  <EmptyState compact title="No opportunities yet" description="Run a crawl and keyword analysis to generate prioritised recommendations." action={<JobButton type="crawl" label="Run crawl" onDone={reload} />} />
                </div>
              )}
            </Card>
            <Card title="Open alerts" bodyClassName="p-0" actions={<Link to="/alerts" className="link text-xs font-medium">All alerts</Link>}>
              {data.alerts.length ? (
                <ul className="divide-y divide-gray-100">
                  {data.alerts.map((a) => (
                    <li key={a.id} className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        <SeverityBadge severity={a.severity} />
                        <span className="text-xs text-gray-500">{fmtRelative(a.created_at)}</span>
                      </div>
                      <p className="mt-1 text-sm text-gray-900">{a.title}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-6 text-center text-sm text-gray-500">No open alerts.</p>
              )}
            </Card>
          </div>

          <Card
            title={
              <span className="inline-flex items-center gap-2">
                AI-assisted summary
                {data.aiSummary?.summary?.includes('[DEMO – mock AI]') && <Pill tone="amber">mock</Pill>}
              </span>
            }
            subtitle={data.aiSummary ? `Model: ${data.aiSummary.model}${data.aiSummary.cached ? ' · cached' : ''} · review before acting` : undefined}
          >
            {data.aiSummary ? (
              <div className="space-y-4">
                <p className="text-sm leading-relaxed text-gray-800">{data.aiSummary.summary.replace('[DEMO – mock AI] ', '')}</p>
                <div className="grid gap-4 md:grid-cols-3">
                  {data.aiSummary.topPriorities && data.aiSummary.topPriorities.length > 0 && (
                    <div className="md:col-span-2">
                      <h3 className="mb-2 text-xs font-semibold tracking-wide text-gray-500 uppercase">Top priorities</h3>
                      <ol className="space-y-2">
                        {data.aiSummary.topPriorities.map((p, i) => (
                          <li key={i} className="rounded-md border border-gray-200 p-3 text-sm">
                            <div className="font-medium text-gray-900">
                              {i + 1}. {p.what}
                            </div>
                            <div className="mt-0.5 text-xs text-gray-600">
                              {p.why} · Evidence: {p.evidence} · Risk {p.risk} · Effort {p.effort}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  <div className="space-y-4">
                    {data.aiSummary.quickWins && data.aiSummary.quickWins.length > 0 && (
                      <div>
                        <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-gray-500 uppercase">Quick wins</h3>
                        <ul className="list-disc space-y-1 pl-4 text-sm text-gray-800">
                          {data.aiSummary.quickWins.map((q, i) => (
                            <li key={i}>{q}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {data.aiSummary.watchouts && data.aiSummary.watchouts.length > 0 && (
                      <div>
                        <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-gray-500 uppercase">Watch-outs</h3>
                        <ul className="list-disc space-y-1 pl-4 text-sm text-gray-800">
                          {data.aiSummary.watchouts.map((q, i) => (
                            <li key={i}>{q}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-500">No AI summary yet – it is generated after a crawl when an AI provider is configured.</p>
            )}
          </Card>
          <div className="flex items-center justify-end gap-1 text-xs text-gray-400">
            Health score last computed {fmtRelative(data.health?.crawledAt)} <ArrowRight className="h-3 w-3" /> <Link to="/issues" className="link">see issues</Link>
          </div>
        </div>
      )}
    </div>
  );
}
