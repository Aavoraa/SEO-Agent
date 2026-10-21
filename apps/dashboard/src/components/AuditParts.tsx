import { useMemo, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Bot, CheckCircle2, ExternalLink, Info, Minus, Monitor, Rocket, Smartphone, Sparkles, Tablet, XCircle } from 'lucide-react';
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart, ResponsiveContainer, Tooltip as RTooltip } from 'recharts';
import { api } from '../api/client';
import type { AiExplanation, AuditCategory, AuditCheckRow, AuditGroup, AuditGroupPage, Recommendation } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, humanize, pathOf } from '../lib/format';
import { Pill, RiskBadge, SeverityBadge, PriorityBadge, type Tone } from './Badges';
import { Button, ErrorBox, KeyValues, Loading, Spinner } from './ui';
import { Drawer } from './Overlay';
import { CHART } from './charts';
import { RecommendationCard } from './RecommendationCard';
import { DeploymentProgress } from './ChangeWorkflow';

export const GRADE_LABEL: Record<string, string> = { good: 'Good health', fair: 'Fair', needs_work: 'Needs work', poor: 'Poor', not_measured: 'Not measured' };
export const gradeTone = (s: string): Tone => (s === 'good' ? 'green' : s === 'fair' ? 'blue' : s === 'needs_work' ? 'amber' : s === 'poor' ? 'red' : 'gray');
const scoreColor = (n: number | null) => (n === null ? '#9CA3AF' : n >= 85 ? '#059669' : n >= 70 ? '#2563EB' : n >= 50 ? '#D97706' : '#DC2626');

/* ───────────── Overall score ───────────── */

export function ScoreRing({ score, size = 168 }: { score: number; size?: number }) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`SEO health score ${score} out of 100`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#EEF0F3" strokeWidth={10} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={scoreColor(score)} strokeWidth={10} strokeLinecap="round" strokeDasharray={`${(c * score) / 100} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="48%" textAnchor="middle" dominantBaseline="middle" className="fill-gray-900" style={{ fontSize: size * 0.3, fontWeight: 650 }}>
        {score}
      </text>
      <text x="50%" y="68%" textAnchor="middle" className="fill-gray-400" style={{ fontSize: size * 0.085 }}>
        / 100
      </text>
    </svg>
  );
}

export function Trend({ value, suffix = '' }: { value: number | null | undefined; suffix?: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-gray-400">—</span>;
  if (value === 0) return <span className="inline-flex items-center gap-0.5 text-xs text-gray-500"><Minus className="h-3 w-3" />0{suffix}</span>;
  const up = value > 0;
  return (
    <span className={cx('inline-flex items-center gap-0.5 text-xs font-medium', up ? 'text-emerald-700' : 'text-red-700')}>
      {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {up ? '+' : ''}
      {value}
      {suffix}
    </span>
  );
}

/* ───────────── Category cards ───────────── */

export function CategoryCard({ c, onOpen }: { c: AuditCategory; onOpen: () => void }) {
  const open = Object.entries(c.issues).filter(([s]) => s !== 'info').reduce((a, [, n]) => a + n, 0);
  return (
    <button onClick={onOpen} className="card flex flex-col gap-2 px-3.5 py-3 text-left transition-colors hover:border-gray-300">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-gray-600">{c.label}</span>
        <Trend value={c.trend} />
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl leading-none font-semibold tabular" style={{ color: scoreColor(c.score) }}>
          {c.score ?? 'n/a'}
        </span>
        <Pill tone={gradeTone(c.status)}>{GRADE_LABEL[c.status]}</Pill>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-gray-100">
        <div className="h-full rounded-full" style={{ width: `${c.score ?? 0}%`, background: scoreColor(c.score) }} />
      </div>
      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <span>
          {open} issue{open === 1 ? '' : 's'} · {c.passed}/{c.checks} checks
        </span>
        <span className="font-medium text-brand-700">View details</span>
      </div>
      {c.coverage === 'partial' && (
        <span className="inline-flex items-start gap-1 text-[11px] text-amber-700">
          <Info className="mt-px h-3 w-3 shrink-0" /> Partial coverage
        </span>
      )}
    </button>
  );
}

/* ───────────── Radar ───────────── */

export function CategoryRadar({ categories }: { categories: AuditCategory[] }) {
  const data = categories.filter((c) => c.score !== null).map((c) => ({ label: c.label.replace(' SEO', ''), score: c.score }));
  return (
    <div style={{ height: 300 }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke={CHART.grid} />
          <PolarAngleAxis dataKey="label" tick={{ fontSize: 11, fill: '#4B5563' }} />
          <PolarRadiusAxis domain={[0, 100]} tick={{ fontSize: 9, fill: CHART.axis }} tickCount={5} axisLine={false} />
          <Radar name="Score" dataKey="score" stroke={CHART.primary} fill={CHART.primary} fillOpacity={0.18} strokeWidth={2} />
          <RTooltip formatter={(v) => [`${v}/100`, 'Score']} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ───────────── Website preview (sandboxed) ───────────── */

const DEVICES = [
  { id: 'desktop', label: 'Desktop', width: 1280, icon: Monitor },
  { id: 'tablet', label: 'Tablet', width: 820, icon: Tablet },
  { id: 'mobile', label: 'Mobile', width: 390, icon: Smartphone },
] as const;

/**
 * The page is rendered in a sandboxed frame WITHOUT allow-same-origin: its scripts run in an opaque
 * origin, so they can't read this app, its storage or cookies, open pop-ups, submit forms or navigate
 * the dashboard.
 */
export function SitePreview({ url, embeddable, reason, demo }: { url: string; embeddable: boolean | null; reason: string | null; demo: boolean }) {
  const [dev, setDev] = useState<(typeof DEVICES)[number]['id']>('desktop');
  const d = DEVICES.find((x) => x.id === dev)!;
  const frameH = 620;
  const boxW = dev === 'desktop' ? 640 : dev === 'tablet' ? 410 : 300;
  const scale = boxW / d.width;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-gray-200 bg-white p-0.5">
          {DEVICES.map((x) => (
            <button key={x.id} onClick={() => setDev(x.id)} className={cx('inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium', dev === x.id ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}>
              <x.icon className="h-3.5 w-3.5" /> {x.label}
            </button>
          ))}
        </div>
        {demo && <Pill tone="violet">DEMO copy</Pill>}
        <a href={url} target="_blank" rel="noopener noreferrer" className="ml-auto inline-flex items-center gap-1 truncate text-xs text-gray-500 hover:text-gray-800">
          {url} <ExternalLink className="h-3 w-3" />
        </a>
      </div>
      {embeddable === false ? (
        <div className="flex h-60 items-center justify-center rounded-md border border-dashed border-gray-300 bg-gray-50 px-6 text-center text-sm text-gray-600">{reason ?? 'This site cannot be shown in a frame.'} Open it in a new tab instead.</div>
      ) : (
        <div className="flex justify-center overflow-hidden rounded-md border border-gray-200 bg-gray-50 py-3">
          <div style={{ width: boxW, height: frameH * scale }} className="overflow-hidden rounded border border-gray-300 bg-white shadow-sm">
            <iframe
              key={`${url}:${dev}`}
              src={url}
              title={`Preview of ${url} (${d.label})`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              loading="lazy"
              style={{ width: d.width, height: frameH, transform: `scale(${scale})`, transformOrigin: '0 0', border: 0 }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────────── Checks table for a category ───────────── */

export function ChecksList({ checks }: { checks: AuditCheckRow[] }) {
  const sorted = useMemo(() => [...checks].sort((a, b) => a.passed / a.evaluated - b.passed / b.evaluated), [checks]);
  if (!checks.length) return <p className="px-4 py-3 text-sm text-gray-500">No checks in this category.</p>;
  return (
    <ul className="divide-y divide-gray-100">
      {sorted.map((c) => {
        const ok = c.passed === c.evaluated;
        return (
          <li key={c.id} className="flex items-start gap-3 px-4 py-2">
            {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm text-gray-900">{c.label}</div>
              {c.detail && <div className="truncate text-xs text-gray-500">{c.detail}</div>}
            </div>
            <span className="shrink-0 text-xs tabular text-gray-600">
              {c.evaluated > 1 ? `${c.passed}/${c.evaluated} pages pass` : ok ? 'Pass' : 'Fail'}
            </span>
            {!ok && <SeverityBadge severity={c.severity} />}
          </li>
        );
      })}
    </ul>
  );
}

/* ───────────── Recommendation drawer (explain → fix → preview → approve → deploy) ───────────── */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">{label}</h4>
      <div className="text-sm text-gray-800">{children}</div>
    </section>
  );
}

function PageFix({ page, group, onChanged }: { page: AuditGroupPage; group: AuditGroup; onChanged: () => void }) {
  const { base } = useProject();
  const { canEdit } = useAuth();
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const rec = useApi<Recommendation>(open && page.recommendationId ? `${base}/recommendations/${page.recommendationId}` : null);
  const reload = () => {
    rec.reload();
    onChanged();
  };
  const oneClick = group.risk === 'low' && group.deployable;
  return (
    <li className="rounded-md border border-gray-200">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block font-mono text-xs text-gray-900">{page.url ? pathOf(page.url) : 'Site-wide'}</span>
          <span className="block text-xs text-gray-500">{page.found}</span>
        </span>
        {page.recommendationStatus && <Pill tone="gray">{humanize(page.recommendationStatus)}</Pill>}
        {page.recommendationId ? (
          <Button size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? 'Close' : 'Open fix'}
          </Button>
        ) : (
          <span className="text-xs text-gray-400">No automated fix – see action</span>
        )}
      </div>
      {open && (
        <div className="space-y-3 border-t border-gray-100 bg-gray-50/50 p-3">
          {rec.error && <ErrorBox error={rec.error} onRetry={rec.reload} />}
          {!rec.data && rec.loading && <Loading />}
          {rec.data && (
            <>
              {canEdit && group.canFixWithAi && !rec.data.proposed_value && (
                <Button size="sm" variant="primary" icon={<Sparkles className="h-3.5 w-3.5" />} loading={busy === 'ai'} onClick={() => run('ai', () => api(`${base}/recommendations/${rec.data!.id}/generate`, { method: 'POST' }), 'AI proposal ready – review the before/after').then((r) => r && reload())}>
                  Fix with AI
                </Button>
              )}
              <RecommendationCard rec={rec.data} onChanged={reload} showWorkflow defaultExpanded />
              {canEdit && oneClick && rec.data.proposed_value && ['recommended', 'pending_approval'].includes(rec.data.status) && !deploymentId && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
                  <Rocket className="h-3.5 w-3.5" /> Low-risk change: approve and deploy in one step (backup, deploy, verify, re-score).
                  <Button
                    size="sm"
                    variant="success"
                    className="ml-auto"
                    loading={busy === 'deploy'}
                    onClick={() =>
                      run('deploy', () => api<{ deployment: { deploymentId: string } | null; note?: string | null }>(`${base}/recommendations/${rec.data!.id}/approve-and-deploy`, { body: {} }), (r) => (r.deployment ? 'Approved – deploying' : r.note ?? 'Approved')).then((r) => {
                        if (r?.deployment) setDeploymentId(r.deployment.deploymentId);
                        reload();
                      })
                    }
                  >
                    Approve &amp; deploy
                  </Button>
                </div>
              )}
              {deploymentId && <DeploymentProgress deploymentId={deploymentId} onDone={reload} />}
            </>
          )}
        </div>
      )}
    </li>
  );
}

export function RecommendationDrawer({ group, onClose, onChanged, tab }: { group: AuditGroup | null; onClose: () => void; onChanged: () => void; tab?: 'pages' | 'all' }) {
  const { base } = useProject();
  const { canEdit } = useAuth();
  const { busy, run } = useAction();
  const [explain, setExplain] = useState<AiExplanation | null>(null);
  const firstRec = group?.pages.find((p) => p.recommendationId)?.recommendationId ?? null;
  if (!group) return null;
  return (
    <Drawer
      open={!!group}
      onClose={() => {
        setExplain(null);
        onClose();
      }}
      title={group.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-1.5">
          <Pill>{humanize(group.category)}</Pill>
          <SeverityBadge severity={group.severity} />
          {group.priority && <PriorityBadge priority={group.priority} />}
          <RiskBadge risk={group.risk} />
          <span className="text-xs text-gray-500">{group.affected} page(s)</span>
        </span>
      }
    >
      <div className="space-y-5">
        {tab !== 'pages' && (
          <>
            <Section label="Why this matters">{group.rationale ?? '—'}</Section>
            <Section label="What the crawler found">
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {group.pages.slice(0, 12).map((p) => (
                  <li key={p.issueId}>
                    {p.url && <span className="font-mono text-xs">{pathOf(p.url)} – </span>}
                    {p.found}
                  </li>
                ))}
                {group.pages.length > 12 && <li className="text-gray-500">…and {group.pages.length - 12} more</li>}
              </ul>
            </Section>
            <Section label="Recommended action">{group.action ?? '—'}</Section>
            <Section label="Expected SEO impact">{group.expectedOutcome ?? '—'}</Section>
            <KeyValues
              items={[
                { label: 'Impact', value: group.impact !== null ? `${group.impact}/5` : '—' },
                { label: 'Effort', value: group.effort !== null ? `${group.effort}/5` : '—' },
                { label: 'Confidence', value: group.confidence ? humanize(group.confidence) : '—' },
                { label: 'Risk', value: group.risk ? humanize(group.risk) : '—' },
                { label: 'Business value', value: group.businessValue !== null ? `${group.businessValue}/5` : '—' },
                { label: 'Change type', value: group.changeType ? humanize(group.changeType) : 'Manual' },
              ]}
            />
            <Section label="AI explanation">
              {explain ? (
                <div className="space-y-3 rounded-md border border-gray-200 bg-white p-3">
                  <p>{explain.explanation.whyItMatters}</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-emerald-700 uppercase">Observed (from the evidence)</div>
                      <ul className="list-disc space-y-0.5 pl-5 text-xs">{explain.explanation.observed.map((x, i) => <li key={i}>{x}</li>)}</ul>
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-blue-700 uppercase">Inferred (AI reasoning)</div>
                      <ul className="list-disc space-y-0.5 pl-5 text-xs">{explain.explanation.inferred.map((x, i) => <li key={i}>{x}</li>)}</ul>
                    </div>
                  </div>
                  <p className="text-xs"><strong>Expected impact:</strong> {explain.explanation.expectedImpact}</p>
                  {explain.explanation.caveats.length > 0 && <p className="text-xs text-amber-800"><strong>Caveats:</strong> {explain.explanation.caveats.join(' ')}</p>}
                  <details className="text-xs text-gray-600">
                    <summary className="cursor-pointer font-medium">Exact evidence given to the AI ({explain.evidence.length} lines)</summary>
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-[11px]">{explain.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
                  </details>
                  <p className="text-[11px] text-gray-400">{explain.model}{explain.cached ? ' · cached' : ''} · {explain.disclaimer}</p>
                </div>
              ) : canEdit && firstRec ? (
                <Button size="sm" icon={<Bot className="h-3.5 w-3.5" />} loading={busy === 'explain'} onClick={() => run('explain', () => api<AiExplanation>(`${base}/recommendations/${firstRec}/explain`, { method: 'POST' })).then((r) => r && setExplain(r))}>
                  Ask AI to explain
                </Button>
              ) : (
                <span className="text-xs text-gray-500">{firstRec ? 'Editors can ask the AI to explain this finding.' : 'No recommendation record to explain yet – run a new audit.'}</span>
              )}
            </Section>
          </>
        )}
        <Section label={`Affected pages (${group.pages.length}) – current → recommended state`}>
          <ul className="space-y-2">{group.pages.map((p) => <PageFix key={p.issueId} page={p} group={group} onChanged={onChanged} />)}</ul>
        </Section>
        {!group.deployable && (
          <p className="flex items-start gap-1.5 text-xs text-gray-500">
            <Info className="mt-px h-3.5 w-3.5 shrink-0" /> This type of change isn't deployed automatically: after approval it's exported as instructions for your developer.
          </p>
        )}
      </div>
    </Drawer>
  );
}

export { Spinner };
