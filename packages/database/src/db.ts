import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Minimal database abstraction so the same SQL runs on:
 *  - PostgreSQL via `pg` (production, docker-compose)
 *  - PGlite (Postgres compiled to WASM) for zero-install local dev, demo mode and tests
 */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly kind: 'postgres' | 'pglite';
  one<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Normalises parameters: plain objects/arrays-of-objects become JSON; JS arrays of primitives stay arrays. */
function prepareParams(params: unknown[] = []): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p instanceof Date) return p.toISOString();
    if (Array.isArray(p)) {
      return p.some((x) => x !== null && typeof x === 'object') ? JSON.stringify(p) : p;
    }
    if (p !== null && typeof p === 'object') return JSON.stringify(p);
    return p;
  });
}

async function createPg(url: string): Promise<Db> {
  const pg = await import('pg');
  const Pool = (pg.default?.Pool ?? (pg as any).Pool) as typeof import('pg').Pool;
  const types = pg.default?.types ?? (pg as any).types;
  // Return DATE columns as 'YYYY-MM-DD' strings, bigint counts as numbers.
  types.setTypeParser(1082, (v: string) => v);
  types.setTypeParser(20, (v: string) => Number(v));
  types.setTypeParser(1700, (v: string) => Number(v));
  const pool = new Pool({ connectionString: url, max: 10 });
  const q = async (client: { query: Function }, sql: string, params?: unknown[]) => (await client.query(sql, prepareParams(params))).rows;
  const db: Db = {
    kind: 'postgres',
    query: (sql, params) => q(pool, sql, params),
    one: async (sql, params) => (await q(pool, sql, params))[0] ?? null,
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const res = await fn({ query: (sql, params) => q(client, sql, params) as any });
        await client.query('COMMIT');
        return res;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  return db;
}

async function createPglite(url: string): Promise<Db> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  const target = url.replace(/^pglite:\/\//, '');
  const opts = {
    parsers: {
      [types.DATE]: (v: string) => v,
      [types.INT8]: (v: string) => Number(v),
      [types.NUMERIC]: (v: string) => Number(v),
    },
  };
  let pg: InstanceType<typeof PGlite>;
  if (!target || target === 'memory' || target === ':memory:') {
    pg = new PGlite(opts);
  } else {
    const dir = path.resolve(target);
    mkdirSync(dir, { recursive: true });
    pg = new PGlite(dir, opts);
  }
  await pg.waitReady;
  // PGlite is single-connection; serialise statements so interleaved async work never
  // lands inside another caller's transaction.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
  const raw = async (sql: string, params?: unknown[]) => (await pg.query(sql, prepareParams(params))).rows as any[];
  const db: Db = {
    kind: 'pglite',
    query: (sql, params) => serial(() => raw(sql, params)),
    one: async (sql, params) => (await serial(() => raw(sql, params)))[0] ?? null,
    exec: (sql) => serial(async () => void (await pg.exec(sql))),
    transaction: (fn) =>
      serial(async () => {
        await pg.exec('BEGIN');
        try {
          const res = await fn({ query: raw as any });
          await pg.exec('COMMIT');
          return res;
        } catch (e) {
          await pg.exec('ROLLBACK');
          throw e;
        }
      }),
    close: () => pg.close(),
  };
  return db;
}

export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return createPg(url);
  if (url.startsWith('pglite://') || url === 'memory') return createPglite(url === 'memory' ? 'pglite://memory' : url);
  throw new Error(`Unsupported DATABASE_URL scheme: ${url.split(':')[0]}`);
}
