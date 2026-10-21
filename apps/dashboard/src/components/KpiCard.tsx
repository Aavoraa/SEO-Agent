import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { cx } from '../lib/format';
import { Tooltip } from './ui';

/**
 * KPI tile with a delta vs the previous period. `lowerIsBetter` inverts the colour (avg position).
 * `delta` is a pre-formatted change; `deltaValue` its signed number used for colouring.
 */
export function KpiCard({ label, value, delta, deltaValue, lowerIsBetter, hint, info, tone }: { label: string; value: ReactNode; delta?: string | null; deltaValue?: number | null; lowerIsBetter?: boolean; hint?: ReactNode; info?: ReactNode; tone?: 'danger' | 'warn' }) {
  const good = deltaValue == null || deltaValue === 0 ? null : lowerIsBetter ? deltaValue < 0 : deltaValue > 0;
  return (
    <div className="card flex min-w-0 flex-col px-4 py-3">
      <div className="flex items-center gap-1 text-xs font-medium text-gray-500">
        <span className="truncate">{label}</span>
        {info && (
          <Tooltip content={info}>
            <button type="button" className="text-gray-400 hover:text-gray-600" aria-label={`About ${label}`}>
              <Info className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
        )}
      </div>
      <div className={cx('mt-1 text-2xl font-semibold tracking-tight tabular', tone === 'danger' ? 'text-red-700' : tone === 'warn' ? 'text-amber-700' : 'text-gray-900')}>{value}</div>
      <div className="mt-0.5 flex min-h-4 items-center gap-1.5 text-xs">
        {delta != null && (
          <span className={cx('font-medium tabular', good === null ? 'text-gray-500' : good ? 'text-emerald-700' : 'text-red-700')}>
            {deltaValue != null && deltaValue > 0 ? '▲' : deltaValue != null && deltaValue < 0 ? '▼' : ''} {delta}
          </span>
        )}
        {hint && <span className="truncate text-gray-500">{hint}</span>}
      </div>
    </div>
  );
}
