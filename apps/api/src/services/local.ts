import { buildLocalMatrix, localBusinessSchema, validateJsonLd, type LocalPageInput, type LocalQueryInput } from '@phoenixx/seo-engine';
import { classifyIntent } from '@phoenixx/keyword-engine';
import { detectLocations, detectServices, type BusinessProfile, type CrawledPage } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestCrawledPages, profileOf } from './common.js';
import { fingerprint, upsertRecommendation } from './recommendations.js';
import { scorePriority } from '@phoenixx/seo-engine';

export async function localQueries(ctx: AppContext, projectId: string): Promise<LocalQueryInput[]> {
  const rows = await ctx.db.query<any>(
    `SELECT k.keyword, k.services, k.locations, m.impressions, m.clicks, m.position, m.top_page FROM keywords k
     JOIN LATERAL (SELECT * FROM keyword_metrics km WHERE km.keyword_id = k.id AND km.window_days = 90 ORDER BY period_end DESC LIMIT 1) m ON true
     WHERE k.project_id = $1 AND k.source = 'gsc' AND cardinality(k.locations) > 0`,
    [projectId],
  );
  return rows.map((r) => ({ query: r.keyword, impressions: r.impressions, clicks: r.clicks, position: r.position ?? 100, services: r.services, locations: r.locations, topPage: r.top_page }));
}

export function pageLocalCoverage(pages: CrawledPage[], profile: BusinessProfile): LocalPageInput[] {
  return pages
    .filter((p) => p.indexable)
    .map((p) => {
      const text = [p.title, ...p.h1s, ...p.h2s].filter(Boolean).join(' . ');
      const path = new URL(p.url).pathname;
      const byPath = profile.services.filter((s) => s.path === path).map((s) => s.id);
      return { url: p.url, title: p.title, h1: p.h1s[0] ?? null, services: [...new Set([...byPath, ...detectServices(text, profile.services)])], locations: detectLocations(text, profile.locations) };
    });
}

export async function localOverview(ctx: AppContext, projectId: string) {
  const project = await getProject(ctx, projectId);
  const profile = profileOf(project);
  const { pages } = await latestCrawledPages(ctx, projectId);
  const matrix = buildLocalMatrix(await localQueries(ctx, projectId), pageLocalCoverage(pages, profile), profile, { minImpressionsForNewPage: project.settings?.thresholds?.minImpressionsForLocationPage });
  const localIssues = await ctx.db.query(`SELECT id, rule_id, severity, title, description, url FROM seo_issues WHERE project_id = $1 AND category = 'local' AND status = 'open'`, [projectId]);
  const hasLocalSchema = pages.some((p) => p.structuredData.some((b) => b.valid && b.types.some((t) => /LocalBusiness|ProfessionalService/.test(t))));
  const schema = localBusinessSchema(profile);
  const phones = [...new Set(pages.flatMap((p) => p.signals?.phones ?? []))];
  return {
    nap: { name: profile.name, address: profile.address, phone: profile.phone, email: profile.email, phonesFoundOnSite: phones },
    localSchema: { present: hasLocalSchema, suggested: schema, validation: schema ? validateJsonLd(schema) : null },
    matrix,
    issues: localIssues,
    targetLocations: profile.locations.filter((l) => l.target).map((l) => l.name),
    googleBusinessProfile: { status: 'not_integrated', note: 'The Google Business Profile API requires approved access; keep NAP identical to the website and review GBP manually.' },
  };
}

/** Local SEO Monitor (workflow 7): matrix → recommendations (+ optional AI review). */
export async function runLocalSeo(ctx: AppContext, projectId: string, input: { useAi?: boolean; correlationId?: string } = {}) {
  const project = await getProject(ctx, projectId);
  const profile = profileOf(project);
  const ov = await localOverview(ctx, projectId);
  let recs = 0;
  for (const cell of ov.matrix.filter((c) => c.action === 'add_location_section' || c.action === 'create_location_page' || c.action === 'optimize_existing_page')) {
    const create = cell.action === 'create_location_page';
    const pr = scorePriority({ impact: create ? 3.5 : 3, effort: create ? 4 : 2, impressions: cell.impressions, position: cell.avgPosition, businessRelevance: 5, confidence: 0.6, notes: [cell.rationale] });
    await upsertRecommendation(ctx, {
      projectId,
      source: 'local',
      type: create ? 'new_page' : 'content',
      pageUrl: cell.coveringPage,
      title: create ? `Consider a ${cell.serviceName} page for ${cell.locationName}` : `Strengthen ${cell.locationName} relevance for ${cell.serviceName}`,
      what: create ? `Create ONE substantive ${cell.serviceName} page that genuinely serves ${cell.locationName} clients (not a templated doorway page).` : `Add a ${cell.locationName}-specific section (service area, office/NAP, local FAQs, relevant examples) to ${cell.coveringPage ? new URL(cell.coveringPage).pathname : 'the service page'}.`,
      why: cell.rationale,
      evidence: [{ label: 'Impressions (90d)', value: cell.impressions }, { label: 'Clicks (90d)', value: cell.clicks }, { label: 'Avg position', value: cell.avgPosition }, { label: 'Top queries', value: cell.queries.slice(0, 4).join(', ') }],
      expectedPurpose: 'Match local search intent with genuinely useful local information.',
      priority: pr,
      fingerprint: fingerprint('local', projectId, cell.serviceId, cell.locationId),
      queueForApproval: false,
    });
    recs++;
  }
  let ai: unknown = null;
  if ((input.useAi ?? true) && ctx.ai.enabled && ov.matrix.length) {
    try {
      const r = await ctx.ai.run('local-seo', { profile: { name: profile.name, address: profile.address, phone: profile.phone, services: profile.services.map((s) => s.name), targetLocations: ov.targetLocations }, matrix: ov.matrix.slice(0, 30), findings: { issues: ov.issues, localSchemaPresent: ov.localSchema.present, phonesFoundOnSite: ov.nap.phonesFoundOnSite } }, { projectId, correlationId: input.correlationId });
      ai = r.data;
    } catch (e) {
      ai = { error: (e as Error).message };
    }
  }
  void classifyIntent;
  return { cells: ov.matrix.length, recommendations: recs, ai };
}
