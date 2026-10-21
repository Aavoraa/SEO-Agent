import { useState, type ReactNode } from 'react';
import { AlertOctagon, Check, Eye, ExternalLink, Pencil, Send, Sparkles, X } from 'lucide-react';
import { api } from '../api/client';
import type { Recommendation, ScoreFactor } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useAction } from '../hooks/useAction';
import { cx, fmtDateTime, humanize, isCodeLike, pathOf } from '../lib/format';
import { AiPill, Pill, PriorityBadge, RiskBadge, StatusPill } from './Badges';
import { LabelValues, JsonView } from './JsonView';
import { Button, Tooltip } from './ui';
import { FilePreview, WordDiff } from './ChangeWorkflow';

export const HIGH_RISK_TYPES = ['canonical', 'redirect', 'robots', 'noindex', 'sitemap', 'new_page', 'technical'];
export const isHighRisk = (r: Pick<Recommendation, 'risk' | 'type'>) => r.risk === 'high' || r.risk === 'critical' || HIGH_RISK_TYPES.includes(r.type);
export const isCritical = (r: Pick<Recommendation, 'risk'>) => r.risk === 'critical';
const AI_PROPOSAL_TYPES = ['title', 'meta_description', 'h1'];

export function ValueBox({ label, value, tone }: { label: string; value: string | null; tone: 'old' | 'new' }) {
  const code = isCodeLike(value);
  return (
    <div className={cx('min-w-0 rounded-md border', tone === 'old' ? 'border-gray-200 bg-gray-50' : 'border-emerald-200 bg-emerald-50/50')}>
      <div className={cx('border-b px-3 py-1.5 text-[11px] font-semibold tracking-wide uppercase', tone === 'old' ? 'border-gray-200 text-gray-500' : 'border-emerald-200 text-emerald-700')}>{label}</div>
      {value ? (
        code ? (
          <pre className="max-h-72 overflow-auto p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-gray-800">{value}</pre>
        ) : (
          <p className="p-3 text-sm break-words text-gray-900">{value}</p>
        )
      ) : (
        <p className="p-3 text-sm text-gray-400 italic">{tone === 'old' ? 'Not present' : 'No concrete value – follow the recommendation text'}</p>
      )}
    </div>
  );
}

export function CurrentVsProposed({ current, proposed }: { current: string | null; proposed: string | null }) {
  const textual = !!current && !!proposed && !isCodeLike(current) && !isCodeLike(proposed) && current.length < 2000;
  return (
    <div className="space-y-2">
      <div className="grid gap-3 md:grid-cols-2">
        <ValueBox label="Current" value={current} tone="old" />
        <ValueBox label="Proposed" value={proposed} tone="new" />
      </div>
      {textual && <WordDiff before={current} after={proposed} />}
    </div>
  );
}

export function ScoreBreakdown({ score, factors, reasons }: { score?: number; factors?: ScoreFactor[] | null; reasons?: string[] | null }) {
  return (
    <div className="space-y-2">
      {score !== undefined && (
        <div className="text-xs text-gray-500">
          Priority score <span className="font-semibold tabular text-gray-900">{Math.round(score)}</span>/100 · transparent weighted factors (0–5 each)
        </div>
      )}
      {factors && factors.length > 0 && (
        <div className="max-w-2xl space-y-1.5">
          {factors.map((f) => (
            <div key={f.name} className="grid grid-cols-[140px_1fr_auto] items-center gap-2 text-xs">
              <span className="truncate text-gray-600" title={f.note}>
                {f.name}
              </span>
              <Tooltip content={f.note} className="block w-full">
                <span className="block h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                  <span className="block h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, (f.value / 5) * 100)}%` }} />
                </span>
              </Tooltip>
              <span className="w-20 text-right tabular text-gray-500">
                {f.value.toFixed(1)} × {Math.round(f.weight * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
      {reasons && reasons.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-600">
          {reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 md:grid-cols-[130px_1fr] md:gap-4">
      <div className="pt-0.5 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">{label}</div>
      <div className="min-w-0 text-sm text-gray-800">{children}</div>
    </div>
  );
}

/**
 * Full "WHAT / WHY / EVIDENCE / RECOMMENDATION / RISK / PURPOSE" card with approval actions.
 * `onChanged` is called after a successful mutation so the parent can reload.
 */
export function RecommendationCard({ rec, onChanged, showWorkflow, defaultExpanded = true }: { rec: Recommendation; onChanged: () => void; showWorkflow?: boolean; defaultExpanded?: boolean }) {
  const { canEdit, isAdmin } = useAuth();
  const { base, refreshCounts } = useProject();
  const { busy, run } = useAction();
  const [comment, setComment] = useState('');
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(rec.proposed_value ?? '');
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSeen, setPreviewSeen] = useState(false);

  const high = isHighRisk(rec);
  const critical = isCritical(rec);
  const decidable = ['recommended', 'pending_approval', 'analyzed', 'detected'].includes(rec.status);
  const blockedForRole = critical || (high && !isAdmin);
  // High risk: the reviewer must have opened the preview before approving (enforced by the API too).
  const needsPreview = high && !critical && !previewSeen;
  const evidence = Array.isArray(rec.evidence) ? (rec.evidence as { label: string; value: unknown }[]) : null;

  const decide = (decision: 'approve' | 'reject', editedValue?: string) =>
    run(
      decision,
      () => api(`${base}/recommendations/${rec.id}/decision`, { body: { decision, comment: comment.trim() || undefined, editedValue, previewConfirmed: previewSeen || undefined } }),
      decision === 'approve' ? (editedValue !== undefined ? 'Approved with edits – change queued for implementation' : 'Approved – change queued for implementation') : 'Recommendation rejected',
    ).then((r) => {
      if (r) {
        setEditing(false);
        refreshCounts();
        onChanged();
      }
    });

  const approveBtn = (
    <Button variant="success" size="sm" icon={<Check className="h-3.5 w-3.5" />} loading={busy === 'approve'} disabled={!!busy || blockedForRole || needsPreview} onClick={() => decide('approve')}>
      Approve
    </Button>
  );

  return (
    <article className={cx('card overflow-hidden', high && 'border-red-200')}>
      <header className="flex flex-wrap items-start gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <RiskBadge risk={rec.risk} />
            <PriorityBadge priority={rec.priority} />
            <Pill>{humanize(rec.type)}</Pill>
            <Pill tone="gray">Source: {humanize(rec.source)}</Pill>
            {rec.ai_generated && <AiPill model={rec.ai_model} />}
            {rec.status !== 'pending_approval' && <StatusPill status={rec.status} />}
          </div>
          <h3 className="text-sm font-semibold text-gray-900">{rec.title}</h3>
          {rec.page_url && (
            <a href={rec.page_url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-800">
              {pathOf(rec.page_url)} <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          <span className="text-lg font-semibold tabular text-gray-900">{Math.round(rec.priority_score)}</span>
          <span className="text-[11px] text-gray-500">priority score</span>
        </div>
      </header>

      {high && (
        <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          <AlertOctagon className="mt-px h-4 w-4 shrink-0" />
          <span>
            {critical ? (
              <>
                <strong>Critical:</strong> never executed by the platform (files, auth, database, DNS or server configuration). Do it manually with your hosting provider.
              </>
            ) : (
              <>
                <strong>High risk:</strong> changes URLs / indexing / templates – admin approval after reviewing the preview. Verify the target on staging before applying.
              </>
            )}
          </span>
        </div>
      )}

      {expanded ? (
        <div className="space-y-3 border-t border-gray-100 px-4 py-4">
          <Section label="What">{rec.what ?? '—'}</Section>
          <Section label="Why">{rec.why ?? '—'}</Section>
          <Section label="Evidence">{evidence ? <LabelValues items={evidence} /> : <JsonView value={rec.evidence} />}</Section>
          <Section label="Recommendation">
            {editing ? (
              <div className="space-y-2">
                <textarea className="input w-full font-mono text-xs" rows={Math.min(16, Math.max(4, (edited.match(/\n/g)?.length ?? 0) + 2))} value={edited} onChange={(e) => setEdited(e.target.value)} aria-label="Edited proposed value" />
                <div className="flex gap-2">
                  <Button size="sm" variant="success" loading={busy === 'approve'} disabled={!edited.trim() || blockedForRole || needsPreview} onClick={() => decide('approve', edited)} icon={<Check className="h-3.5 w-3.5" />}>
                    Approve edited value
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <CurrentVsProposed current={rec.current_value} proposed={rec.proposed_value} />
            )}
            {previewOpen && (
              <div className="mt-3">
                <FilePreview recId={rec.id} onLoaded={() => setPreviewSeen(true)} />
              </div>
            )}
          </Section>
          <Section label="Risk">
            <span className="inline-flex items-center gap-2">
              <RiskBadge risk={rec.risk} /> {rec.confidence && <span className="text-xs text-gray-500">Confidence: {humanize(rec.confidence)}</span>}
            </span>
          </Section>
          <Section label="Expected purpose">{rec.expected_purpose ?? '—'}</Section>
          <Section label="Priority">
            <ScoreBreakdown factors={rec.score_breakdown?.factors} reasons={rec.score_breakdown?.reasons} />
          </Section>
          <p className="text-[11px] text-gray-400">
            Created {fmtDateTime(rec.created_at)} · ID {rec.id.slice(0, 8)}
          </p>
        </div>
      ) : (
        <div className="border-t border-gray-100 px-4 py-2">
          <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => setExpanded(true)}>
            Show what / why / evidence
          </button>
        </div>
      )}

      {canEdit && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50/70 px-4 py-2.5">
          {decidable && (
            <>
              <input className="input h-7 min-w-40 flex-1 text-xs" placeholder="Optional comment for the audit trail" value={comment} onChange={(e) => setComment(e.target.value)} aria-label="Comment" />
              <Button size="sm" icon={<Eye className="h-3.5 w-3.5" />} disabled={!rec.proposed_value} onClick={() => { setPreviewOpen((v) => !v); setExpanded(true); }}>
                {previewOpen ? 'Hide preview' : 'Preview fix'}
              </Button>
              {blockedForRole ? <Tooltip content={critical ? 'Critical changes are never executed by the platform' : 'Admin approval required'}>{approveBtn}</Tooltip> : needsPreview ? <Tooltip content="Open the preview before approving a high-risk change">{approveBtn}</Tooltip> : approveBtn}
              <Tooltip content={blockedForRole ? 'Admin approval required' : null}>
                <Button size="sm" icon={<Pencil className="h-3.5 w-3.5" />} disabled={!!busy || blockedForRole} onClick={() => { setEdited(rec.proposed_value ?? rec.current_value ?? ''); setEditing(true); setExpanded(true); }}>
                  Edit
                </Button>
              </Tooltip>
              <Button size="sm" variant="danger" icon={<X className="h-3.5 w-3.5" />} loading={busy === 'reject'} disabled={!!busy} onClick={() => decide('reject')}>
                Reject
              </Button>
            </>
          )}
          {showWorkflow && AI_PROPOSAL_TYPES.includes(rec.type) && !rec.proposed_value && decidable && (
            <Button
              size="sm"
              icon={<Sparkles className="h-3.5 w-3.5" />}
              loading={busy === 'generate'}
              disabled={!!busy}
              onClick={() => run('generate', () => api(`${base}/recommendations/${rec.id}/generate`, { method: 'POST' }), 'AI proposal generated – review it before approving').then((r) => r !== undefined && onChanged())}
            >
              Generate AI proposal
            </Button>
          )}
          {showWorkflow && rec.status === 'recommended' && (
            <Button
              size="sm"
              icon={<Send className="h-3.5 w-3.5" />}
              loading={busy === 'submit'}
              disabled={!!busy}
              onClick={() => run('submit', () => api(`${base}/recommendations/${rec.id}/submit`, { method: 'POST' }), 'Submitted for approval').then((r) => { if (r !== undefined) { refreshCounts(); onChanged(); } })}
            >
              Submit for approval
            </Button>
          )}
          {!decidable && <span className="text-xs text-gray-500">No actions – this recommendation is {humanize(rec.status).toLowerCase()}.</span>}
        </footer>
      )}
    </article>
  );
}
