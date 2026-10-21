import type { ReactNode } from 'react';
import { cx, humanize } from '../lib/format';

export function Pill({ children, tone = 'gray', className, title }: { children: ReactNode; tone?: Tone; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] font-medium whitespace-nowrap', tones[tone], className)}>
      {children}
    </span>
  );
}

export type Tone = 'gray' | 'red' | 'orange' | 'amber' | 'blue' | 'green' | 'brand' | 'violet' | 'dark';
const tones: Record<Tone, string> = {
  gray: 'border-gray-200 bg-gray-50 text-gray-700',
  red: 'border-red-200 bg-red-50 text-red-700',
  orange: 'border-orange-200 bg-orange-50 text-orange-700',
  amber: 'border-amber-200 bg-amber-50 text-amber-800',
  blue: 'border-blue-200 bg-blue-50 text-blue-700',
  green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  brand: 'border-brand-200 bg-brand-50 text-brand-700',
  violet: 'border-violet-200 bg-violet-50 text-violet-700',
  dark: 'border-gray-800 bg-gray-800 text-white',
};

const sevTone: Record<string, Tone> = { critical: 'red', high: 'orange', medium: 'amber', low: 'blue', info: 'gray' };
const sevDot: Record<string, string> = { critical: 'bg-red-600', high: 'bg-orange-500', medium: 'bg-amber-500', low: 'bg-blue-500', info: 'bg-gray-400' };

export function SeverityBadge({ severity }: { severity: string | null | undefined }) {
  const s = severity ?? 'info';
  return (
    <Pill tone={sevTone[s] ?? 'gray'}>
      <span className={cx('h-1.5 w-1.5 rounded-full', sevDot[s] ?? 'bg-gray-400')} />
      {humanize(s)}
    </Pill>
  );
}

export function SeverityDot({ severity }: { severity: string }) {
  return <span className={cx('inline-block h-2 w-2 rounded-full', sevDot[severity] ?? 'bg-gray-400')} />;
}

export function PriorityBadge({ priority }: { priority: string | null | undefined }) {
  const p = priority ?? 'low';
  return <Pill tone={sevTone[p] ?? 'gray'}>{humanize(p)} priority</Pill>;
}

const riskTone: Record<string, Tone> = { critical: 'dark', high: 'red', medium: 'amber', low: 'green' };
export function RiskBadge({ risk }: { risk: string | null | undefined }) {
  if (!risk) return null;
  return <Pill tone={riskTone[risk] ?? 'gray'}>{humanize(risk)} risk</Pill>;
}

const statusTone: Record<string, Tone> = {
  open: 'amber',
  running: 'blue',
  pending_approval: 'amber',
  recommended: 'blue',
  approved: 'green',
  succeeded: 'green',
  completed: 'green',
  published: 'green',
  verified: 'green',
  resolved: 'green',
  connected: 'green',
  monitoring: 'violet',
  implemented: 'blue',
  deploying: 'blue',
  deployed: 'blue',
  verification_failed: 'orange',
  restored: 'amber',
  detected: 'gray',
  rejected: 'red',
  failed: 'red',
  rolled_back: 'red',
  error: 'red',
  acknowledged: 'gray',
  ignored: 'gray',
  dismissed: 'gray',
  draft: 'gray',
  draft_created: 'blue',
  brief_created: 'blue',
  concluded: 'green',
  inconclusive: 'gray',
  not_configured: 'gray',
  disconnected: 'gray',
};

export function StatusPill({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="text-gray-400">—</span>;
  return <Pill tone={statusTone[status] ?? 'gray'}>{humanize(status)}</Pill>;
}

export function TrendBadge({ trend }: { trend: string | null | undefined }) {
  if (!trend) return <span className="text-gray-400">—</span>;
  const t = trend.toLowerCase();
  const tone = t === 'rising' || t === 'new' ? 'text-emerald-700' : t === 'declining' || t === 'lost' ? 'text-red-700' : 'text-gray-600';
  const arrow = t === 'rising' || t === 'new' ? '↑' : t === 'declining' || t === 'lost' ? '↓' : '→';
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap', tone)}>
      <span aria-hidden>{arrow}</span>
      {humanize(trend)}
    </span>
  );
}

export function AiPill({ model }: { model?: string | null }) {
  return (
    <Pill tone="violet" title={model ? `Model: ${model}` : undefined}>
      AI-generated{model ? ` · ${model}` : ''}
    </Pill>
  );
}
