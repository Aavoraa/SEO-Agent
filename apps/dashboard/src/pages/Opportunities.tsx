import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { OPPORTUNITY_CATEGORY_LABEL, type Opportunity, type OpportunityCategory } from '../api/types';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { PageHeader } from '../components/PageHeader';
import { Card, ErrorBox, Loading, Tabs } from '../components/ui';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';
import { OpportunityCard } from '../components/Opportunity';

type Tab = 'all' | OpportunityCategory | 'dismissed';

export function OpportunitiesPage() {
  const { base } = useProject();
  const { run } = useAction();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('category') as Tab | null) ?? 'all';
  const query = tab === 'all' ? {} : tab === 'dismissed' ? { status: 'dismissed' } : { category: tab };
  const { data, error, loading, reload } = useProjectApi<{ items: Opportunity[]; formula: { description: string } }>('/opportunities', query);
  const counts = useProjectApi<{ items: Opportunity[] }>('/opportunities');
  const setTab = (t: Tab) => {
    const n = new URLSearchParams(params);
    if (t === 'all') n.delete('category');
    else n.set('category', t);
    setParams(n, { replace: true });
  };
  const count = (c: OpportunityCategory) => counts.data?.items.filter((o) => o.category === c).length ?? 0;
  const setStatus = (id: string, status: 'dismissed' | 'snoozed' | 'in_progress') =>
    run(status, () => api(`${base}/opportunities/${id}`, { method: 'PATCH', body: { status } }), status === 'dismissed' ? 'Dismissed' : 'Snoozed for 14 days').then((r) => {
      if (r) {
        reload();
        counts.reload();
      }
    });
  const cats = Object.keys(OPPORTUNITY_CATEGORY_LABEL) as OpportunityCategory[];
  return (
    <div>
      <PageHeader title="Opportunities" description="Every issue and opportunity from every data source, ranked by one documented formula." actions={<JobButton type="opportunities" label="Refresh" onDone={() => { reload(); counts.reload(); }} />} />
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[{ id: 'all', label: 'All open', count: counts.data?.items.length }, ...cats.filter((c) => count(c) > 0 || c === tab).map((c) => ({ id: c as Tab, label: OPPORTUNITY_CATEGORY_LABEL[c], count: count(c) })), { id: 'dismissed', label: 'Dismissed' }]}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && !data.items.length && <Card><EmptyState title="Nothing here" description="Run an audit, connect Search Console, or refresh to discover opportunities." /></Card>}
      {data && data.items.length > 0 && (
        <div className="space-y-3">
          {data.items.map((o) => <OpportunityCard key={o.id} o={o} onStatus={(s) => setStatus(o.id, s)} />)}
          <p className="text-[11px] text-gray-400">{data.formula.description}</p>
        </div>
      )}
    </div>
  );
}
