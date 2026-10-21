import { Link } from 'react-router-dom';
import { ArrowRight, Bot, CheckCircle2, Clock, Database, Info, Rocket, ShieldCheck, Sparkles, X } from 'lucide-react';
import { OPPORTUNITY_CATEGORY_LABEL, type CommandCenterData, type NextBestAction, type Opportunity } from '../api/types';
import { cx, fmtRelative, humanize, pathOf } from '../lib/format';
import { Pill, type Tone } from './Badges';
import { Button, Tooltip } from './ui';

export const CATEGORY_TONE: Record<Opportunity['category'], Tone> = { quick_win: 'green', high_impact: 'brand', strategic: 'blue', at_risk: 'red', competitive: 'violet', ai_search: 'violet', emerging: 'amber' };
const SOURCE_LABEL: Record<string, string> = { crawler: 'Site crawler', google_search_console: 'Search Console', google_analytics: 'GA4', backlink_import: 'Backlink data', deployment_verification: 'Deployment verification', alerts: 'Alerts' };

export const level = (v: number) => (v >= 0.67 ? 'High' : v >= 0.34 ? 'Medium' : 'Low');

/** Where the user goes to act on an opportunity. */
export function opportunityHref(o: Opportunity): string {
  switch (o.source) {
    case 'audit':
      return '/audit';
    case 'keyword':
      return o.url ? `/keywords` : '/keywords';
    case 'content':
      return '/content';
    case 'internal_link':
      return '/internal-links';
    case 'backlink':
      return '/backlinks';
    case 'deployment':
      return '/changes';
    case 'alert':
      return '/alerts';
    default:
      return '/recommendations';
  }
}

function Meter({ label, value, invert }: { label: string; value: number; invert?: boolean }) {
  const good = invert ? 1 - value : value;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium tracking-wide text-gray-500 uppercase">{label}</div>
      <div className="flex items-center gap-1.5">
        <span className="h-1.5 w-12 overflow-hidden rounded-full bg-gray-100">
          <span className={cx('block h-full rounded-full', good >= 0.67 ? 'bg-emerald-500' : good >= 0.34 ? 'bg-amber-500' : 'bg-gray-400')} style={{ width: `${Math.max(6, value * 100)}%` }} />
        </span>
        <span className="text-xs font-medium text-gray-700">{level(value)}</span>
      </div>
    </div>
  );
}

export function ScoreBreakdownList({ o }: { o: Opportunity }) {
  return (
    <div className="space-y-1 text-xs">
      {o.factors.map((f) => (
        <div key={f.name} className="grid grid-cols-[110px_60px_1fr] items-center gap-2">
          <span className="text-gray-600">{humanize(f.name)}</span>
          <span className="tabular text-gray-900">{f.name === 'memory' ? `×${f.value}` : `+${f.contribution}`}</span>
          <span className="truncate text-gray-500" title={f.note}>{f.note}</span>
        </div>
      ))}
      <p className="pt-1 text-[11px] text-gray-400">Priority = 100 × (0.30·Impact + 0.20·Business value + 0.15·Confidence + 0.15·Ease + 0.10·Urgency + 0.10·Safety) × Memory. No AI judgement enters the score.</p>
    </div>
  );
}

export function OpportunityCard({ o, onStatus, compact }: { o: Opportunity; onStatus?: (status: 'dismissed' | 'snoozed' | 'in_progress') => void; compact?: boolean }) {
  return (
    <article className="card flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <Pill tone={CATEGORY_TONE[o.category]}>{OPPORTUNITY_CATEGORY_LABEL[o.category]}</Pill>
            {o.automatable && (
              <Pill tone="blue" title="A concrete fix can be prepared, previewed, approved and deployed">
                <span className="inline-flex items-center gap-1"><Rocket className="h-3 w-3" /> Fix available</span>
              </Pill>
            )}
            {o.status !== 'open' && <Pill tone="gray">{humanize(o.status)}</Pill>}
          </div>
          <h3 className="text-sm font-semibold text-gray-900">{o.title}</h3>
          <p className="mt-0.5 text-xs text-gray-600">{o.summary}</p>
        </div>
        <Tooltip content={<ScoreBreakdownList o={o} />} className="w-[420px]">
          <div className="flex flex-col items-end">
            <span className="text-xl leading-none font-semibold tabular text-gray-900">{Math.round(o.priority_score)}</span>
            <span className="inline-flex items-center gap-0.5 text-[10px] text-gray-500">priority <Info className="h-3 w-3" /></span>
          </div>
        </Tooltip>
      </div>
      {!compact && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Meter label="Impact" value={o.impact} />
          <Meter label="Effort" value={o.effort} invert />
          <Meter label="Confidence" value={o.confidence} />
          <Meter label="Business value" value={o.business_value} />
          <Meter label="Risk" value={o.risk} invert />
        </div>
      )}
      <div className="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-700">
        <strong className="text-gray-900">Recommended action:</strong> {o.action}
        {o.expected_outcome && <span className="block text-gray-500">Expected outcome: {o.expected_outcome}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] text-gray-500">
          <Database className="h-3 w-3" /> {o.data_sources.map((s) => SOURCE_LABEL[s] ?? humanize(s)).join(' · ')} · seen {fmtRelative(o.last_seen_at)}
        </span>
        <span className="ml-auto flex gap-1.5">
          {onStatus && o.status === 'open' && (
            <>
              <Button size="sm" variant="ghost" icon={<Clock className="h-3.5 w-3.5" />} onClick={() => onStatus('snoozed')}>Snooze</Button>
              <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => onStatus('dismissed')}>Dismiss</Button>
            </>
          )}
          <Link to={opportunityHref(o)} className="inline-flex items-center gap-1 rounded-md bg-gray-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-gray-800">
            Review <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </span>
      </div>
    </article>
  );
}

export function NextBestActionCard({ nba }: { nba: NextBestAction | null }) {
  if (!nba) {
    return (
      <div className="card flex items-center gap-3 px-5 py-4 text-sm text-gray-600">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" /> No open opportunities. Run an audit or connect Search Console to discover more.
      </div>
    );
  }
  return (
    <section className="card overflow-hidden border-gray-900/10">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-900 px-5 py-2 text-[11px] font-semibold tracking-wider text-white uppercase">
        <Sparkles className="h-3.5 w-3.5" /> Next best action
        <span className="ml-auto font-normal normal-case text-gray-300">Expected opportunity: <strong className="text-white">{nba.expectedOpportunity}</strong> · priority {Math.round(nba.priority_score)}</span>
      </div>
      <div className="grid gap-4 px-5 py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{nba.title}</h2>
          <p className="mt-1 text-sm text-gray-600">{nba.summary}</p>
          <p className="mt-3 text-sm text-gray-800"><strong>Do this:</strong> {nba.action}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link to={opportunityHref(nba)} className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
              Review <ArrowRight className="h-4 w-4" />
            </Link>
            {nba.url && <span className="self-center font-mono text-xs text-gray-500">{pathOf(nba.url)}</span>}
          </div>
        </div>
        <div className="space-y-2">
          <div className="text-[11px] font-semibold tracking-wide text-gray-500 uppercase">Why</div>
          <ul className="space-y-1 text-sm text-gray-700">
            {(nba.reasons.length ? nba.reasons : ['Highest combined score across impact, value, confidence, effort, urgency and risk']).map((r) => (
              <li key={r} className="flex gap-1.5"><CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />{r}</li>
            ))}
          </ul>
          <div className="text-[11px] font-semibold tracking-wide text-gray-500 uppercase">Evidence</div>
          <dl className="grid grid-cols-[minmax(90px,max-content)_1fr] gap-x-3 gap-y-0.5 text-xs">
            {nba.evidence.slice(0, 5).map((e) => (
              <div key={e.label} className="contents">
                <dt className="text-gray-500">{e.label}</dt>
                <dd className="truncate text-gray-800" title={String(e.value)}>{String(e.value)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

/** The closed loop: data → opportunity → decision → deployment → verification → measurement → learning. */
export function ClosedLoop({ loop, automationLevel }: { loop: CommandCenterData['loop']; automationLevel: number }) {
  const steps = [
    { label: 'Opportunities', value: loop.opportunities, icon: Sparkles, href: '/opportunities' },
    { label: 'Awaiting decision', value: loop.awaiting_decision, icon: Bot, href: '/approvals' },
    { label: 'Approved', value: loop.approved, icon: ShieldCheck, href: '/changes' },
    { label: 'Deployed', value: loop.deployed, icon: Rocket, href: '/changes' },
    { label: 'Verified live', value: loop.verified, icon: CheckCircle2, href: '/change-log' },
    { label: 'Measured', value: loop.measured, icon: Database, href: '/experiments' },
  ];
  return (
    <div className="card px-4 py-3">
      <div className="mb-2 flex items-center gap-2 text-xs text-gray-500">
        <span className="font-semibold tracking-wide text-gray-700 uppercase">Closed loop</span>
        <span>{loop.resolved} opportunities resolved so far · automation level {automationLevel}</span>
        <Link to="/settings?tab=automation" className="ml-auto font-medium text-brand-700 hover:underline">Automation</Link>
      </div>
      <ol className="flex flex-wrap items-stretch gap-1.5">
        {steps.map((s, i) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <Link to={s.href} className="flex min-w-28 items-center gap-2 rounded-md border border-gray-200 px-2.5 py-1.5 hover:border-gray-300">
              <s.icon className="h-4 w-4 text-gray-400" />
              <span>
                <span className="block text-base leading-tight font-semibold tabular text-gray-900">{s.value}</span>
                <span className="block text-[11px] text-gray-500">{s.label}</span>
              </span>
            </Link>
            {i < steps.length - 1 && <ArrowRight className="h-3.5 w-3.5 text-gray-300" />}
          </li>
        ))}
        <li className="flex items-center gap-1 text-[11px] text-gray-500">
          <ArrowRight className="h-3.5 w-3.5 text-gray-300" /> outcomes feed back into prioritization
        </li>
      </ol>
    </div>
  );
}
