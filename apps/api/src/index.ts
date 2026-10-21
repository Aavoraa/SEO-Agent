import { hashPassword } from '@phoenixx/shared';
import { createContext } from './context.js';
import { buildServer } from './server.js';
import { createProject } from './services/projects.js';

const ctx = await createContext();

// Optional bootstrap: create the first admin + the Phoenixx IT project from env on first start.
if (ctx.cfg.ADMIN_EMAIL && ctx.cfg.ADMIN_PASSWORD) {
  const n = await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
  if (!n?.n) {
    await ctx.db.query(`INSERT INTO users(email, name, password_hash, role) VALUES ($1, 'Administrator', $2, 'admin')`, [ctx.cfg.ADMIN_EMAIL.toLowerCase(), hashPassword(ctx.cfg.ADMIN_PASSWORD)]);
    ctx.log.info('bootstrap.admin_created', { email: ctx.cfg.ADMIN_EMAIL });
  }
}
if (!ctx.cfg.DEMO_MODE) {
  const p = await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM projects WHERE NOT is_demo');
  if (!p?.n) {
    const created = await createProject(ctx, { name: 'Phoenixx IT', siteUrl: ctx.cfg.SEO_SITE_URL, searchConsoleSiteUrl: ctx.cfg.SEARCH_CONSOLE_SITE_URL, ga4PropertyId: ctx.cfg.GA4_PROPERTY_ID });
    ctx.log.info('bootstrap.project_created', { projectId: created.id, site: ctx.cfg.SEO_SITE_URL });
  }
}

if (ctx.cfg.DEMO_MODE) {
  const { startDemoSiteServer, demoSiteOrigin } = await import('./demo/site.js');
  const { siteKeyFor, trackerSnippet } = await import('./services/heatmaps.js');
  let tag: string | null = null;
  startDemoSiteServer(ctx, ctx.cfg.SEO_SITE_URL, {
    trackerTag: async () => {
      if (tag) return tag;
      const demo = await ctx.db.one<{ id: string }>('SELECT id FROM projects WHERE is_demo ORDER BY created_at LIMIT 1');
      return demo ? (tag = trackerSnippet(ctx, await siteKeyFor(ctx, demo.id))) : null;
    },
  });
  ctx.log.info('demo.site_listening', { url: demoSiteOrigin(ctx), note: 'Local demo copy of the website – deployments in demo mode go here' });
}

const app = await buildServer(ctx);
await app.listen({ port: ctx.cfg.API_PORT, host: ctx.cfg.API_HOST });
ctx.log.info('api.listening', { port: ctx.cfg.API_PORT, demo: ctx.cfg.DEMO_MODE, db: ctx.db.kind, ai: ctx.ai.info.provider, adapter: ctx.adapter.name });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    ctx.log.info('api.shutdown', { signal: sig });
    await app.close();
    await ctx.close();
    process.exit(0);
  });
}
