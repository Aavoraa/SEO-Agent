import { useMemo } from 'react';
import { ArrowRight, Star } from 'lucide-react';
import type { InternalLinksResponse, LinkOpportunity, LinkPage } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { fmtNum, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Card, ErrorBox, Loading, ScoreBar, Stat } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { PriorityBadge, StatusPill } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

function PageList({ pages, empty }: { pages: LinkPage[]; empty: string }) {
  if (!pages.length) return <p className="px-4 py-4 text-sm text-gray-500">{empty}</p>;
  return (
    <ul className="divide-y divide-gray-100">
      {pages.map((p) => (
        <li key={p.url} className="flex items-center gap-2 px-4 py-2">
          {p.is_important && <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />}
          <div className="min-w-0 flex-1">
            <div className="font-mono text-xs text-gray-900">{p.path}</div>
            <div className="truncate text-xs text-gray-500">{p.title}</div>
          </div>
          <span className="text-xs tabular text-gray-600">{p.inlinks} inlinks</span>
        </li>
      ))}
    </ul>
  );
}

export function InternalLinksPage() {
  const { data, error, loading, reload } = useProjectApi<InternalLinksResponse>('/internal-links');
  const maxInlinks = useMemo(() => Math.max(1, ...(data?.pages ?? []).map((p) => p.inlinks)), [data]);

  const oppCols: Column<LinkOpportunity>[] = [
    {
      key: 'st',
      header: 'Source → Target',
      sort: (r) => r.source_url,
      render: (r) => (
        <span className="inline-flex flex-wrap items-center gap-1.5 font-mono text-xs">
          <span className="text-gray-700">{pathOf(r.source_url)}</span>
          <ArrowRight className="h-3 w-3 text-gray-400" />
          <span className="font-medium text-gray-900">{pathOf(r.target_url)}</span>
        </span>
      ),
    },
    { key: 'anchor', header: 'Anchor text', render: (r) => <span className="text-sm">“{r.anchor_text ?? '—'}”</span> },
    { key: 'reason', header: 'Reason', render: (r) => <span className="block max-w-md text-xs text-gray-600">{r.reason}</span> },
    { key: 'priority', header: 'Priority', sort: (r) => ['critical', 'high', 'medium', 'low'].indexOf(r.priority), render: (r) => <PriorityBadge priority={r.priority} /> },
    { key: 'score', header: 'Score', sort: (r) => r.score, render: (r) => <ScoreBar value={r.score} /> },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
  ];

  const pageCols: Column<LinkPage>[] = [
    { key: 'path', header: 'Page', sort: (r) => r.path, render: (r) => <span className="inline-flex items-center gap-1.5 font-mono text-xs">{r.is_important && <Star className="h-3 w-3 fill-amber-400 text-amber-400" />}{r.path}</span> },
    { key: 'type', header: 'Type', sort: (r) => r.page_type, render: (r) => <span className="text-xs">{humanize(r.page_type)}</span> },
    {
      key: 'inlinks',
      header: 'Internal links in',
      sort: (r) => r.inlinks,
      render: (r) => (
        <span className="flex items-center gap-2">
          <span className="h-2 w-40 overflow-hidden rounded-full bg-gray-100">
            <span className={`block h-full rounded-full ${r.inlinks === 0 ? 'bg-red-500' : r.inlinks < 3 ? 'bg-amber-500' : 'bg-brand-500'}`} style={{ width: `${Math.max(2, (r.inlinks / maxInlinks) * 100)}%` }} />
          </span>
          <span className="w-8 text-xs tabular">{r.inlinks}</span>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Internal Links" description="Orphan and weakly linked pages, plus suggested contextual links between related pages." actions={<JobButton type="internal-links" label="Run internal link analysis" onDone={reload} />} />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Pages analysed" value={fmtNum(data.pages.length)} />
            <Stat label="Orphan pages" value={fmtNum(data.orphans.length)} hint="indexable, 0 internal links" />
            <Stat label="Weakly linked important pages" value={fmtNum(data.weak.length)} hint="fewer than 3 inlinks" />
            <Stat label="Link opportunities" value={fmtNum(data.opportunities.length)} />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Orphan pages" subtitle="No other page links here – search engines may struggle to find them" bodyClassName="p-0">
              <PageList pages={data.orphans} empty="No orphan pages." />
            </Card>
            <Card title="Weakly linked important pages" bodyClassName="p-0">
              <PageList pages={data.weak} empty="All important pages have at least 3 internal links." />
            </Card>
          </div>
          <Card title="Link opportunities" subtitle="Approve the matching recommendation in Approvals / Recommendations to implement" bodyClassName="p-0">
            <DataTable className="rounded-none border-0" columns={oppCols} rows={data.opportunities} rowKey={(r) => r.id} initialSort={{ key: 'score', dir: 'desc' }} maxHeight="520px" empty={<div className="p-4"><EmptyState compact title="No link opportunities" description="Run the internal link analysis after a crawl." /></div>} />
          </Card>
          <Card title="Inlinks per page" bodyClassName="p-0">
            <DataTable className="rounded-none border-0" dense columns={pageCols} rows={data.pages} rowKey={(r) => r.url} initialSort={{ key: 'inlinks', dir: 'asc' }} maxHeight="480px" />
          </Card>
        </div>
      )}
    </div>
  );
}
