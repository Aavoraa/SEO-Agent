import { AppError, newId } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { runCrawl } from './crawl.js';
import { syncGa4, syncSearchConsole } from './search-data.js';
import { runKeywordDiscovery } from './keywords.js';
import { runContentOpportunities } from './content.js';
import { runInternalLinks, runOnPageOptimization } from './optimization.js';
import { runLocalSeo } from './local.js';
import { evaluateAlerts, dispatchPending } from './alerts.js';
import { generateInitialReport, generateWeeklyReport } from './reports.js';
import { evaluateExperiments, processApprovedChanges } from './changes.js';
import { analyzeCompetitor } from './competitors.js';
import { createSnapshot, compareMigration } from './migration.js';
import { syncBacklinks, verifyBacklinks } from './backlinks.js';

const REFRESHES_OPPORTUNITIES = new Set(['crawl', 'seo-audit', 'keywords', 'content-opportunities', 'internal-links', 'backlinks-verify', 'gsc-sync', 'process-changes', 'deploy-change', 'verify-deployments', 'alerts-evaluate']);

type Handler = (ctx: AppContext, projectId: string, input: any, correlationId: string) => Promise<unknown>;

/**
 * Job registry – the only operations n8n (or the dashboard "Run now" buttons) can trigger.
 * Each job records a job_runs row with status, timings, output or error and a correlation ID,
 * so n8n failures never disappear silently.
 */
export const JOBS: Record<string, { description: string; handler: Handler; timeoutMs: number }> = {
  crawl: { description: 'Crawl the website, detect issues, create recommendations', timeoutMs: 30 * 60_000, handler: (ctx, p, i, c) => runCrawl(ctx, p, { ...i, trigger: i.trigger ?? 'job', correlationId: c }) },
  'seo-audit': {
    description: 'Full SEO audit: crawl + 10-category scorecard (input.device = desktop|mobile)',
    timeoutMs: 30 * 60_000,
    handler: (ctx, p, i, c) => runCrawl(ctx, p, { ...i, device: i.device === 'mobile' ? 'mobile' : 'desktop', trigger: i.trigger ?? 'audit', correlationId: c }),
  },
  'deploy-change': {
    description: 'Deploy one approved change through the website deployment pipeline (input.changeId); waits for verification',
    timeoutMs: 10 * 60_000,
    handler: async (ctx, p, i) => {
      if (typeof i.changeId !== 'string') throw new AppError('input.changeId is required', 400, 'validation');
      const { deployChange } = await import('./deployments.js');
      const r = await deployChange(ctx, p, i.changeId, { type: 'system', id: null, label: i.requestedBy ?? 'n8n', role: 'service' }, { wait: true });
      if (['failed', 'restored'].includes(r.status)) throw new AppError(`Deployment ${r.status}: ${(r as { error?: string }).error ?? ''}`, 502, 'deployment_failed');
      return r;
    },
  },
  'verify-deployments': {
    description: 'Re-check deployments flagged VERIFICATION_FAILED in the last 48 h (caches) and mark them verified when live',
    timeoutMs: 10 * 60_000,
    handler: async (ctx, p) => (await import('./deployments.js')).reverifyDeployments(ctx, p),
  },
  opportunities: { description: 'Refresh the Opportunity Engine (all sources → scored opportunities)', timeoutMs: 5 * 60_000, handler: async (ctx, p) => (await import('./opportunities.js')).refreshOpportunities(ctx, p) },
  'clarity-sync': { description: 'Fetch Microsoft Clarity page insights (Data Export API, max 10 calls/day; input.numOfDays 1–3)', timeoutMs: 2 * 60_000, handler: async (ctx, p, i) => (await import('./heatmaps.js')).syncClarity(ctx, p, { numOfDays: i.numOfDays }) },
  autopilot: { description: 'Automation level 3/4: approve + deploy eligible low-risk fixes (never high/critical)', timeoutMs: 20 * 60_000, handler: async (ctx, p) => (await import('./autopilot.js')).runAutopilot(ctx, p) },
  'gsc-sync': { description: 'Fetch Search Console data', timeoutMs: 10 * 60_000, handler: (ctx, p, i) => syncSearchConsole(ctx, p, i) },
  'ga4-sync': { description: 'Fetch GA4 data', timeoutMs: 10 * 60_000, handler: (ctx, p, i) => syncGa4(ctx, p, i) },
  keywords: { description: 'Keyword discovery, intent, clustering, opportunities', timeoutMs: 20 * 60_000, handler: (ctx, p, i, c) => runKeywordDiscovery(ctx, p, { ...i, correlationId: c }) },
  'content-opportunities': { description: 'Content gap analysis', timeoutMs: 15 * 60_000, handler: (ctx, p, i, c) => runContentOpportunities(ctx, p, { ...i, correlationId: c }) },
  'internal-links': { description: 'Internal linking analysis', timeoutMs: 15 * 60_000, handler: (ctx, p, i, c) => runInternalLinks(ctx, p, { ...i, correlationId: c }) },
  'local-seo': { description: 'Local SEO monitor', timeoutMs: 10 * 60_000, handler: (ctx, p, i, c) => runLocalSeo(ctx, p, { ...i, correlationId: c }) },
  'onpage-optimize': { description: 'AI on-page optimisation for one page (input.pageUrl)', timeoutMs: 5 * 60_000, handler: (ctx, p, i, c) => runOnPageOptimization(ctx, p, { pageUrl: i.pageUrl, correlationId: c }) },
  'alerts-evaluate': { description: 'Uptime, traffic anomaly and ranking-loss alerts', timeoutMs: 5 * 60_000, handler: (ctx, p) => evaluateAlerts(ctx, p) },
  'alerts-dispatch': { description: 'Send pending alerts to notification channels', timeoutMs: 5 * 60_000, handler: (ctx, p) => dispatchPending(ctx, p) },
  'weekly-report': { description: 'Build and email the weekly report', timeoutMs: 10 * 60_000, handler: (ctx, p, i, c) => generateWeeklyReport(ctx, p, { ...i, correlationId: c }) },
  'initial-report': { description: 'Build the initial SEO health report', timeoutMs: 5 * 60_000, handler: (ctx, p) => generateInitialReport(ctx, p) },
  'process-changes': { description: 'Implement approved changes via the website adapter and verify them', timeoutMs: 15 * 60_000, handler: (ctx, p) => processApprovedChanges(ctx, p) },
  'experiments-evaluate': { description: 'Evaluate finished SEO experiments', timeoutMs: 5 * 60_000, handler: (ctx, p) => evaluateExperiments(ctx, p) },
  'competitor-analyze': {
    description: 'Crawl competitor structure (input.competitorId, or all active)',
    timeoutMs: 30 * 60_000,
    handler: async (ctx, p, i) => {
      const ids = i.competitorId ? [i.competitorId] : (await ctx.db.query<{ id: string }>('SELECT id FROM competitors WHERE project_id = $1 AND is_active', [p])).map((r) => r.id);
      const out = [];
      for (const id of ids) out.push(await analyzeCompetitor(ctx, p, id).catch((e) => ({ id, error: (e as Error).message })));
      return out;
    },
  },
  'backlinks-sync': { description: 'Fetch backlinks from the configured provider (BACKLINK_PROVIDER); no-op without one', timeoutMs: 10 * 60_000, handler: (ctx, p, i) => syncBacklinks(ctx, p, i) },
  'backlinks-verify': { description: 'Check linking pages live, flag lost links, recommend 301s for links to broken pages', timeoutMs: 30 * 60_000, handler: (ctx, p, i) => verifyBacklinks(ctx, p, i) },
  'migration-snapshot': { description: 'Capture a migration snapshot (input.label, input.kind, input.sourceUrl?)', timeoutMs: 30 * 60_000, handler: (ctx, p, i) => createSnapshot(ctx, p, i) },
  'migration-compare': { description: 'Compare two migration snapshots', timeoutMs: 5 * 60_000, handler: (ctx, p, i) => compareMigration(ctx, p, i) },
};

export async function runJob(ctx: AppContext, projectId: string, type: string, input: Record<string, unknown>, opts: { trigger: string; correlationId?: string; wait?: boolean }) {
  const job = JOBS[type];
  if (!job) throw new AppError(`Unknown job type "${type}". Valid: ${Object.keys(JOBS).join(', ')}`, 404, 'unknown_job');
  const running = await ctx.db.one<{ id: string }>(`SELECT id FROM job_runs WHERE project_id = $1 AND job_type = $2 AND status = 'running' AND started_at > now() - ($3 || ' milliseconds')::interval`, [projectId, type, String(job.timeoutMs)]);
  if (running) throw new AppError(`A ${type} job is already running (${running.id})`, 409, 'job_running', { jobId: running.id });
  const correlationId = opts.correlationId ?? newId();
  const row = await ctx.db.one<{ id: string }>(`INSERT INTO job_runs(project_id, job_type, status, trigger, correlation_id, input, started_at) VALUES ($1,$2,'running',$3,$4,$5, now()) RETURNING id`, [projectId, type, opts.trigger, correlationId, input]);
  const jobId = row!.id;
  const log = ctx.log.child({ jobId, jobType: type, correlationId, projectId });
  log.info('job.start', { trigger: opts.trigger });
  const exec = (async () => {
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error(`Job timed out after ${job.timeoutMs} ms`)), job.timeoutMs).unref());
    try {
      const output = await Promise.race([job.handler(ctx, projectId, input, correlationId), timer]);
      await ctx.db.query(`UPDATE job_runs SET status = 'succeeded', output = $2, finished_at = now() WHERE id = $1`, [jobId, output ?? {}]);
      // Anything that changes findings feeds the Opportunity Engine straight away.
      if (REFRESHES_OPPORTUNITIES.has(type)) await (await import('./opportunities.js')).refreshOpportunities(ctx, projectId).catch((e) => log.warn('opportunities.refresh_failed', { error: (e as Error).message }));
      log.info('job.succeeded');
      return { jobId, correlationId, status: 'succeeded' as const, output };
    } catch (e) {
      const err = e as AppError;
      await ctx.db.query(`UPDATE job_runs SET status = 'failed', error = $2, finished_at = now() WHERE id = $1`, [jobId, err.message]);
      log.error('job.failed', { error: err.message, stack: err.stack });
      return { jobId, correlationId, status: 'failed' as const, error: err.message, code: err.code, statusCode: err.statusCode };
    }
  })();
  if (opts.wait) return exec;
  exec.catch(() => undefined);
  return { jobId, correlationId, status: 'running' as const };
}
