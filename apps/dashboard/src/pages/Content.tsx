import { useState } from 'react';
import { Check, EyeOff, FilePlus2, FileText, X } from 'lucide-react';
import { api } from '../api/client';
import type { ContentBrief, ContentOpportunity, ContentResponse, DraftRow } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { fmtDate, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorBox, Loading, ScoreBar, Tabs, Tooltip } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pill, PriorityBadge, StatusPill } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';
import { Drawer } from '../components/Overlay';
import { BriefView, DraftDrawer } from '../components/ContentViews';
import { ScoreBreakdown } from '../components/RecommendationCard';

type Tab = 'opportunities' | 'briefs' | 'drafts' | 'published' | 'refresh' | 'declining';

function OpportunityTable({ rows, onChanged, emptyText }: { rows: ContentOpportunity[]; onChanged: () => void; emptyText: string }) {
  const { canEdit } = useAuth();
  const { base, refreshCounts } = useProject();
  const { busy, run } = useAction();
  const cols: Column<ContentOpportunity>[] = [
    { key: 'score', header: 'Score', sort: (r) => r.score, render: (r) => <ScoreBar value={r.score} /> },
    {
      key: 'title',
      header: 'Opportunity',
      sort: (r) => r.title,
      render: (r) => (
        <div className="min-w-60">
          <div className="font-medium text-gray-900">{r.title}</div>
          <div className="text-xs text-gray-500">
            {r.target_keyword && <>Keyword “{r.target_keyword}” · </>}
            {r.target_page_url ? pathOf(r.target_page_url) : 'New page'}
          </div>
        </div>
      ),
    },
    { key: 'type', header: 'Type', sort: (r) => r.type, render: (r) => <Pill>{humanize(r.type)}</Pill> },
    { key: 'priority', header: 'Priority', render: (r) => <PriorityBadge priority={r.priority} /> },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) =>
        canEdit && r.status === 'open' ? (
          <span className="inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Button size="sm" variant="primary" icon={<FilePlus2 className="h-3.5 w-3.5" />} loading={busy === `brief-${r.id}`} disabled={!!busy} onClick={() => run(`brief-${r.id}`, () => api(`${base}/content/opportunities/${r.id}/brief`, { method: 'POST' }), 'Brief generated – it is waiting for approval in Content Briefs').then((x) => { if (x) { refreshCounts(); onChanged(); } })}>
              Generate Brief
            </Button>
            <Button size="sm" variant="ghost" icon={<EyeOff className="h-3.5 w-3.5" />} loading={busy === `dismiss-${r.id}`} disabled={!!busy} onClick={() => run(`dismiss-${r.id}`, () => api(`${base}/content/opportunities/${r.id}`, { method: 'PATCH', body: { status: 'dismissed' } }), 'Opportunity dismissed').then((x) => x && onChanged())}>
              Dismiss
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <DataTable
      columns={cols}
      rows={rows}
      rowKey={(r) => r.id}
      expand={(r) => (
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Reasons</div>
            <ul className="list-disc space-y-0.5 pl-4 text-sm text-gray-800">{(r.reasons ?? []).map((x, i) => <li key={i}>{x}</li>)}</ul>
            {Array.isArray(r.evidence?.queries) && <p className="mt-2 text-xs text-gray-500">Queries: {(r.evidence.queries as string[]).join(', ')}</p>}
          </div>
          <ScoreBreakdown score={r.score} factors={r.score_breakdown} />
        </div>
      )}
      empty={<EmptyState title={emptyText} description="Run content gap analysis after keywords are processed." />}
    />
  );
}

function Briefs({ rows, onChanged }: { rows: ContentBrief[]; onChanged: () => void }) {
  const [open, setOpen] = useState<ContentBrief | null>(null);
  const { canEdit } = useAuth();
  const { base, refreshCounts } = useProject();
  const { busy, run } = useAction();
  const decide = (b: ContentBrief, decision: 'approve' | 'reject') =>
    run(decision, () => api(`${base}/content/briefs/${b.id}/decision`, { body: { decision } }), decision === 'approve' ? 'Brief approved' : 'Brief rejected').then((x) => {
      if (x) {
        setOpen(null);
        refreshCounts();
        onChanged();
      }
    });
  const draft = (b: ContentBrief) => run(`draft-${b.id}`, () => api(`${base}/content/briefs/${b.id}/draft`, { method: 'POST' }), 'Draft generated – see the Drafts tab').then((x) => { if (x) { refreshCounts(); onChanged(); } });
  const cols: Column<ContentBrief>[] = [
    { key: 'kw', header: 'Target keyword', sort: (r) => r.target_keyword, render: (r) => <span className="font-medium text-gray-900">{r.target_keyword}</span> },
    { key: 'title', header: 'Suggested title', render: (r) => <span className="text-xs text-gray-700">{r.brief?.suggestedTitle ?? '—'}</span> },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
    { key: 'model', header: 'Model', render: (r) => <span className="text-xs text-gray-500">{r.ai_model ?? '—'}</span> },
    { key: 'created', header: 'Created', sort: (r) => r.created_at, render: (r) => <span className="text-xs">{fmtDate(r.created_at)}</span> },
    {
      key: 'a',
      header: '',
      align: 'right',
      render: (r) => (
        <span className="inline-flex gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" icon={<FileText className="h-3.5 w-3.5" />} onClick={() => setOpen(r)}>
            View
          </Button>
          {canEdit && r.status === 'approved' && (
            <Button size="sm" variant="primary" loading={busy === `draft-${r.id}`} disabled={!!busy} onClick={() => draft(r)}>
              Generate Draft
            </Button>
          )}
        </span>
      ),
    },
  ];
  return (
    <>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={setOpen} empty={<EmptyState title="No briefs yet" description="Generate a brief from a content opportunity." />} />
      {open && (
        <Drawer
          open
          onClose={() => setOpen(null)}
          title={open.brief?.suggestedTitle ?? open.target_keyword}
          subtitle={<span className="inline-flex items-center gap-2">Target: “{open.target_keyword}” · <StatusPill status={open.status} /> {open.ai_model && `· model ${open.ai_model}`}</span>}
          actions={
            canEdit && open.status === 'pending_approval' ? (
              <>
                <Button size="sm" variant="success" icon={<Check className="h-3.5 w-3.5" />} loading={busy === 'approve'} onClick={() => decide(open, 'approve')}>
                  Approve
                </Button>
                <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={busy === 'reject'} onClick={() => decide(open, 'reject')}>
                  Reject
                </Button>
              </>
            ) : canEdit && open.status === 'approved' ? (
              <Button size="sm" variant="primary" loading={busy === `draft-${open.id}`} onClick={() => draft(open)}>
                Generate Draft
              </Button>
            ) : null
          }
        >
          <BriefView brief={open.brief ?? {}} />
        </Drawer>
      )}
    </>
  );
}

function Drafts({ rows, onChanged, emptyText }: { rows: DraftRow[]; onChanged: () => void; emptyText: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const cols: Column<DraftRow>[] = [
    { key: 'title', header: 'Title', sort: (r) => r.title, render: (r) => <span className="font-medium text-gray-900">{r.title}</span> },
    { key: 'q', header: 'Quality', sort: (r) => r.quality_score, render: (r) => (r.quality_score != null ? <ScoreBar value={r.quality_score} /> : '—') },
    { key: 'verdict', header: 'Verdict', render: (r) => (r.verdict ? <Pill tone={r.verdict === 'ready_for_review' ? 'green' : r.verdict === 'reject' ? 'red' : 'amber'}>{humanize(r.verdict)}</Pill> : '—') },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
    { key: 'v', header: 'Version', align: 'right', render: (r) => `v${r.version}` },
    { key: 'created', header: 'Created', sort: (r) => r.created_at, render: (r) => <span className="text-xs">{fmtDate(r.created_at)}</span> },
  ];
  return (
    <>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.id} onRowClick={(r) => setOpen(r.id)} empty={<EmptyState title={emptyText} description="Approve a brief, then generate a draft from it." />} />
      {open && <DraftDrawer draftId={open} onClose={() => setOpen(null)} onChanged={onChanged} />}
    </>
  );
}

export function ContentPage() {
  const [tab, setTab] = useState<Tab>('opportunities');
  const { data, error, loading, reload } = useProjectApi<ContentResponse>('/content');
  return (
    <div>
      <PageHeader
        title="Content"
        description="Opportunity → brief → draft → quality check → human approval. Nothing is published automatically."
        actions={<JobButton type="content-opportunities" label="Run content gap analysis" onDone={reload} />}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { id: 'opportunities', label: 'Content Opportunities', count: data.opportunities.filter((o) => !['refresh', 'declining'].includes(o.type)).length },
              { id: 'briefs', label: 'Content Briefs', count: data.briefs.length },
              { id: 'drafts', label: 'Drafts', count: data.drafts.length },
              { id: 'published', label: 'Published', count: data.published.length },
              { id: 'refresh', label: 'Needs Refresh', count: data.needsRefresh.length },
              { id: 'declining', label: 'Declining Content', count: data.declining.length },
            ]}
          />
          {tab === 'opportunities' && <OpportunityTable rows={data.opportunities.filter((o) => !['refresh', 'declining'].includes(o.type))} onChanged={reload} emptyText="No content opportunities" />}
          {tab === 'briefs' && <Briefs rows={data.briefs} onChanged={reload} />}
          {tab === 'drafts' && <Drafts rows={data.drafts} onChanged={reload} emptyText="No drafts yet" />}
          {tab === 'published' && <Drafts rows={data.published} onChanged={reload} emptyText="Nothing marked as published" />}
          {tab === 'refresh' && <OpportunityTable rows={data.needsRefresh} onChanged={reload} emptyText="No pages need a refresh" />}
          {tab === 'declining' && <OpportunityTable rows={data.declining} onChanged={reload} emptyText="No declining content detected" />}
          <p className="mt-3 text-xs text-gray-400">
            <Tooltip content="Briefs and drafts are AI-assisted and must be reviewed by a human. Placeholders like [NEEDS INPUT] block approval until filled with verified facts.">
              <span className="underline decoration-dotted">How content approval works</span>
            </Tooltip>
          </p>
        </>
      )}
    </div>
  );
}
