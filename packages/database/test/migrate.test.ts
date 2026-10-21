import { describe, expect, it } from 'vitest';
import { createDb, migrate } from '../src/index.js';

describe('migrate', () => {
  it('is safe when several runners start at once (serverless cold starts)', async () => {
    const db = await createDb('pglite://memory');
    const results = await Promise.all([migrate(db), migrate(db), migrate(db)]);
    const appliedEverywhere = results.flatMap((r) => r.applied);
    // Each migration file is applied exactly once across all runners; the others skip it.
    expect(new Set(appliedEverywhere).size).toBe(appliedEverywhere.length);
    const rows = await db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM schema_migrations');
    expect(rows[0]!.n).toBe(appliedEverywhere.length);
    // A later start applies nothing.
    expect((await migrate(db)).applied).toEqual([]);
    await db.close();
  });
});
