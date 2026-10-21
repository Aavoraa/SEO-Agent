import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, FileText, ShieldCheck, X } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { ApprovalsResponse } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtDateTime, fmtRelative, humanize } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, ErrorBox, Loading, Segmented } from '../components/ui';
import { AiPill, Pill, StatusPill } from '../components/Badges';
import { RecommendationCard, isHighRisk } from '../components/RecommendationCard';
import { BriefView, DraftDrawer, QualityReportView } from '../components/ContentViews';
import { EmptyState } from '../components/EmptyState';

function SectionHeader({ title, count, children }: { title: string; count: number; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3">
      <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
      <span className="rounded-full bg-gray-100 px-2 py-px text-xs font-medium tabular text-gray-700">{count}</span>
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </div>
  );
}

function BriefApproval({ b, onChanged }: { b: ApprovalsResponse['briefs'][number]; onChanged: () => void }) {
  const { canEdit } = useAuth();
  const { base, refreshCounts } = useProject();
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const decide = (decision: 'approve' | 'reject') =>
    run(decision, () => api(`${base}/content/briefs/${b.id}/decision`, { body: { decision, comment: comment || undefined } }), decision === 'approve' ? 'Brief approved – you can now generate a draft' : 'Brief rejected').then((r) => {
      if (r) {
        refreshCounts();
        onChanged();
      }
    });
  return (
    <article className="card overflow-hidden">
      <header className="flex flex-wrap items-start gap-3 px-4 py-3">
        <button onClick={() => setOpen((o) => !o)} className="mt-0.5 text-gray-400 hover:text-gray-700" aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap gap-1.5">
            <Pill tone="blue">Content brief</Pill>
            {b.ai_model && <AiPill model={b.ai_model} />}
          </div>
          <h3 className="text-sm font-semibold text-gray-900">{b.brief?.suggestedTitle ?? b.target_keyword}</h3>
          <p className="text-xs text-gray-500">
            Target keyword “{b.target_keyword}” · created {fmtRelative(b.created_at)}
          </p>
        </div>
      </header>
      {open && (
        <div className="border-t border-gray-100 px-4 py-4">
          <BriefView brief={b.brief ?? {}} />
        </div>
      )}
      {canEdit && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/70 px-4 py-2.5">
          <input className="input h-7 min-w-40 flex-1 text-xs" placeholder="Optional comment" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
          <Button size="sm" variant="success" icon={<Check className="h-3.5 w-3.5" />} loading={busy === 'approve'} disabled={!!busy} onClick={() => decide('approve')}>
            Approve
          </Button>
          <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={busy === 'reject'} disabled={!!busy} onClick={() => decide('reject')}>
            Reject
          </Button>
        </footer>
      )}
    </article>
  );
}

function DraftApproval({ d, onChanged }: { d: ApprovalsResponse['drafts'][number]; onChanged: () => void }) {
  const { canEdit } = useAuth();
  const { base, refreshCounts } = useProject();
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [blocked, setBlocked] = useState<string | null>(null);
  const decide = (decision: 'approve' | 'reject') =>
    run(decision, async () => {
      setBlocked(null);
      try {
        return await api(`${base}/content/drafts/${d.id}/decision`, { body: { decision, comment: comment || undefined } });
      } catch (e) {
        if (e instanceof ApiError && e.code === 'placeholders') setBlocked(e.message);
        throw e;
      }
    }, decision === 'approve' ? 'Draft approved – export and publish via your CMS' : 'Draft rejected').then((r) => {
      if (r) {
        refreshCounts();
        onChanged();
      }
    });
  return (
    <article className="card overflow-hidden">
      <header className="flex flex-wrap items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap gap-1.5">
            <Pill tone="blue">Content draft</Pill>
            {d.ai_model && <AiPill model={d.ai_model} />}
          </div>
          <h3 className="text-sm font-semibold text-gray-900">{d.title}</h3>
          <p className="text-xs text-gray-500">Created {fmtRelative(d.created_at)}</p>
        </div>
        <Button size="sm" icon={<FileText className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
          Read draft
        </Button>
      </header>
      <div className="border-t border-gray-100 px-4 py-3">
        <QualityReportView report={d.quality_report} />
      </div>
      {blocked && <p className="mx-4 mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{blocked}</p>}
      {canEdit && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/70 px-4 py-2.5">
          <input className="input h-7 min-w-40 flex-1 text-xs" placeholder="Optional comment" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
          <Button size="sm" variant="success" icon={<Check className="h-3.5 w-3.5" />} loading={busy === 'approve'} disabled={!!busy} onClick={() => decide('approve')}>
            Approve
          </Button>
          <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={busy === 'reject'} disabled={!!busy} onClick={() => decide('reject')}>
            Reject
          </Button>
        </footer>
      )}
      {open && <DraftDrawer draftId={d.id} onClose={() => setOpen(false)} onChanged={onChanged} />}
    </article>
  );
}

export function ApprovalsPage() {
  const { data, error, loading, reload } = useProjectApi<ApprovalsResponse>('/approvals');
  const { canEdit, isAdmin } = useAuth();
  const { refreshCounts } = useProject();
  const [risk, setRisk] = useState<'all' | 'high' | 'medium' | 'low'>('all');
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (data) refreshCounts();
  }, [data, refreshCounts]);

  const recs = useMemo(() => {
    const all = data?.recommendations ?? [];
    const sorted = [...all].sort((a, b) => Number(isHighRisk(b)) - Number(isHighRisk(a)) || ['high', 'medium', 'low'].indexOf(a.risk) - ['high', 'medium', 'low'].indexOf(b.risk) || b.priority_score - a.priority_score);
    return risk === 'all' ? sorted : sorted.filter((r) => r.risk === risk);
  }, [data, risk]);
  const riskCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of data?.recommendations ?? []) m[r.risk] = (m[r.risk] ?? 0) + 1;
    return m;
  }, [data]);

  return (
    <div>
      <PageHeader
        title={data ? `${data.total} pending` : 'Approvals'}
        description="Nothing changes on the website until a human approves it. Review the evidence and the exact change, then approve, edit or reject."
        actions={
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            {canEdit ? (isAdmin ? 'You can approve all risk levels' : 'You can approve low and medium risk') : 'Read-only (viewer)'}
          </span>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-8">
          {data.total === 0 && <EmptyState icon={<ShieldCheck className="h-6 w-6" />} title="All caught up" description="There is nothing waiting for review. New items appear here after crawls, keyword analysis or content generation." />}

          {data.recommendations.length > 0 && (
            <section>
              <SectionHeader title="Recommendations" count={data.recommendations.length}>
                <Segmented
                  label="Filter by risk"
                  value={risk}
                  onChange={setRisk}
                  options={[
                    { value: 'all', label: `All ${data.recommendations.length}` },
                    { value: 'high', label: `High ${riskCounts.high ?? 0}` },
                    { value: 'medium', label: `Medium ${riskCounts.medium ?? 0}` },
                    { value: 'low', label: `Low ${riskCounts.low ?? 0}` },
                  ]}
                />
                <Button size="sm" variant="ghost" onClick={() => setCompact((c) => !c)}>
                  {compact ? 'Expand all' : 'Collapse all'}
                </Button>
              </SectionHeader>
              <div className="space-y-3">
                {recs.map((r) => (
                  <RecommendationCard key={`${r.id}-${compact}`} rec={r} onChanged={reload} defaultExpanded={!compact} />
                ))}
                {!recs.length && <p className="text-sm text-gray-500">No pending recommendations with this risk level.</p>}
              </div>
            </section>
          )}

          {data.briefs.length > 0 && (
            <section>
              <SectionHeader title="Content briefs" count={data.briefs.length} />
              <div className="space-y-3">
                {data.briefs.map((b) => (
                  <BriefApproval key={b.id} b={b} onChanged={reload} />
                ))}
              </div>
            </section>
          )}

          {data.drafts.length > 0 && (
            <section>
              <SectionHeader title="Drafts" count={data.drafts.length} />
              <div className="space-y-3">
                {data.drafts.map((d) => (
                  <DraftApproval key={d.id} d={d} onChanged={reload} />
                ))}
              </div>
            </section>
          )}

          <section>
            <SectionHeader title="Recent decisions" count={data.recentDecisions.length} />
            <div className="card overflow-hidden">
              {data.recentDecisions.length ? (
                <ul className="divide-y divide-gray-100">
                  {data.recentDecisions.map((d) => (
                    <li key={d.id} className="flex flex-wrap items-start gap-3 px-4 py-2.5 text-sm">
                      <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', d.decision === 'approved' ? 'bg-emerald-500' : d.decision === 'rejected' ? 'bg-red-500' : 'bg-amber-500')} />
                      <div className="min-w-0 flex-1">
                        <div className="text-gray-900">
                          <StatusPill status={d.decision} /> <span className="ml-1">{d.recommendation_title ?? (d.brief_id ? 'Content brief' : d.draft_id ? 'Content draft' : 'Item')}</span>
                        </div>
                        <div className="mt-0.5 text-xs text-gray-500">
                          by {d.reviewer_label ?? 'unknown'} · {fmtDateTime(d.created_at)}
                          {d.comment && <> · “{d.comment}”</>}
                          {d.edited_value && <> · edited value recorded</>}
                        </div>
                      </div>
                      {d.change_id && <span className="text-xs text-gray-400">{humanize('change queued')}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-4 text-sm text-gray-500">No decisions recorded yet.</p>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
