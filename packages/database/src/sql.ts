import type { Queryable } from './db.js';

/** Build an INSERT … RETURNING * from a plain object. Column names are validated to avoid injection. */
const IDENT = /^[a-z_][a-z0-9_]*$/;

function assertIdent(name: string) {
  if (!IDENT.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
}

export async function insert<T = any>(db: Queryable, table: string, row: Record<string, unknown>, opts: { onConflict?: string } = {}): Promise<T> {
  assertIdent(table);
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  cols.forEach(assertIdent);
  const params = cols.map((c) => row[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) ${opts.onConflict ?? ''} RETURNING *`;
  const rows = await db.query<T>(sql, params);
  return rows[0] as T;
}

/** Upsert by a unique constraint; updates the listed columns (default: all non-key columns). */
export async function upsert<T = any>(db: Queryable, table: string, row: Record<string, unknown>, conflictCols: string[], updateCols?: string[]): Promise<T> {
  conflictCols.forEach(assertIdent);
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  const upd = (updateCols ?? cols.filter((c) => !conflictCols.includes(c))).filter((c) => cols.includes(c));
  upd.forEach(assertIdent);
  const set = upd.length ? `DO UPDATE SET ${upd.map((c) => `${c} = EXCLUDED.${c}`).join(', ')}` : `DO UPDATE SET ${conflictCols[0]} = EXCLUDED.${conflictCols[0]}`;
  return insert<T>(db, table, row, { onConflict: `ON CONFLICT (${conflictCols.join(', ')}) ${set}` });
}

export async function update<T = any>(db: Queryable, table: string, id: string, patch: Record<string, unknown>): Promise<T | null> {
  assertIdent(table);
  const cols = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!cols.length) return (await db.query<T>(`SELECT * FROM ${table} WHERE id = $1`, [id]))[0] ?? null;
  cols.forEach(assertIdent);
  const sets = cols.map((c, i) => `${c} = $${i + 2}`);
  const rows = await db.query<T>(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((c) => patch[c])]);
  return rows[0] ?? null;
}

/** Bulk insert in chunks (multi-row VALUES) – used for GSC/GA rows and crawl results. */
export async function bulkInsert(db: Queryable, table: string, rows: Record<string, unknown>[], opts: { onConflict?: string; chunkSize?: number } = {}): Promise<number> {
  if (!rows.length) return 0;
  assertIdent(table);
  const cols = Object.keys(rows[0]!);
  cols.forEach(assertIdent);
  const size = opts.chunkSize ?? Math.max(1, Math.floor(30000 / cols.length));
  let n = 0;
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const params: unknown[] = [];
    const values = slice.map((r) => `(${cols.map((c) => (params.push(r[c]), `$${params.length}`)).join(', ')})`);
    await db.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${values.join(', ')} ${opts.onConflict ?? ''}`, params);
    n += slice.length;
  }
  return n;
}

/** Tiny WHERE builder for optional filters. */
export class Where {
  private parts: string[] = [];
  readonly params: unknown[] = [];
  constructor(initial?: [string, ...unknown[]]) {
    if (initial) this.add(...initial);
  }
  /** Use `?` as the placeholder; it is rewritten to $n. */
  add(fragment: string, ...values: unknown[]): this {
    let out = fragment;
    for (const v of values) {
      this.params.push(v);
      out = out.replace('?', `$${this.params.length}`);
    }
    this.parts.push(out);
    return this;
  }
  addIf(cond: unknown, fragment: string, ...values: unknown[]): this {
    return cond === undefined || cond === null || cond === '' ? this : this.add(fragment, ...values);
  }
  next(v: unknown): string {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  toString(): string {
    return this.parts.length ? 'WHERE ' + this.parts.join(' AND ') : '';
  }
}
