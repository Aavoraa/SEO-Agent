import { useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, RefreshCw, X, XCircle } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { Brief, Draft, QualityReport } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, humanize, pathOf } from '../lib/format';
import { Pill, StatusPill } from './Badges';
import { Markdown } from './Markdown';
import { Button, ErrorBox, Loading } from './ui';
import { Drawer } from './Overlay';

function H({ children }: { children: string }) {
  return <h4 className="mb-1.5 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">{children}</h4>;
}

export function BriefView({ brief }: { brief: Brief }) {
  return (
    <div className="space-y-5 text-sm">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <H>Suggested title</H>
          <p className="font-medium text-gray-900">{brief.suggestedTitle ?? '—'}</p>
        </div>
        <div>
          <H>H1</H>
          <p className="font-medium text-gray-900">{brief.h1 ?? '—'}</p>
        </div>
        <div className="md:col-span-2">
          <H>Meta description</H>
          <p className="text-gray-800">{brief.metaDescription ?? '—'}</p>
        </div>
        <div>
          <H>Search intent / audience</H>
          <p className="text-gray-800">
            {brief.searchIntent ?? '—'}
            {brief.targetAudience && <span className="block text-gray-600">{brief.targetAudience}</span>}
          </p>
        </div>
        <div>
          <H>Length / CTA</H>
          <p className="text-gray-800">
            {brief.wordCountRange ?? '—'} words · CTA: {brief.cta ?? '—'}
          </p>
        </div>
      </div>
      {brief.outline && brief.outline.length > 0 && (
        <div>
          <H>Outline</H>
          <ol className="space-y-2">
            {brief.outline.map((o, i) => (
              <li key={i} className="rounded-md border border-gray-200 px-3 py-2">
                <div className="font-medium text-gray-900">
                  <span className="mr-1.5 font-mono text-[11px] text-gray-400">H2</span>
                  {o.h2}
                </div>
                {o.h3s.length > 0 && (
                  <ul className="mt-1 space-y-0.5 pl-5">
                    {o.h3s.map((h, j) => (
                      <li key={j} className="text-gray-700">
                        <span className="mr-1.5 font-mono text-[11px] text-gray-400">H3</span>
                        {h}
                      </li>
                    ))}
                  </ul>
                )}
                {o.notes && <p className="mt-1 text-xs text-gray-500">{o.notes}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {brief.faqs && brief.faqs.length > 0 && (
        <div>
          <H>FAQs</H>
          <dl className="space-y-2">
            {brief.faqs.map((q, i) => (
              <div key={i}>
                <dt className="font-medium text-gray-900">{q.question}</dt>
                <dd className="text-gray-600">{q.answerGuidance}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        {brief.internalLinks && brief.internalLinks.length > 0 && (
          <div>
            <H>Internal links</H>
            <ul className="space-y-1">
              {brief.internalLinks.map((l, i) => (
                <li key={i}>
                  <span className="font-mono text-xs">{pathOf(l.url)}</span> – “{l.anchor}” <span className="text-xs text-gray-500">{l.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {brief.factsNeededFromBusiness && brief.factsNeededFromBusiness.length > 0 && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
            <H>Facts needed from Phoenixx IT</H>
            <ul className="list-disc space-y-0.5 pl-4 text-amber-900">
              {brief.factsNeededFromBusiness.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}
        {brief.entities && brief.entities.length > 0 && (
          <div>
            <H>Entities to cover</H>
            <div className="flex flex-wrap gap-1">
              {brief.entities.map((e) => (
                <Pill key={e}>{e}</Pill>
              ))}
            </div>
          </div>
        )}
        {brief.schemaRecommendations && brief.schemaRecommendations.length > 0 && (
          <div>
            <H>Schema</H>
            <p className="text-gray-800">{brief.schemaRecommendations.join(', ')}</p>
          </div>
        )}
        {brief.avoid && brief.avoid.length > 0 && (
          <div>
            <H>Avoid</H>
            <ul className="list-disc space-y-0.5 pl-4 text-gray-700">
              {brief.avoid.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const checkIcon = { pass: <CheckCircle2 className="h-4 w-4 text-emerald-600" />, warn: <AlertTriangle className="h-4 w-4 text-amber-500" />, fail: <XCircle className="h-4 w-4 text-red-600" /> };

export function QualityReportView({ report }: { report: QualityReport | null }) {
  if (!report) return <p className="text-sm text-gray-500">No quality report yet.</p>;
  const ai = report.ai as { verdict?: string; summary?: string; unsupportedClaims?: string[]; error?: string } | null | undefined;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-2xl font-semibold tabular">{report.score}</span>
        <span className="text-xs text-gray-500">/100 quality score</span>
        <Pill tone={report.verdict === 'ready_for_review' ? 'green' : report.verdict === 'reject' ? 'red' : 'amber'}>{humanize(report.verdict)}</Pill>
        {!!report.placeholders && <Pill tone="amber">{report.placeholders} [NEEDS INPUT] placeholder(s)</Pill>}
      </div>
      <ul className="divide-y divide-gray-100 rounded-md border border-gray-200">
        {report.checks.map((c) => (
          <li key={c.id} className="flex items-start gap-2 px-3 py-2 text-sm">
            {checkIcon[c.status]}
            <span className="min-w-0 flex-1 text-gray-900">{c.label}</span>
            <span className={cx('max-w-[55%] text-right text-xs', c.status === 'fail' ? 'text-red-700' : c.status === 'warn' ? 'text-amber-700' : 'text-gray-500')}>{c.detail}</span>
          </li>
        ))}
      </ul>
      {report.flaggedClaims && report.flaggedClaims.length > 0 && (
        <div className="text-sm">
          <H>Flagged claims (verify or remove)</H>
          <ul className="list-disc pl-4 text-red-800">
            {report.flaggedClaims.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {ai && (ai.summary || ai.error) && (
        <div className="rounded-md border border-violet-200 bg-violet-50/50 p-3 text-sm">
          <H>AI editorial review</H>
          {ai.error ? <p className="text-red-700">{ai.error}</p> : <p className="text-gray-800">{ai.summary}</p>}
        </div>
      )}
    </div>
  );
}

/** Drawer showing a draft with rendered markdown + quality checks + decision actions. */
export function DraftDrawer({ draftId, onClose, onChanged }: { draftId: string; onClose: () => void; onChanged: () => void }) {
  const { base, refreshCounts } = useProject();
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useApi<Draft>(`${base}/content/drafts/${draftId}`);
  const { busy, run } = useAction();
  const [comment, setComment] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);

  const decide = async (decision: 'approve' | 'reject') => {
    setBlockError(null);
    try {
      await api(`${base}/content/drafts/${draftId}/decision`, { body: { decision, comment: comment || undefined } });
      refreshCounts();
      onChanged();
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'placeholders') setBlockError(e.message);
      else setBlockError((e as Error).message);
    }
  };

  return (
    <Drawer
      open
      onClose={onClose}
      width="max-w-5xl"
      title={data?.title ?? 'Draft'}
      subtitle={data && <span className="inline-flex items-center gap-2">v{data.version} · <StatusPill status={data.status} /> {data.ai_model && <span>model {data.ai_model}</span>}</span>}
    >
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          <div className="min-w-0">
            {data.meta?.metaDescription && (
              <p className="mb-4 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
                <span className="font-semibold">Meta description:</span> {data.meta.metaDescription}
              </p>
            )}
            <Markdown source={data.body_markdown ?? ''} />
          </div>
          <aside className="space-y-4">
            <QualityReportView report={data.quality_report} />
            {canEdit && (
              <div className="space-y-2 border-t border-gray-200 pt-4">
                <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === 'quality'} onClick={() => run('quality', () => api(`${base}/content/drafts/${draftId}/quality`, { method: 'POST' }), 'Quality check re-run').then((r) => r && (reload(), onChanged()))}>
                  Re-run quality check
                </Button>
                {['pending_approval', 'draft'].includes(data.status) && (
                  <>
                    <textarea className="input w-full text-xs" rows={2} placeholder="Optional comment" value={comment} onChange={(e) => setComment(e.target.value)} />
                    {blockError && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">{blockError}</p>}
                    <div className="flex gap-2">
                      <Button size="sm" variant="success" icon={<Check className="h-3.5 w-3.5" />} onClick={() => decide('approve')}>
                        Approve
                      </Button>
                      <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} onClick={() => decide('reject')}>
                        Reject
                      </Button>
                    </div>
                    <p className="text-[11px] text-gray-500">Approved drafts are never auto-published. Export the Markdown and publish through your CMS.</p>
                  </>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </Drawer>
  );
}
