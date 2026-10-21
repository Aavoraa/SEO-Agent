#!/usr/bin/env node
import { createDb, migrate } from '@phoenixx/database';
import { loadConfig, resolveDatabaseUrl } from '@phoenixx/shared';

const cfg = loadConfig();
const url = resolveDatabaseUrl(cfg);
const db = await createDb(url);
try {
  const res = await migrate(db);
  console.log(`Database: ${db.kind} (${url.replace(/\/\/[^@]*@/, '//***@')})`);
  console.log(`Applied: ${res.applied.join(', ') || 'none'}; already applied: ${res.skipped.length}`);
} finally {
  await db.close();
}
