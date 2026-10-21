import { useState } from 'react';
import type { RecommendationsResponse } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { humanize } from '../lib/format';
import { PRIORITIES, RECOMMENDATION_SOURCES, RECOMMENDATION_TYPES, RISKS } from '../lib/constants';
import { PageHeader } from '../components/PageHeader';
import { ErrorBox, Loading } from '../components/ui';
import { FilterBar, SearchFilter, SelectFilter } from '../components/FilterBar';
import { RecommendationCard } from '../components/RecommendationCard';
import { EmptyState } from '../components/EmptyState';

const STATUS_OPTIONS = [
  { value: 'recommended,pending_approval', label: 'Open (recommended + pending)' },
  { value: 'recommended', label: 'Recommended' },
  { value: 'pending_approval', label: 'Pending approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'all', label: 'All' },
];
const initial = { status: 'recommended,pending_approval', type: '', priority: '', source: '', risk: '', page: '' };

export function RecommendationsPage() {
  const [f, setF] = useState(initial);
  const { data, error, loading, reload } = useProjectApi<RecommendationsResponse>('/recommendations', { ...f, limit: 200 });
  const counts = Object.fromEntries((data?.counts ?? []).map((c) => [c.status, c.n]));

  return (
    <div>
      <PageHeader
        title="Recommendations"
        description="Every recommendation explains what, why, the evidence, the exact change, its risk and a transparent priority score."
        actions={
          data && (
            <div className="flex flex-wrap gap-3 text-xs text-gray-500">
              {['recommended', 'pending_approval', 'approved', 'rejected'].map((s) => (
                <span key={s}>
                  {humanize(s)}: <strong className="tabular text-gray-900">{counts[s] ?? 0}</strong>
                </span>
              ))}
            </div>
          )
        }
      />
      <FilterBar onReset={() => setF(initial)}>
        <SelectFilter label="Status" value={f.status} allLabel={null} onChange={(v) => setF({ ...f, status: v })} options={STATUS_OPTIONS} />
        <SelectFilter label="Type" value={f.type} onChange={(v) => setF({ ...f, type: v })} options={RECOMMENDATION_TYPES.map((t) => ({ value: t, label: humanize(t) }))} />
        <SelectFilter label="Priority" value={f.priority} onChange={(v) => setF({ ...f, priority: v })} options={PRIORITIES.map((t) => ({ value: t, label: humanize(t) }))} />
        <SelectFilter label="Source" value={f.source} onChange={(v) => setF({ ...f, source: v })} options={RECOMMENDATION_SOURCES.map((t) => ({ value: t, label: humanize(t) }))} />
        <SelectFilter label="Risk" value={f.risk} onChange={(v) => setF({ ...f, risk: v })} options={RISKS.map((t) => ({ value: t, label: humanize(t) }))} />
        <SearchFilter label="Page contains" value={f.page} onChange={(v) => setF({ ...f, page: v })} placeholder="/digital-marketing" />
      </FilterBar>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <p className="mb-3 text-xs text-gray-500">
            {data.items.length} recommendation{data.items.length === 1 ? '' : 's'} {data.items.length === 200 && '(first 200 – narrow the filters)'} {loading && '· refreshing…'}
          </p>
          {data.items.length ? (
            <div className="space-y-3">
              {data.items.map((r) => (
                <RecommendationCard key={r.id} rec={r} onChanged={reload} showWorkflow defaultExpanded={false} />
              ))}
            </div>
          ) : (
            <EmptyState title="No recommendations match" description="Run a crawl or keyword analysis to generate recommendations, or widen the filters." />
          )}
        </>
      )}
    </div>
  );
}
