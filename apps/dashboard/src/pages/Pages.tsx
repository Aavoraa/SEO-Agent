import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Check, ExternalLink, Minus, Star } from 'lucide-react';
import type { PageDetail, PageRow } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { cx, fmtDate, fmtDateTime, fmtNum, fmtPos, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Card, ErrorBox, KeyValues, Loading } from '../components/ui';
import { FilterBar, SearchFilter, SelectFilter } from '../components/FilterBar';
import { DataTable, type Column } from '../components/DataTable';
import { Drawer } from '../components/Overlay';
import { Pill, PriorityBadge, RiskBadge, SeverityBadge, StatusPill } from '../components/Badges';
import { ClicksImpressionsChart } from '../components/charts';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

const SEV = ['critical', 'high', 'medium', 'low', 'info'];
const Bool = ({ v }: { v: boolean | null | undefined }) => (v == null ? <span className="text-gray-400">—</span> : v ? <Check className="h-4 w-4 text-emerald-600" /> : <Minus className="h-4 w-4 text-red-500" />);

function List({ items, empty = 'None' }: { items: string[] | null | undefined; empty?: string }) {
  if (!items?.length) return <span className="text-gray-400">{empty}</span>;
  return (
    <ul className="list-disc space-y-0.5 pl-4">
      {items.map((x, i) => (
        <li key={i}>{x}</li>
      ))}
    </ul>
  );
}

function PageDetailView({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { data, error, loading, reload } = useProjectApi<PageDetail>(`/pages/${pageId}`);
  const l = data?.latest;
  const schemaTypes = l ? [...new Set(l.structured_data.flatMap((s) => s.types ?? []))] : [];
  const invalidSchema = l ? l.structured_data.filter((s) => !s.valid) : [];
  const noAlt = l ? l.images.filter((i) => !i.hasAlt) : [];
  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-4xl"
      title={data ? pathOf(data.page.url) : 'Page'}
      subtitle={
        data && (
          <a href={data.page.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-gray-700">
            {data.page.url} <ExternalLink className="h-3 w-3" />
          </a>
        )
      }
      actions={data && <JobButton type="onpage-optimize" body={{ pageUrl: data.page.url }} label="Run AI on-page optimization" size="sm" variant="primary" onDone={reload} />}
    >
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="card px-3 py-2"><div className="text-xs text-gray-500">Clicks (90d)</div><div className="text-lg font-semibold tabular">{fmtNum(data.history.reduce((s, h) => s + h.clicks, 0))}</div></div>
            <div className="card px-3 py-2"><div className="text-xs text-gray-500">Impressions (90d)</div><div className="text-lg font-semibold tabular">{fmtNum(data.history.reduce((s, h) => s + h.impressions, 0))}</div></div>
            <div className="card px-3 py-2"><div className="text-xs text-gray-500">Organic sessions (28d)</div><div className="text-lg font-semibold tabular">{fmtNum(data.analytics?.sessions)}</div></div>
            <div className="card px-3 py-2"><div className="text-xs text-gray-500">Conversions (28d)</div><div className="text-lg font-semibold tabular">{fmtNum(data.analytics?.conversions)}</div></div>
          </div>
          {data.history.length > 0 && (
            <Card title="Clicks & impressions – last 90 days">
              <ClicksImpressionsChart data={data.history} height={220} />
            </Card>
          )}
          <Card title="Latest crawl" subtitle={l ? `Fetched ${fmtDateTime(l.fetched_at)} · HTTP ${l.status_code ?? '—'} · ${l.response_time_ms ?? '—'} ms` : undefined}>
            {l ? (
              <KeyValues
                items={[
                  { label: 'Title', value: l.title ? <>{l.title} <span className="text-xs text-gray-400">({l.title.length} chars)</span></> : <span className="text-red-600">Missing</span> },
                  { label: 'Meta description', value: l.meta_description ? <>{l.meta_description} <span className="text-xs text-gray-400">({l.meta_description.length} chars)</span></> : <span className="text-red-600">Missing</span> },
                  { label: 'H1', value: <List items={l.h1s} empty="No H1" /> },
                  { label: 'H2s', value: <List items={l.h2s} /> },
                  { label: 'Canonical', value: l.canonical ?? '—' },
                  { label: 'Robots', value: [l.robots_meta, l.x_robots_tag].filter(Boolean).join(' · ') || '—' },
                  { label: 'Indexable', value: <span className="inline-flex items-center gap-1"><Bool v={l.indexable} /> {l.indexability_reason}</span> },
                  { label: 'Word count', value: fmtNum(l.word_count) },
                  { label: 'Schema types', value: schemaTypes.length ? schemaTypes.join(', ') : invalidSchema.length ? <span className="text-red-600">{invalidSchema.length} invalid JSON-LD block(s)</span> : 'None' },
                  { label: 'Images without alt', value: noAlt.length ? <List items={noAlt.map((i) => i.src)} /> : <span className="text-emerald-700">All {l.images.length} images have alt text</span> },
                ]}
              />
            ) : (
              <p className="text-sm text-gray-500">This page has not been crawled yet.</p>
            )}
          </Card>
          <Card title={`Open issues (${data.issues.length})`} bodyClassName="p-0">
            {data.issues.length ? (
              <ul className="divide-y divide-gray-100">
                {[...data.issues].sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity)).map((i) => (
                  <li key={i.id} className="flex items-start gap-3 px-4 py-2.5">
                    <SeverityBadge severity={i.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-900">{i.title}</div>
                      <div className="text-xs text-gray-500">{i.recommendation}</div>
                    </div>
                    <StatusPill status={i.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-gray-500">No open issues.</p>
            )}
          </Card>
          <Card title={`Recommendations (${data.recommendations.length})`} bodyClassName="p-0">
            {data.recommendations.length ? (
              <ul className="divide-y divide-gray-100">
                {data.recommendations.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                    <span className="w-8 text-right text-sm font-semibold tabular">{Math.round(r.priority_score)}</span>
                    <span className="min-w-0 flex-1 text-sm text-gray-900">{r.title}</span>
                    {r.ai_generated && <Pill tone="violet">AI</Pill>}
                    <PriorityBadge priority={r.priority} />
                    <RiskBadge risk={r.risk} />
                    <StatusPill status={r.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-gray-500">No recommendations for this page.</p>
            )}
          </Card>
          <Card title="Search queries (90 days)" bodyClassName="p-0">
            <DataTable
              className="rounded-none border-0"
              dense
              maxHeight="360px"
              rows={data.queries}
              rowKey={(r) => r.query}
              columns={[
                { key: 'query', header: 'Query', sort: (r) => r.query },
                { key: 'clicks', header: 'Clicks', align: 'right', sort: (r) => r.clicks, render: (r) => fmtNum(r.clicks) },
                { key: 'impressions', header: 'Impr.', align: 'right', sort: (r) => r.impressions, render: (r) => fmtNum(r.impressions) },
                { key: 'position', header: 'Pos.', align: 'right', sort: (r) => r.position, render: (r) => fmtPos(r.position) },
              ]}
              empty={<p className="p-4 text-sm text-gray-500">No Search Console queries recorded for this page.</p>}
            />
          </Card>
          <Card title="Change history" bodyClassName="p-0">
            {data.changes.length ? (
              <ul className="divide-y divide-gray-100">
                {data.changes.map((c) => (
                  <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="w-24 text-xs text-gray-500">{fmtDate(c.created_at)}</span>
                    <span className="flex-1">{humanize(c.change_type)}: <span className="text-gray-600">{(c.new_value ?? '').slice(0, 90)}</span></span>
                    <StatusPill status={c.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-gray-500">No changes recorded for this page.</p>
            )}
          </Card>
        </div>
      )}
    </Drawer>
  );
}

export function PagesPage() {
  const { pageId } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useProjectApi<PageRow[]>('/pages');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [state, setState] = useState('live');

  const rows = useMemo(
    () =>
      (data ?? []).filter(
        (p) =>
          (!q || p.url.toLowerCase().includes(q.toLowerCase()) || (p.title ?? '').toLowerCase().includes(q.toLowerCase())) &&
          (!type || p.page_type === type) &&
          (state === 'all' || (state === 'live' ? !p.removed_at : !!p.removed_at)),
      ),
    [data, q, type, state],
  );
  const types = useMemo(() => [...new Set((data ?? []).map((p) => p.page_type).filter(Boolean) as string[])].sort(), [data]);

  const cols: Column<PageRow>[] = [
    {
      key: 'path',
      header: 'Page',
      sort: (r) => r.path,
      render: (r) => (
        <div className="flex min-w-52 items-start gap-1.5">
          {r.is_important ? <Star className="mt-0.5 h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-400" aria-label="Important page" /> : <span className="w-3.5 shrink-0" />}
          <div className="min-w-0">
            <div className="font-mono text-xs text-gray-900">{r.path}</div>
            <div className="max-w-80 truncate text-xs text-gray-500" title={r.title ?? ''}>{r.title ?? <span className="text-red-600">No title</span>}</div>
          </div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', sort: (r) => r.page_type, render: (r) => <span className="text-xs">{humanize(r.page_type)}</span> },
    { key: 'status', header: 'Status', align: 'center', sort: (r) => r.status_code, render: (r) => <span className={cx('text-xs tabular', r.status_code && r.status_code >= 400 ? 'text-red-600' : r.status_code && r.status_code >= 300 ? 'text-amber-700' : 'text-gray-700')}>{r.removed_at ? 'Removed' : r.status_code ?? '—'}</span> },
    { key: 'words', header: 'Words', align: 'right', sort: (r) => r.word_count, render: (r) => fmtNum(r.word_count) },
    { key: 'indexable', header: 'Indexable', align: 'center', sort: (r) => Number(r.indexable), render: (r) => <span className="inline-flex justify-center"><Bool v={r.indexable} /></span> },
    { key: 'sitemap', header: 'Sitemap', align: 'center', sort: (r) => Number(r.in_sitemap), render: (r) => <span className="inline-flex justify-center"><Bool v={r.in_sitemap} /></span> },
    { key: 'inlinks', header: 'Inlinks', align: 'right', sort: (r) => r.inlinks, render: (r) => <span className={r.inlinks === 0 ? 'text-red-600' : ''}>{fmtNum(r.inlinks)}</span> },
    { key: 'issues', header: 'Issues', align: 'right', sort: (r) => r.serious_issues * 1000 + r.open_issues, render: (r) => (<span>{r.open_issues}{r.serious_issues > 0 && <span className="ml-1 text-xs text-orange-700">({r.serious_issues} serious)</span>}</span>) },
    { key: 'clicks', header: 'Clicks', align: 'right', sort: (r) => r.clicks, render: (r) => fmtNum(r.clicks) },
    { key: 'impr', header: 'Impr.', align: 'right', sort: (r) => r.impressions, render: (r) => fmtNum(r.impressions) },
    { key: 'pos', header: 'Pos.', align: 'right', sort: (r) => r.position, render: (r) => fmtPos(r.position) },
  ];

  return (
    <div>
      <PageHeader title="Pages" description="Every URL found by the crawler with Search Console performance for the last 28 days. Click a row for details." actions={<JobButton type="crawl" label="Run crawl" onDone={reload} />} />
      <FilterBar>
        <SearchFilter value={q} onChange={setQ} placeholder="URL or title" />
        <SelectFilter label="Type" value={type} onChange={setType} options={types.map((t) => ({ value: t, label: humanize(t) }))} />
        <SelectFilter label="State" value={state} allLabel={null} onChange={setState} options={[{ value: 'live', label: 'Live' }, { value: 'removed', label: 'Removed' }, { value: 'all', label: 'All' }]} />
      </FilterBar>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <DataTable
          columns={cols}
          rows={rows}
          rowKey={(r) => r.id}
          onRowClick={(r) => nav(`/pages/${r.id}`)}
          empty={<EmptyState title="No pages" description="Run a crawl to discover the pages on the website." action={<JobButton type="crawl" label="Run crawl" onDone={reload} />} />}
        />
      )}
      {pageId && <PageDetailView pageId={pageId} onClose={() => nav('/pages')} />}
    </div>
  );
}
