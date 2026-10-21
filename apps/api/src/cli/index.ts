#!/usr/bin/env node
/**
 * Operations CLI.
 *   npm run cli -- create-admin <email> <password> [name]
 *   npm run cli -- create-api-key <name>            (prints a key for n8n; store it as SEO_API_KEY)
 *   npm run cli -- job <type> [projectId] [jsonInput]  (runs a job synchronously, e.g. job crawl)
 *   npm run cli -- list-projects
 */
import { generateApiKey, hashApiKey, hashPassword } from '@phoenixx/shared';
import { createContext } from '../context.js';
import { runJob, JOBS } from '../services/jobs.js';

const [cmd, ...args] = process.argv.slice(2);
const ctx = await createContext();
try {
  switch (cmd) {
    case 'create-admin': {
      const [email, password, name = 'Administrator'] = args;
      if (!email || !password || password.length < 10) throw new Error('Usage: create-admin <email> <password (min 10 chars)> [name]');
      await ctx.db.query(`INSERT INTO users(email, name, password_hash, role) VALUES ($1,$2,$3,'admin') ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', is_active = true`, [email.toLowerCase(), name, hashPassword(password)]);
      console.log(`Admin ${email} ready.`);
      break;
    }
    case 'create-api-key': {
      const name = args[0] ?? 'n8n';
      const key = generateApiKey();
      await ctx.db.query(`INSERT INTO api_keys(name, key_hash, role) VALUES ($1,$2,'service')`, [name, hashApiKey(key)]);
      console.log(`API key for "${name}" (shown once):\n${key}`);
      break;
    }
    case 'list-projects':
      console.table(await ctx.db.query('SELECT p.id, p.name, p.is_demo, w.base_url FROM projects p LEFT JOIN websites w ON w.project_id = p.id AND w.is_primary'));
      break;
    case 'job': {
      const [type, projectIdArg, json] = args;
      if (!type || !JOBS[type]) throw new Error(`Usage: job <type> [projectId] [json]. Types: ${Object.keys(JOBS).join(', ')}`);
      const projectId = projectIdArg ?? (await ctx.db.one<{ id: string }>('SELECT id FROM projects ORDER BY is_demo, created_at LIMIT 1'))?.id;
      if (!projectId) throw new Error('No project exists yet – start the API once or create one.');
      const res = await runJob(ctx, projectId, type, json ? JSON.parse(json) : {}, { trigger: 'cli', wait: true });
      console.log(JSON.stringify(res, null, 2));
      if (res.status === 'failed') process.exitCode = 1;
      break;
    }
    default:
      console.log('Commands: create-admin, create-api-key, list-projects, job');
  }
} finally {
  await ctx.close();
}
