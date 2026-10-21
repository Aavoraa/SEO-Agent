import { useState } from 'react';
import { Download, Info } from 'lucide-react';
import { download } from '../api/client';
import type { Keyword, KeywordCluster, KeywordsResponse } from '../api/types';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { fmtCtr, fmtNum, fmtPos, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorBox, Loading, ScoreBar, Segmented, Tabs, Tooltip } from '../components/ui';
import { FilterBar, FilterField, SearchFilter, SelectFilter } from '../components/FilterBar';
import { DataTable, type Column } from '../components/DataTable';
import { Pill, TrendBadge } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

const initial = { service: '', location: '', intent: '', type: '', minPos: '', maxPos: '', minOpportunity: '', trend: '', q: '', source: 'gsc', window: 28, sort: 'opportunity' };
const INTENTS = ['informational', 'commercial', 'transactional', 'navigational', 'local'];
const TYPES = ['primary', 'secondary', 'long_tail', 'local', 'question', 'commercial'];

function KeywordTable() {
  const [f, setF] = useState(initial);
  const { base } = useProject();
  const { run, busy } = useAction();
  const query = { ...f, limit: 500 };
  const { data, error, loading, reload } = useProjectApi<KeywordsResponse>('/keywords', query);

  const cols: Column<Keyword>[] = [
    {
      key: 'keyword',
      header: 'Keyword',
      sort: (r) => r.keyword,
      render: (r) => (
        <div className="min-w-44">
          <div className="font-medium text-gray-900">{r.keyword}</div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {r.is_branded && <Pill tone="violet">Branded</Pill>}
            {r.source !== 'gsc' && <Pill>{humanize(r.source)}</Pill>}
            {r.keyword_type && <span className="text-[11px] text-gray-500">{humanize(r.keyword_type)}</span>}
          </div>
        </div>
      ),
    },
    { key: 'intent', header: 'Intent', sort: (r) => r.intent, render: (r) => <span className="text-xs">{humanize(r.intent)}</span> },
    { key: 'position', header: 'Position', align: 'right', sort: (r) => r.position, render: (r) => fmtPos(r.position) },
    { key: 'clicks', header: 'Clicks', align: 'right', sort: (r) => r.clicks, render: (r) => fmtNum(r.clicks) },
    { key: 'impressions', header: 'Impr.', align: 'right', sort: (r) => r.impressions, render: (r) => fmtNum(r.impressions) },
    { key: 'ctr', header: 'CTR', align: 'right', sort: (r) => r.ctr, render: (r) => fmtCtr(r.ctr) },
    {
      key: 'volume',
      header: (
        <Tooltip content={data?.note ?? 'Search volume is unavailable from Search Console.'}>
          <span className="inline-flex items-center gap-1">
            Volume <Info className="h-3 w-3" />
          </span>
        </Tooltip>
      ),
      render: (r) => (r.search_volume != null && r.search_volume_source && r.search_volume_source !== 'unavailable' ? fmtNum(r.search_volume) : <span className="text-xs text-gray-400">Unavailable</span>),
    },
    {
      key: 'trend',
      header: 'Trend',
      sort: (r) => r.trend,
      render: (r) => (
        <Tooltip content={r.prev_position != null ? `Prev: pos ${fmtPos(r.prev_position)}, ${fmtNum(r.prev_clicks)} clicks, ${fmtNum(r.prev_impressions)} impr.` : null}>
          <TrendBadge trend={r.trend} />
        </Tooltip>
      ),
    },
    { key: 'target', header: 'Target page', sort: (r) => r.target_page_url, render: (r) => <span className="font-mono text-xs whitespace-nowrap text-gray-600">{r.target_page_url ? pathOf(r.target_page_url) : <span className="font-sans text-gray-400">None – gap</span>}</span> },
    {
      key: 'opp',
      header: 'Opportunity',
      sort: (r) => r.opportunity_score,
      render: (r) => (
        <Tooltip
          content={
            r.opportunity_reasons?.length ? (
              <ul className="list-disc pl-4">
                {r.opportunity_reasons.map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
              </ul>
            ) : null
          }
        >
          <ScoreBar value={r.opportunity_score ?? 0} />
        </Tooltip>
      ),
    },
    { key: 'cluster', header: 'Cluster', sort: (r) => r.cluster_name, render: (r) => <span className="block max-w-48 truncate text-xs text-gray-600" title={r.cluster_name ?? ''}>{r.cluster_name ?? '—'}</span> },
  ];

  return (
    <>
      <FilterBar onReset={() => setF(initial)}>
        <SearchFilter value={f.q} onChange={(v) => setF({ ...f, q: v })} placeholder="Keyword contains" />
        <SelectFilter label="Service" value={f.service} onChange={(v) => setF({ ...f, service: v })} options={(data?.filters.services ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <SelectFilter label="Location" value={f.location} onChange={(v) => setF({ ...f, location: v })} options={(data?.filters.locations ?? []).map((s) => ({ value: s.id, label: s.name }))} />
        <SelectFilter label="Intent" value={f.intent} onChange={(v) => setF({ ...f, intent: v })} options={INTENTS.map((s) => ({ value: s, label: humanize(s) }))} />
        <SelectFilter label="Type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={TYPES.map((s) => ({ value: s, label: humanize(s) }))} />
        <FilterField label="Position">
          <span className="flex items-center gap-1">
            <input className="input w-14" inputMode="decimal" placeholder="min" value={f.minPos} onChange={(e) => setF({ ...f, minPos: e.target.value })} aria-label="Minimum position" />
            <span className="text-gray-400">–</span>
            <input className="input w-14" inputMode="decimal" placeholder="max" value={f.maxPos} onChange={(e) => setF({ ...f, maxPos: e.target.value })} aria-label="Maximum position" />
          </span>
        </FilterField>
        <FilterField label="Min opportunity">
          <input className="input w-20" inputMode="numeric" placeholder="0–100" value={f.minOpportunity} onChange={(e) => setF({ ...f, minOpportunity: e.target.value })} />
        </FilterField>
        <SelectFilter label="Trend" value={f.trend} onChange={(v) => setF({ ...f, trend: v })} options={['rising', 'stable', 'declining', 'new', 'lost'].map((s) => ({ value: s, label: humanize(s) }))} />
        <SelectFilter label="Source" value={f.source} allLabel={null} onChange={(v) => setF({ ...f, source: v })} options={[{ value: 'gsc', label: 'Search Console' }, { value: 'expansion', label: 'Expansion' }, { value: 'all', label: 'All' }]} />
        <FilterField label="Window">
          <Segmented value={f.window} onChange={(v) => setF({ ...f, window: v })} options={[7, 28, 90].map((d) => ({ value: d, label: `${d}d` }))} />
        </FilterField>
        <SelectFilter label="Sort" value={f.sort} allLabel={null} onChange={(v) => setF({ ...f, sort: v })} options={['opportunity', 'impressions', 'clicks', 'position'].map((s) => ({ value: s, label: humanize(s) }))} />
      </FilterBar>
      {data?.note && (
        <p className="mb-3 flex items-center gap-1.5 text-xs text-gray-500">
          <Info className="h-3.5 w-3.5" /> {data.note}
        </p>
      )}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <div className="mb-2 flex items-center justify-between gap-2 text-xs text-gray-500">
            <span>
              Showing {data.items.length} of {fmtNum(data.total)} keywords {loading && '· refreshing…'}
            </span>
            <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'csv'} onClick={() => run('csv', () => download(`${base}/keywords`, 'keywords.csv', { ...query, format: 'csv' }))}>
              Export CSV
            </Button>
          </div>
          <DataTable
            columns={cols}
            rows={data.items}
            rowKey={(r) => r.id}
            dense
            expand={(r) => (
              <div className="grid gap-4 text-sm md:grid-cols-3">
                <div>
                  <div className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase">User problem</div>
                  <p className="mt-1 text-gray-800">{r.user_problem ?? '—'}</p>
                </div>
                <div>
                  <div className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Expected content</div>
                  <p className="mt-1 text-gray-800">{r.expected_content ?? '—'}</p>
                </div>
                <div className="space-y-1 text-gray-800">
                  <div className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Recommendation</div>
                  <p>Page type: {humanize(r.recommended_page_type)}</p>
                  <p>CTA: {r.recommended_cta ?? '—'}</p>
                  <p className="text-xs text-gray-500">
                    Intent {humanize(r.intent)} {r.intent_confidence != null && `(${Math.round(r.intent_confidence * 100)}% confidence)`} · services: {r.services.join(', ') || '—'} · locations: {r.locations.join(', ') || '—'}
                  </p>
                </div>
              </div>
            )}
            empty={<EmptyState title="No keywords match" description="Connect Search Console to see keywords, then run the keyword analysis job. Or widen your filters." action={<JobButton type="keywords" label="Run keyword analysis" onDone={reload} />} />}
          />
        </>
      )}
    </>
  );
}

function Clusters() {
  const { data, error, loading, reload } = useProjectApi<KeywordCluster[]>('/keyword-clusters');
  const cols: Column<KeywordCluster>[] = [
    {
      key: 'name',
      header: 'Cluster',
      sort: (r) => r.name,
      render: (r) => (
        <div className="min-w-48">
          <div className="font-medium text-gray-900">{r.name}</div>
          <div className="text-xs text-gray-500">
            {r.keyword_count} keywords{r.top_keywords?.length ? ` · ${r.top_keywords.slice(0, 3).join(', ')}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'strategy', header: 'Strategy', sort: (r) => r.strategy, render: (r) => <Pill tone={r.strategy === 'new_page' ? 'brand' : 'gray'}>{humanize(r.strategy)}</Pill> },
    { key: 'type', header: 'Recommended page type', render: (r) => <span className="text-xs">{r.recommended_page_type ?? '—'}</span> },
    { key: 'target', header: 'Target page', render: (r) => <span className="font-mono text-xs text-gray-600">{r.target_page_url ? pathOf(r.target_page_url) : '—'}</span> },
    { key: 'impr', header: 'Impressions', align: 'right', sort: (r) => r.total_impressions, render: (r) => fmtNum(r.total_impressions) },
    { key: 'clicks', header: 'Clicks', align: 'right', sort: (r) => r.total_clicks, render: (r) => fmtNum(r.total_clicks) },
    { key: 'opp', header: 'Opportunity', sort: (r) => r.opportunity_score, render: (r) => <ScoreBar value={r.opportunity_score} /> },
    {
      key: 'cannibal',
      header: 'Cannibalization',
      render: (r) =>
        r.cannibalization?.length ? (
          <Tooltip
            content={
              <ul>
                {r.cannibalization.map((c) => (
                  <li key={c.url}>
                    {pathOf(c.url)} – {Math.round(c.share * 100)}% ({fmtNum(c.impressions)} impr.)
                  </li>
                ))}
              </ul>
            }
          >
            <Pill tone="amber">{r.cannibalization.length} pages compete</Pill>
          </Tooltip>
        ) : (
          <span className="text-xs text-gray-400">None</span>
        ),
    },
  ];
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data && loading) return <Loading />;
  return (
    <DataTable
      columns={cols}
      rows={data ?? []}
      rowKey={(r) => r.id}
      initialSort={{ key: 'opp', dir: 'desc' }}
      expand={(r) => (
        <div className="space-y-2 text-sm">
          <div className="text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Rationale</div>
          <p className="text-gray-800">{r.rationale ?? '—'}</p>
          {r.top_keywords && <p className="text-xs text-gray-500">Top keywords: {r.top_keywords.join(', ')}</p>}
        </div>
      )}
      empty={<EmptyState title="No clusters yet" description="Run keyword analysis to group queries into clusters." />}
    />
  );
}

export function KeywordsPage() {
  const [tab, setTab] = useState<'keywords' | 'clusters'>('keywords');
  return (
    <div>
      <PageHeader title="Keywords" description="Queries from Search Console, classified by intent, service and location, with a transparent opportunity score." actions={<JobButton type="keywords" label="Run keyword analysis" />} />
      <Tabs tabs={[{ id: 'keywords', label: 'Keywords' }, { id: 'clusters', label: 'Clusters' }]} value={tab} onChange={setTab} />
      {tab === 'keywords' ? <KeywordTable /> : <Clusters />}
    </div>
  );
}
