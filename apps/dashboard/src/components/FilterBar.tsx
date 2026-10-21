import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Search, X } from 'lucide-react';
import { cx } from '../lib/format';

export function FilterBar({ children, onReset, className }: { children: ReactNode; onReset?: () => void; className?: string }) {
  return (
    <div className={cx('mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-gray-200 bg-white p-3', className)}>
      {children}
      {onReset && (
        <button onClick={onReset} className="ml-auto inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800">
          <X className="h-3.5 w-3.5" /> Reset
        </button>
      )}
    </div>
  );
}

export function FilterField({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col', className)}>
      <span className="mb-1 text-[11px] font-medium tracking-wide text-gray-500 uppercase">{label}</span>
      {children}
    </label>
  );
}

export function SelectFilter({ label, value, onChange, options, allLabel = 'All', className }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; allLabel?: string | null; className?: string }) {
  return (
    <FilterField label={label} className={className}>
      <select className="input min-w-28 pr-7" value={value} onChange={(e) => onChange(e.target.value)}>
        {allLabel !== null && <option value="">{allLabel}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FilterField>
  );
}

/** Debounced text search input. */
export function SearchFilter({ label = 'Search', value, onChange, placeholder, className }: { label?: string; value: string; onChange: (v: string) => void; placeholder?: string; className?: string }) {
  const [v, setV] = useState(value);
  const first = useRef(true);
  useEffect(() => setV(value), [value]);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => v !== value && onChange(v), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  return (
    <FilterField label={label} className={className}>
      <span className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
        <input className="input w-full min-w-44 pl-7" value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} />
      </span>
    </FilterField>
  );
}

/** Compact multi-select dropdown with checkboxes. */
export function MultiSelect({ label, values, onChange, options }: { label: string; values: string[]; onChange: (v: string[]) => void; options: { value: string; label: string }[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  const summary = values.length === 0 ? 'All' : values.length <= 2 ? values.map((v) => options.find((o) => o.value === v)?.label ?? v).join(', ') : `${values.length} selected`;
  return (
    <FilterField label={label}>
      <div className="relative" ref={ref}>
        <button type="button" className="input inline-flex min-w-32 items-center justify-between gap-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="truncate">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
        </button>
        {open && (
          <div className="absolute z-20 mt-1 min-w-full rounded-md border border-gray-200 bg-white py-1 shadow-lg">
            {options.map((o) => (
              <label key={o.value} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm whitespace-nowrap hover:bg-gray-50">
                <input
                  type="checkbox"
                  className="accent-brand-500"
                  checked={values.includes(o.value)}
                  onChange={(e) => onChange(e.target.checked ? [...values, o.value] : values.filter((x) => x !== o.value))}
                />
                {o.label}
              </label>
            ))}
            {values.length > 0 && (
              <button className="w-full border-t border-gray-100 px-3 py-1.5 text-left text-xs text-gray-500 hover:bg-gray-50" onClick={() => onChange([])}>
                Clear
              </button>
            )}
          </div>
        )}
      </div>
    </FilterField>
  );
}
