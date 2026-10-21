import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, ChevronsUpDown, ChevronUp } from 'lucide-react';
import { cx } from '../lib/format';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sort?: (row: T) => number | string | null | undefined;
  align?: 'left' | 'right' | 'center';
  className?: string;
  headerClassName?: string;
  width?: string;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  expand?: (row: T) => ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  empty?: ReactNode;
  maxHeight?: string;
  dense?: boolean;
  rowClassName?: (row: T) => string | undefined;
  className?: string;
}

export function DataTable<T>({ columns, rows, rowKey, onRowClick, expand, initialSort, empty, maxHeight = '70vh', dense, rowClassName, className }: Props<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const get = col.sort;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }, [rows, sort, columns]);

  const toggleSort = (c: Column<T>) => {
    if (!c.sort) return;
    setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: 'desc' }));
  };
  const toggleOpen = (k: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  if (!rows.length && empty) return <>{empty}</>;
  const pad = dense ? 'px-3 py-1.5' : 'px-3 py-2.5';
  const colCount = columns.length + (expand ? 1 : 0);

  return (
    <div className={cx('overflow-auto rounded-lg border border-gray-200 bg-white', className)} style={{ maxHeight }}>
      <table className="w-full border-separate border-spacing-0 text-sm">
        <thead>
          <tr>
            {expand && <th className="sticky top-0 z-10 w-8 border-b border-gray-200 bg-gray-50" />}
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={cx(
                    'sticky top-0 z-10 border-b border-gray-200 bg-gray-50 text-xs font-medium whitespace-nowrap text-gray-500',
                    dense ? 'px-3 py-2' : 'px-3 py-2.5',
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.headerClassName,
                  )}
                  aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {c.sort ? (
                    <button onClick={() => toggleSort(c)} className={cx('inline-flex items-center gap-1 hover:text-gray-900', active && 'text-gray-900')}>
                      {c.header}
                      {active ? sort!.dir === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" /> : <ChevronsUpDown className="h-3 w-3 opacity-40" />}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const k = rowKey(row);
            const isOpen = open.has(k);
            const clickable = !!onRowClick || !!expand;
            return (
              <Fragment key={k}>
                <tr
                  onClick={onRowClick ? () => onRowClick(row) : expand ? () => toggleOpen(k) : undefined}
                  className={cx('group', clickable && 'cursor-pointer', isOpen ? 'bg-gray-50' : 'hover:bg-gray-50', rowClassName?.(row))}
                >
                  {expand && (
                    <td className={cx('border-b border-gray-100 pl-3 align-top text-gray-400', dense ? 'py-1.5' : 'py-2.5')}>
                      <button
                        aria-label={isOpen ? 'Collapse row' : 'Expand row'}
                        aria-expanded={isOpen}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleOpen(k);
                        }}
                        className="rounded hover:text-gray-700"
                      >
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </td>
                  )}
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={cx('border-b border-gray-100 align-top text-gray-800', pad, c.align === 'right' ? 'text-right tabular' : c.align === 'center' ? 'text-center' : 'text-left', c.className)}
                    >
                      {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? '—')}
                    </td>
                  ))}
                </tr>
                {expand && isOpen && (
                  <tr>
                    <td colSpan={colCount} className="border-b border-gray-200 bg-gray-50/60 px-4 py-4">
                      {expand(row)}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
