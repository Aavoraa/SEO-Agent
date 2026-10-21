import { useState } from 'react';
import type { Performance, PeriodRow } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { cx, deltaPct, fmtCtr, fmtDate, fmtNum, fmtPos, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Card, DaysSelector, ErrorBox, Loading } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { TrendBadge } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { SimpleBarChart } from '../components/charts';

function Delta({ value, suffix = '%', invert, digits = 1 }: { value: number | null | undefined; suffix?: string; invert?: boolean; digits?: number }) {
  if (value == null || Number.isNaN(value)) return <span className="text-gray-400">—</span>;
  const good = value === 0 ? null : invert ? value < 0 : value > 0;
  return <span className={cx('tabular text-xs font-medium', good === null ? 'text-gray-500' : good ? 'text-emerald-700' : 'text-red-700')}>{`${value > 0 ? '+' : ''}${value.toFixed(digits)}${suffix}`}</span>;
}

function queryCols(keyHeader: string, isPage = false): Column<PeriodRow>[] {
  return [
    {
      key: 'key',
      header: keyHeader,
      sort: (r) => r.key,
      render: (r) =>
        isPage ? (
          <a href={r.key} target="_blank" rel="noopener noreferrer" className="text-gray-900 hover:text-brand-700 hover:underline">
            {pathOf(r.key)}
          </a>
        ) : (
          <span className="text-gray-900">{r.key}</span>
        ),
    },
    { key: 'clicks', header: 'Clicks', align: 'right', sort: (r) => r.clicks, render: (r) => fmtNum(r.clicks) },
    { key: 'dc', header: 'Δ clicks', align: 'right', sort: (r) => r.clicksChangePct, render: (r) => <Delta value={r.clicksChangePct} /> },
    { key: 'impressions', header: 'Impr.', align: 'right', sort: (r) => r.impressions, render: (r) => fmtNum(r.impressions) },
    { key: 'ctr', header: 'CTR', align: 'right', sort: (r) => r.ctr, render: (r) => fmtCtr(r.ctr) },
    { key: 'position', header: 'Pos.', align: 'right', sort: (r) => r.position, render: (r) => fmtPos(r.position) },
    { key: 'dp', header: 'Δ pos.', align: 'right', sort: (r) => r.positionChange, render: (r) => <Delta value={r.positionChange} suffix="" invert /> },
    { key: 'trend', header: 'Trend', render: (r) => <TrendBadge trend={r.trend} /> },
  ];
}

export function PerformancePage() {
  const [days, setDays] = useState(28);
  const { data, error, loading, reload } = useProjectApi<Performance>('/performance', { days });

  const pageCols: Column<PeriodRow>[] = [
    ...queryCols('Page', true).slice(0, 7),
    { key: 'sessions', header: 'GA4 sessions', align: 'right', sort: (r) => r.analytics?.sessions, render: (r) => fmtNum(r.analytics?.sessions) },
    { key: 'engaged', header: 'Engaged', align: 'right', sort: (r) => r.analytics?.engaged, render: (r) => fmtNum(r.analytics?.engaged) },
    { key: 'conv', header: 'Conversions', align: 'right', sort: (r) => r.analytics?.conversions, render: (r) => fmtNum(r.analytics?.conversions) },
  ];

  return (
    <div>
      <PageHeader title="Performance" description="Search Console queries and pages, compared with the previous period. GA4 organic engagement where connected." actions={<DaysSelector value={days} onChange={setDays} />} />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && !data.period && <EmptyState title="No Search Console data" description="Connect Search Console in Settings → Integrations, then run a GSC sync." />}
      {data && data.period && (
        <div className="space-y-5">
          <Card title="Period comparison" subtitle="Site totals per window vs the equal-length previous window" bodyClassName="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
                    <th className="px-4 py-2 text-left font-medium">Window</th>
                    <th className="px-4 py-2 text-right font-medium">Clicks</th>
                    <th className="px-4 py-2 text-right font-medium">Impressions</th>
                    <th className="px-4 py-2 text-right font-medium">CTR</th>
                    <th className="px-4 py-2 text-right font-medium">Avg position</th>
                  </tr>
                </thead>
                <tbody>
                  {data.windows.map((w) => (
                    <tr key={w.days} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-gray-900">Last {w.days} days</div>
                        <div className="text-xs text-gray-500">
                          {fmtDate(w.start)} – {fmtDate(w.end)} vs {fmtDate(w.prevStart)} – {fmtDate(w.prevEnd)}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular">
                        {fmtNum(w.current.clicks)} <span className="text-gray-400">/ {fmtNum(w.previous.clicks)}</span>
                        <div><Delta value={deltaPct(w.current.clicks, w.previous.clicks)} /></div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular">
                        {fmtNum(w.current.impressions)} <span className="text-gray-400">/ {fmtNum(w.previous.impressions)}</span>
                        <div><Delta value={deltaPct(w.current.impressions, w.previous.impressions)} /></div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular">
                        {fmtCtr(w.current.ctr)} <span className="text-gray-400">/ {fmtCtr(w.previous.ctr)}</span>
                        <div><Delta value={(w.current.ctr - w.previous.ctr) * 100} suffix=" pp" digits={2} /></div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular">
                        {fmtPos(w.current.position)} <span className="text-gray-400">/ {fmtPos(w.previous.position)}</span>
                        <div><Delta value={w.current.position - w.previous.position} suffix="" invert /></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="Top queries" bodyClassName="p-0">
            <DataTable columns={queryCols('Query')} rows={data.topQueries} rowKey={(r) => r.key} maxHeight="420px" dense className="rounded-none border-0" />
          </Card>
          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Rising queries" bodyClassName="p-0">
              <DataTable columns={queryCols('Query').filter((c) => !['ctr', 'trend'].includes(c.key))} rows={data.risingQueries} rowKey={(r) => r.key} maxHeight="360px" dense className="rounded-none border-0" empty={<p className="p-4 text-sm text-gray-500">No rising queries this period.</p>} />
            </Card>
            <Card title="Declining queries" bodyClassName="p-0">
              <DataTable columns={queryCols('Query').filter((c) => !['ctr', 'trend'].includes(c.key))} rows={data.decliningQueries} rowKey={(r) => r.key} maxHeight="360px" dense className="rounded-none border-0" empty={<p className="p-4 text-sm text-gray-500">No declining queries this period.</p>} />
            </Card>
          </div>
          <Card title="Top pages" subtitle={data.analytics?.connected ? 'GA4 columns show Organic Search sessions for the landing page' : 'Connect GA4 to add sessions, engagement and conversions'} bodyClassName="p-0">
            <DataTable columns={data.analytics?.connected ? pageCols : queryCols('Page', true).slice(0, 7)} rows={data.topPages} rowKey={(r) => r.key} maxHeight="420px" dense className="rounded-none border-0" />
          </Card>
          <div className="grid gap-5 xl:grid-cols-2">
            <Card title="Declining pages" bodyClassName="p-0">
              <DataTable columns={queryCols('Page', true).slice(0, 7)} rows={data.decliningPages} rowKey={(r) => r.key} maxHeight="360px" dense className="rounded-none border-0" empty={<p className="p-4 text-sm text-gray-500">No pages lost significant clicks this period.</p>} />
            </Card>
            <Card title="Traffic by channel" subtitle={data.analytics?.organic ? `Organic: ${fmtNum(data.analytics.organic.sessions)} sessions · ${fmtNum(data.analytics.organic.engaged)} engaged · ${fmtNum(data.analytics.organic.conversions)} conversions` : 'GA4'}>
              {data.analytics?.connected && data.analytics.channels.length ? (
                <SimpleBarChart data={data.analytics.channels} xKey="channel_group" yKey="sessions" name="Sessions" horizontal height={Math.max(160, data.analytics.channels.length * 30)} />
              ) : (
                <EmptyState compact title="GA4 not connected" description="Add your GA4 property ID in Settings → Integrations and run a GA4 sync." />
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
