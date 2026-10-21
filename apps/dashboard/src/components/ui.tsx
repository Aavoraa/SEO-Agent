import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { ApiError } from '../api/client';
import { cx } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md';

const variants: Record<Variant, string> = {
  primary: 'bg-brand-500 text-white hover:bg-brand-600 border-transparent disabled:bg-brand-500/50',
  secondary: 'bg-white text-gray-800 border-gray-300 hover:bg-gray-50 disabled:text-gray-400',
  ghost: 'bg-transparent text-gray-700 border-transparent hover:bg-gray-100 disabled:text-gray-400',
  danger: 'bg-white text-red-700 border-red-300 hover:bg-red-50 disabled:text-red-300 disabled:border-red-200',
  success: 'bg-emerald-600 text-white border-transparent hover:bg-emerald-700 disabled:bg-emerald-600/50',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export function Card({ children, className, title, actions, subtitle, bodyClassName }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; bodyClassName?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-gray-100 px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-gray-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx(bodyClassName ?? 'p-4')}>{children}</div>
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-4 w-4 animate-spin text-gray-400', className)} />;
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-500">
      <Spinner /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error as ApiError | Error;
  const cid = e instanceof ApiError && e.status >= 500 ? e.correlationId : undefined;
  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="flex-1">
        <p>{e?.message ?? 'Something went wrong'}</p>
        {cid && <p className="mt-1 font-mono text-[11px] text-red-500">Correlation ID: {cid}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry} icon={<RefreshCw className="h-3.5 w-3.5" />}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto overflow-y-hidden border-b border-gray-200" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors',
            value === t.id ? 'border-brand-500 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className={cx('rounded-full px-1.5 text-[11px] tabular', value === t.id ? 'bg-brand-50 text-brand-700' : 'bg-gray-100 text-gray-600')}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange, label }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label?: string }) {
  return (
    <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cx('h-6.5 rounded px-2.5 text-xs font-medium transition-colors', value === o.value ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function DaysSelector({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Segmented
      label="Date range"
      value={value}
      onChange={onChange}
      options={[
        { value: 7, label: '7 days' },
        { value: 28, label: '28 days' },
        { value: 90, label: '90 days' },
      ]}
    />
  );
}

/** Lightweight CSS tooltip (hover + focus). */
export function Tooltip({ content, children, className, side = 'top' }: { content: ReactNode; children: ReactNode; className?: string; side?: 'top' | 'bottom' }) {
  if (!content) return <>{children}</>;
  return (
    <span className={cx('group/tt relative inline-flex', className)}>
      {children}
      <span
        role="tooltip"
        className={cx(
          'pointer-events-none invisible absolute left-1/2 z-50 w-max max-w-72 -translate-x-1/2 rounded-md bg-gray-900 px-2.5 py-1.5 text-left text-xs leading-snug font-normal whitespace-normal text-white opacity-0 shadow-lg transition-opacity group-hover/tt:visible group-hover/tt:opacity-100 group-focus-within/tt:visible group-focus-within/tt:opacity-100',
          side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
        )}
      >
        {content}
      </span>
    </span>
  );
}

export function Field({ label, children, className, hint }: { label: string; children: ReactNode; className?: string; hint?: ReactNode }) {
  return (
    <label className={cx('block', className)}>
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-gray-500">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-brand-500' : 'bg-gray-300')}
    >
      <span className={cx('inline-block h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-4.5' : 'translate-x-0.5')} />
    </button>
  );
}

export function ScoreBar({ value, max = 100, className }: { value: number; max?: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <span className={cx('inline-flex items-center gap-2', className)}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-gray-100">
        <span className="block h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
      </span>
      <span className="tabular text-xs text-gray-700">{Math.round(value)}</span>
    </span>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card px-4 py-3">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular text-gray-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

export function KeyValues({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cx('grid grid-cols-[minmax(110px,max-content)_1fr] gap-x-4 gap-y-1.5 text-sm', className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-gray-500">{it.label}</dt>
          <dd className="min-w-0 break-words text-gray-900">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
