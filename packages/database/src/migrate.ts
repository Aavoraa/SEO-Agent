import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Db } from './db.js';

/** Locate database/migrations whether running from source, a bundle, or a Docker image. */
export function defaultMigrationsDir(): string {
  const candidates = [
    process.env.MIGRATIONS_DIR,
    path.resolve(process.cwd(), 'database/migrations'),
    path.resolve(process.cwd(), '../../database/migrations'),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../database/migrations'),
  ].filter(Boolean) as string[];
  const found = candidates.find((c) => existsSync(c));
  if (!found) throw new Error(`Migrations directory not found (tried: ${candidates.join(', ')})`);
  return found;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Arbitrary constant key for the Postgres advisory lock that serialises migrations. */
const MIGRATION_LOCK_KEY = 727274712;

/**
 * Applies *.sql files in lexical order, once each, inside a transaction. Detects edited migrations by checksum.
 * Safe under concurrency (several serverless instances cold-starting at once): every step takes a
 * transaction-scoped advisory lock and re-checks schema_migrations inside it, so a second runner waits
 * for the first and skips what it already applied.
 */
export async function migrate(db: Db, dir = defaultMigrationsDir()): Promise<MigrationResult> {
  await db.transaction(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  });
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const applied = await db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
      const prev = (await tx.query<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE version = $1', [file]))[0];
      if (prev) {
        if (prev.checksum !== checksum) throw new Error(`Migration ${file} was modified after being applied. Create a new migration instead.`);
        return false;
      }
      for (const stmt of splitSql(sql)) await tx.query(stmt);
      await tx.query('INSERT INTO schema_migrations(version, checksum) VALUES ($1, $2)', [file, checksum]);
      return true;
    });
    (applied ? result.applied : result.skipped).push(file);
  }
  return result;
}

/** Splits a SQL file on semicolons that end a statement (ignores comments; no $$ bodies are used in our migrations). */
export function splitSql(sql: string): string[] {
  const noComments = sql
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
  return noComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
