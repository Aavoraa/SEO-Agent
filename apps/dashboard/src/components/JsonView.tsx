import type { ReactNode } from 'react';
import { humanize } from '../lib/format';

function scalar(v: unknown): ReactNode {
  if (v === null || v === undefined) return <span className="text-gray-400">—</span>;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') return <span className="tabular">{v.toLocaleString('en-IN')}</span>;
  const s = String(v);
  if (/^https?:\/\//.test(s))
    return (
      <a href={s} target="_blank" rel="noopener noreferrer" className="link break-all">
        {s}
      </a>
    );
  if (s.includes('\n') || s.length > 160) return <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{s}</pre>;
  return s;
}

/** Render unstructured evidence JSON as a readable label/value list (nested one level), else pretty JSON. */
export function JsonView({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-gray-400">No evidence recorded</span>;
  if (Array.isArray(value)) {
    if (value.every((x) => x && typeof x === 'object' && 'label' in x && 'value' in x)) {
      return <LabelValues items={value as { label: string; value: unknown }[]} />;
    }
    if (value.every((x) => typeof x !== 'object' || x === null)) {
      return (
        <ul className="list-disc space-y-0.5 pl-4 text-sm">
          {value.map((x, i) => (
            <li key={i}>{scalar(x)}</li>
          ))}
        </ul>
      );
    }
    return <pre className="max-h-64 overflow-auto rounded bg-gray-50 p-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(value, null, 2)}</pre>;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return <span className="text-gray-400">No evidence recorded</span>;
    return <LabelValues items={entries.map(([k, v]) => ({ label: humanize(k.replace(/([a-z])([A-Z])/g, '$1 $2')), value: v }))} />;
  }
  return <>{scalar(value)}</>;
}

export function LabelValues({ items }: { items: { label: string; value: unknown }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(100px,max-content)_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-gray-500">{it.label}</dt>
          <dd className="min-w-0 break-words text-gray-900">
            {it.value && typeof it.value === 'object' ? (
              Array.isArray(it.value) && it.value.every((x) => typeof x !== 'object') ? (
                (it.value as unknown[]).map(String).join(', ')
              ) : (
                <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(it.value, null, 2)}</pre>
              )
            ) : (
              scalar(it.value)
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
