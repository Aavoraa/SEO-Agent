import { Ga4Client, SearchConsoleClient } from '@phoenixx/integrations';
import { bulkInsert } from '@phoenixx/database';
import { AppError, addDays, isoDate, normalizeUrl } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject } from './common.js';

async function markIntegration(ctx: AppContext, projectId: string, provider: 'google_search_console' | 'google_analytics', ok: boolean, error?: string, config?: Record<string, unknown>) {
  await ctx.db.query(
    `INSERT INTO integrations(project_id, provider, status, config, last_sync_at, last_error, connected_at) VALUES ($1,$2,$3,$4, CASE WHEN $3 = 'connected' THEN now() END, $5, now())
     ON CONFLICT (project_id, provider) DO UPDATE SET status = EXCLUDED.status, config = integrations.config || EXCLUDED.config, last_error = EXCLUDED.last_error,
       last_sync_at = COALESCE(EXCLUDED.last_sync_at, integrations.last_sync_at)`,
    [projectId, provider, ok ? 'connected' : 'error', config ?? {}, error ?? null],
  );
}

function gscSiteUrl(ctx: AppContext, project: { settings: any }): string {
  const s = project.settings?.searchConsoleSiteUrl ?? ctx.cfg.SEARCH_CONSOLE_SITE_URL;
  if (!s) throw new AppError('SEARCH_CONSOLE_SITE_URL is not configured (e.g. "sc-domain:phoenixxit.com" or "https://www.phoenixxit.com/")', 400, 'not_configured');
  return s;
}

/**
 * Pulls Search Console data for [end-days+1, end] where end = today-3 (GSC finalisation lag).
 * Stores query×page×date rows plus site-level daily totals (query='' AND page='').
 * Re-running is idempotent (upsert on the natural key).
 */
export async function syncSearchConsole(ctx: AppContext, projectId: string, input: { days?: number; endDate?: string } = {}) {
  const project = await getProject(ctx, projectId);
  if (project.is_demo) throw new AppError('Demo projects use sample data – connect a real project to sync Search Console.', 400, 'demo_project');
  const site = gscSiteUrl(ctx, project);
  const auth = await ctx.googleAuth(projectId);
  if (!auth.configured) throw new AppError('Google is not connected. Configure a service account or use Settings → Connect Google.', 400, 'not_configured');
  const end = input.endDate ?? isoDate(addDays(new Date(), -3));
  const start = isoDate(addDays(end, -((input.days ?? 16) - 1)));
  const client = new SearchConsoleClient(auth, site);
  try {
    const detail = await client.fetchRange(start, end, { dimensions: ['date', 'query', 'page'] });
    const totals = await client.fetchDailyTotals(start, end);
    const rows = [
      ...detail.map((r) => ({ project_id: projectId, date: r.date, query: r.query.slice(0, 500), page: normalizeUrl(r.page) ?? r.page, country: '', device: '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
      ...totals.map((r) => ({ project_id: projectId, date: r.date, query: '', page: '', country: '', device: '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
    ];
    // Aggregate duplicates created by URL normalisation before upserting.
    const merged = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const k = `${r.date}|${r.query}|${r.page}`;
      const m = merged.get(k);
      if (!m) merged.set(k, { ...r });
      else {
        const imp = m.impressions + r.impressions;
        m.position = imp ? (m.position * m.impressions + r.position * r.impressions) / imp : m.position;
        m.clicks += r.clicks;
        m.impressions = imp;
        m.ctr = imp ? m.clicks / imp : 0;
      }
    }
    const n = await bulkInsert(ctx.db, 'search_console_data', [...merged.values()], {
      onConflict: 'ON CONFLICT (project_id, date, query, page, country, device) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr, position = EXCLUDED.position, fetched_at = now()',
      chunkSize: 1000,
    });
    await markIntegration(ctx, projectId, 'google_search_console', true, undefined, { siteUrl: site });
    await ctx.db.query(`UPDATE projects SET onboarding = onboarding || '{"searchConsole": true}'::jsonb WHERE id = $1`, [projectId]);
    return { start, end, rows: n, queryRows: detail.length, totalRows: totals.length };
  } catch (e) {
    await markIntegration(ctx, projectId, 'google_search_console', false, (e as Error).message);
    throw e;
  }
}

export async function syncGa4(ctx: AppContext, projectId: string, input: { days?: number; endDate?: string } = {}) {
  const project = await getProject(ctx, projectId);
  if (project.is_demo) throw new AppError('Demo projects use sample data.', 400, 'demo_project');
  const propertyId = project.settings && (project.settings as any).ga4PropertyId ? (project.settings as any).ga4PropertyId : ctx.cfg.GA4_PROPERTY_ID;
  if (!propertyId) throw new AppError('GA4_PROPERTY_ID is not configured (numeric property ID, not the G-XXXX measurement ID).', 400, 'not_configured');
  const auth = await ctx.googleAuth(projectId);
  if (!auth.configured) throw new AppError('Google is not connected.', 400, 'not_configured');
  const end = input.endDate ?? isoDate(addDays(new Date(), -1));
  const start = isoDate(addDays(end, -((input.days ?? 16) - 1)));
  try {
    const rows = await new Ga4Client(auth, String(propertyId)).fetchRange(start, end);
    const siteOrigin = (await ctx.db.one<{ base_url: string }>('SELECT base_url FROM websites WHERE project_id = $1 ORDER BY is_primary DESC LIMIT 1', [projectId]))?.base_url;
    const n = await bulkInsert(
      ctx.db,
      'analytics_data',
      rows.map((r) => ({
        project_id: projectId,
        date: r.date,
        // GA4 landingPage is a path; store as absolute URL to join with Search Console pages.
        landing_page: siteOrigin && r.landingPage.startsWith('/') ? (normalizeUrl(r.landingPage.split('?')[0]!, siteOrigin) ?? r.landingPage) : r.landingPage,
        channel_group: r.channelGroup,
        source: r.source,
        medium: r.medium,
        sessions: r.sessions,
        users: r.users,
        engaged_sessions: r.engagedSessions,
        engagement_rate: r.engagementRate,
        conversions: r.conversions,
      })),
      { onConflict: 'ON CONFLICT (project_id, date, landing_page, channel_group, source, medium) DO UPDATE SET sessions = EXCLUDED.sessions, users = EXCLUDED.users, engaged_sessions = EXCLUDED.engaged_sessions, engagement_rate = EXCLUDED.engagement_rate, conversions = EXCLUDED.conversions, fetched_at = now()', chunkSize: 1000 },
    );
    await markIntegration(ctx, projectId, 'google_analytics', true, undefined, { propertyId });
    await ctx.db.query(`UPDATE projects SET onboarding = onboarding || '{"ga4": true}'::jsonb WHERE id = $1`, [projectId]);
    return { start, end, rows: n };
  } catch (e) {
    await markIntegration(ctx, projectId, 'google_analytics', false, (e as Error).message);
    throw e;
  }
}
