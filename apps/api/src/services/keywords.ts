import { classifyIntent, classifyKeywordType, clusterKeywords, comparePeriods, expandKeywords, normalizeKeyword, searchIntentProfile, type ClusterInputKeyword } from '@phoenixx/keyword-engine';
import { queryOpportunity, scorePriority } from '@phoenixx/seo-engine';
import { addDays, chunk, isoDate, round } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestGscDate, profileOf } from './common.js';
import { loadGscRows } from './alerts.js';
import { fingerprint, upsertRecommendation } from './recommendations.js';

/**
 * Keyword Opportunity Discovery (n8n workflow 3):
 * Search Console → normalise → intent → type → metrics (7/28/90 vs previous) →
 * opportunity scoring → clustering → cannibalisation → recommendations.
 * Search volume is never invented: GSC impressions are the demand signal.
 */
export async function runKeywordDiscovery(ctx: AppContext, projectId: string, input: { minImpressions?: number; maxKeywords?: number; useAi?: boolean; correlationId?: string } = {}) {
  const project = await getProject(ctx, projectId);
  const profile = profileOf(project);
  const end = await latestGscDate(ctx.db, projectId);
  const rows = await loadGscRows(ctx, projectId, isoDate(addDays(end, -179)), end);
  if (!rows.length) return { keywords: 0, clusters: 0, note: 'No Search Console data yet – connect Search Console and run the daily sync first.' };

  const windows = [7, 28, 90] as const;
  const cmp = Object.fromEntries(windows.map((w) => [w, new Map(comparePeriods(rows, 'query', w, end).map((c) => [c.key, c]))])) as Record<(typeof windows)[number], Map<string, ReturnType<typeof comparePeriods>[number]>>;
  const minImp = input.minImpressions ?? 5;
  const candidates = [...cmp[90].values()].filter((c) => c.current.impressions >= minImp).sort((a, b) => b.current.impressions - a.current.impressions).slice(0, input.maxKeywords ?? 3000);
  const tot = candidates.reduce((a, c) => ({ c: a.c + c.current.clicks, i: a.i + c.current.impressions }), { c: 0, i: 0 });
  const siteAvgCtr = tot.i ? tot.c / tot.i : 0;

  // pages per query (90d) for clustering / cannibalisation
  const since90 = isoDate(addDays(end, -89));
  const pagesByQuery = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (r.date < since90) continue;
    const m = pagesByQuery.get(r.query) ?? new Map<string, number>();
    m.set(r.page, (m.get(r.page) ?? 0) + r.impressions);
    pagesByQuery.set(r.query, m);
  }

  const ids = new Map<string, string>();
  const clusterInput: ClusterInputKeyword[] = [];
  for (const c of candidates) {
    const q = c.key;
    const norm = normalizeKeyword(q);
    const intent = classifyIntent(q, profile);
    const type = classifyKeywordType(q, intent, { impressions: c.current.impressions });
    const prof = searchIntentProfile(q, intent, profile);
    const targetLoc = intent.locations.some((l) => profile.locations.find((x) => x.id === l)?.target);
    const relevance = intent.isBranded ? 1 : Math.min(5, (intent.services.length ? 3.5 : 1.5) + (targetLoc ? 1 : 0) + (['commercial', 'transactional', 'local'].includes(intent.intent) ? 0.5 : 0));
    const m28 = cmp[28].get(q);
    const opp = queryOpportunity({ impressions: c.current.impressions, clicks: c.current.clicks, position: c.current.position ?? 100, ctr: c.current.ctr }, siteAvgCtr, relevance);
    if (m28?.trend === 'declining') opp.reasons.push('Declining over the last 28 days');
    const row = await ctx.db.one<{ id: string }>(
      `INSERT INTO keywords(project_id, keyword, normalized, intent, intent_confidence, intent_source, keyword_type, services, locations, source, search_volume, search_volume_source, target_page_url, is_branded, user_problem, expected_content, recommended_page_type, recommended_cta, opportunity_score, opportunity_reasons, updated_at)
       VALUES ($1,$2,$3,$4,$5,'rules',$6,$7,$8,'gsc',NULL,'unavailable',$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (project_id, normalized) DO UPDATE SET
         intent = CASE WHEN keywords.intent_source = 'ai' THEN keywords.intent ELSE EXCLUDED.intent END,
         intent_confidence = CASE WHEN keywords.intent_source = 'ai' THEN keywords.intent_confidence ELSE EXCLUDED.intent_confidence END,
         keyword_type = EXCLUDED.keyword_type, services = EXCLUDED.services, locations = EXCLUDED.locations, source = 'gsc',
         target_page_url = EXCLUDED.target_page_url, is_branded = EXCLUDED.is_branded, opportunity_score = EXCLUDED.opportunity_score,
         opportunity_reasons = EXCLUDED.opportunity_reasons, recommended_page_type = EXCLUDED.recommended_page_type, recommended_cta = EXCLUDED.recommended_cta,
         user_problem = COALESCE(keywords.user_problem, EXCLUDED.user_problem), expected_content = COALESCE(keywords.expected_content, EXCLUDED.expected_content), updated_at = now()
       RETURNING id`,
      [projectId, q, norm, intent.intent, intent.confidence, type, intent.services, intent.locations, c.topPage, intent.isBranded, prof.userProblem, prof.expectedContent, prof.recommendedPageType, prof.recommendedCta, opp.score, opp.reasons],
    );
    ids.set(q, row!.id);
    for (const w of windows) {
      const x = cmp[w].get(q);
      if (!x) continue;
      await ctx.db.query(
        `INSERT INTO keyword_metrics(keyword_id, window_days, period_end, clicks, impressions, ctr, position, prev_clicks, prev_impressions, prev_position, trend, top_page, pages_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (keyword_id, window_days, period_end) DO UPDATE SET clicks = EXCLUDED.clicks, impressions = EXCLUDED.impressions, ctr = EXCLUDED.ctr, position = EXCLUDED.position,
           prev_clicks = EXCLUDED.prev_clicks, prev_impressions = EXCLUDED.prev_impressions, prev_position = EXCLUDED.prev_position, trend = EXCLUDED.trend, top_page = EXCLUDED.top_page, pages_count = EXCLUDED.pages_count, computed_at = now()`,
        [row!.id, w, end, x.current.clicks, x.current.impressions, x.current.ctr, x.current.position, x.previous.clicks, x.previous.impressions, x.previous.position, x.trend, x.topPage, x.pages],
      );
    }
    if (!intent.isBranded) {
      clusterInput.push({ keyword: q, intent: intent.intent, services: intent.services, locations: intent.locations, impressions: c.current.impressions, clicks: c.current.clicks, position: c.current.position, pages: [...(pagesByQuery.get(q) ?? new Map()).entries()].map(([url, impressions]) => ({ url, impressions })), isQuestion: intent.isQuestion });
    }
  }

  // Expansion hypotheses (no volume, clearly labelled)
  const existing = new Set((await ctx.db.query<{ normalized: string }>('SELECT normalized FROM keywords WHERE project_id = $1', [projectId])).map((r) => r.normalized));
  let expanded = 0;
  for (const e of expandKeywords(profile, existing)) {
    const intent = classifyIntent(e.keyword, profile);
    await ctx.db.query(
      `INSERT INTO keywords(project_id, keyword, normalized, intent, intent_confidence, keyword_type, services, locations, source, search_volume_source, opportunity_score, opportunity_reasons)
       VALUES ($1,$2,$2,$3,$4,$5,$6,$7,'expansion','unavailable',0,$8) ON CONFLICT (project_id, normalized) DO NOTHING`,
      [projectId, e.keyword, intent.intent, intent.confidence, classifyKeywordType(e.keyword, intent), e.services, e.locations, ['Hypothesis from service × location expansion – no Search Console impressions yet; search volume unavailable']],
    );
    expanded++;
  }

  // Clustering
  const clusters = clusterKeywords(clusterInput, profile);
  let clusterCount = 0;
  for (const cl of clusters) {
    const avgPos = cl.keywords.reduce((s, k) => s + (cmp[90].get(k)?.current.position ?? 0) * (cmp[90].get(k)?.current.impressions ?? 0), 0) / Math.max(1, cl.totalImpressions);
    const score = round(Math.min(100, Math.log10(cl.totalImpressions + 1) * 18 + (avgPos >= 4 && avgPos <= 20 ? 20 : 0) + (cl.services.length ? 15 : 0) + (cl.cannibalization.length ? 5 : 0)), 0);
    const row = await ctx.db.one<{ id: string }>(
      `INSERT INTO keyword_clusters(project_id, name, key, intent, strategy, recommended_page_type, target_page_url, rationale, services, locations, total_clicks, total_impressions, opportunity_score, cannibalization, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
       ON CONFLICT (project_id, key) DO UPDATE SET name = CASE WHEN keyword_clusters.ai_refined THEN keyword_clusters.name ELSE EXCLUDED.name END, intent = EXCLUDED.intent,
         strategy = CASE WHEN keyword_clusters.ai_refined THEN keyword_clusters.strategy ELSE EXCLUDED.strategy END, recommended_page_type = EXCLUDED.recommended_page_type,
         target_page_url = CASE WHEN keyword_clusters.ai_refined THEN keyword_clusters.target_page_url ELSE EXCLUDED.target_page_url END,
         rationale = CASE WHEN keyword_clusters.ai_refined THEN keyword_clusters.rationale ELSE EXCLUDED.rationale END, services = EXCLUDED.services, locations = EXCLUDED.locations,
         total_clicks = EXCLUDED.total_clicks, total_impressions = EXCLUDED.total_impressions, opportunity_score = EXCLUDED.opportunity_score, cannibalization = EXCLUDED.cannibalization, updated_at = now()
       RETURNING id`,
      [projectId, cl.name, cl.key, cl.intent, cl.strategy, cl.recommendedPageType, cl.targetPageUrl, cl.rationale, cl.services, cl.locations, cl.totalClicks, cl.totalImpressions, score, cl.cannibalization],
    );
    const kwIds = cl.keywords.map((k) => ids.get(k)).filter(Boolean) as string[];
    if (kwIds.length) await ctx.db.query('UPDATE keywords SET cluster_id = $1 WHERE id = ANY($2::uuid[])', [row!.id, kwIds]);
    clusterCount++;

    // Cannibalisation → recommendation (consolidate on one target; high-risk if it implies canonical/redirect)
    if (cl.cannibalization.length >= 2 && cl.totalImpressions >= 100) {
      const pr = scorePriority({ impact: 3, effort: 2, impressions: cl.totalImpressions, position: avgPos, businessRelevance: cl.services.length ? 4 : 2, confidence: 0.6, notes: [`${cl.cannibalization.length} pages split impressions for "${cl.name}"`] });
      await upsertRecommendation(ctx, {
        projectId,
        source: 'keyword',
        type: 'content',
        pageUrl: cl.targetPageUrl,
        title: `Keyword cannibalisation: ${cl.name}`,
        what: `Choose one target page for this topic and differentiate or de-optimise the others (${cl.cannibalization.map((c) => new URL(c.url).pathname).join(', ')}).`,
        why: `Search Console shows ${cl.cannibalization.length} pages each receiving ≥20% of impressions for the same queries, which splits relevance signals.`,
        evidence: cl.cannibalization.map((c) => ({ label: new URL(c.url).pathname, value: `${c.impressions} impressions (${Math.round(c.share * 100)}%)` })),
        expectedPurpose: 'Concentrate relevance on the best page for this intent.',
        risk: 'medium',
        priority: pr,
        fingerprint: fingerprint('cannibal', projectId, cl.key),
        queueForApproval: false,
      });
    }
  }

  // Striking-distance opportunities on existing pages → on-page optimisation candidates
  const striking = candidates.filter((c) => (c.current.position ?? 99) >= 4 && (c.current.position ?? 99) <= 20 && c.current.impressions >= 50 && c.topPage && c.current.ctr < siteAvgCtr).slice(0, 15);
  for (const s of striking) {
    const intent = classifyIntent(s.key, profile);
    if (intent.isBranded) continue;
    const pr = scorePriority({ impact: 3.5, effort: 1, impressions: s.current.impressions, clicks: s.current.clicks, position: s.current.position, ctr: s.current.ctr, siteAvgCtr, businessRelevance: intent.services.length ? 4.5 : 2.5, confidence: 0.7 });
    await upsertRecommendation(ctx, {
      projectId,
      source: 'keyword',
      type: 'title',
      pageUrl: s.topPage,
      title: `Improve title/meta for "${s.key}"`,
      what: `Optimise ${new URL(s.topPage!).pathname} title and meta description for "${s.key}" (and its cluster) to lift click-through.`,
      why: `The page ranks at position ${s.current.position} with ${s.current.impressions} impressions but a CTR below the site average.`,
      evidence: [
        { label: 'Query', value: s.key },
        { label: 'Impressions (90d)', value: s.current.impressions },
        { label: 'Clicks (90d)', value: s.current.clicks },
        { label: 'CTR', value: `${round(s.current.ctr * 100, 2)}%` },
        { label: 'Site avg CTR', value: `${round(siteAvgCtr * 100, 2)}%` },
        { label: 'Avg position', value: s.current.position },
      ],
      currentValue: null,
      expectedPurpose: 'Earn more clicks from existing rankings (no ranking guarantee).',
      priority: pr,
      fingerprint: fingerprint('striking', projectId, s.topPage, s.key),
      queueForApproval: false,
    });
  }

  // Optional AI refinement of low-confidence intents (batched, cached)
  let aiRefined = 0;
  if ((input.useAi ?? project.settings?.ai?.refineKeywordIntent ?? true) && ctx.ai.enabled) {
    const low = await ctx.db.query<any>(`SELECT id, keyword, intent, keyword_type, intent_confidence FROM keywords WHERE project_id = $1 AND source = 'gsc' AND intent_source = 'rules' AND intent_confidence < 0.6 ORDER BY opportunity_score DESC LIMIT 100`, [projectId]);
    for (const batch of chunk(low, 40)) {
      try {
        const r = await ctx.ai.run('keyword-intent', { profile: { name: profile.name, services: profile.services.map((s) => s.name), locations: profile.locations.filter((l) => l.target).map((l) => l.name) }, queries: batch.map((b) => ({ keyword: b.keyword, intent: b.intent, keywordType: b.keyword_type, confidence: b.intent_confidence })) }, { projectId, correlationId: input.correlationId });
        for (const item of r.data.items) {
          const k = batch.find((b) => b.keyword === item.keyword);
          if (!k) continue;
          await ctx.db.query(`UPDATE keywords SET intent = $2, keyword_type = $3, intent_confidence = $4, intent_source = 'ai', user_problem = $5, expected_content = $6, recommended_page_type = $7, recommended_cta = $8 WHERE id = $1`, [k.id, item.intent, item.keywordType, item.confidence, item.userProblem, item.expectedContent, item.recommendedPageType, item.recommendedCta]);
          aiRefined++;
        }
      } catch (e) {
        ctx.log.warn('keywords.ai_refine_failed', { error: (e as Error).message });
      }
    }
  }

  // Optional AI review of the top clusters (page strategy / naming / merge suggestions). Cached per input.
  let clustersReviewed = 0;
  if ((input.useAi ?? true) && ctx.ai.enabled && clusters.length) {
    try {
      const top = await ctx.db.query<any>(`SELECT id, key, name, intent, strategy, target_page_url, total_impressions, rationale, cannibalization FROM keyword_clusters WHERE project_id = $1 ORDER BY opportunity_score DESC LIMIT 25`, [projectId]);
      const pages = await ctx.db.query<{ url: string; title: string | null }>(`SELECT p.url, p.title FROM pages p JOIN websites w ON w.id = p.website_id WHERE w.project_id = $1 AND p.indexable AND p.removed_at IS NULL`, [projectId]);
      const r = await ctx.ai.run('keyword-clustering', { profile: { name: profile.name, services: profile.services.map((s) => ({ name: s.name, url: s.path ?? null })) }, pages, clusters: top.map((c) => ({ key: c.key, name: c.name, intent: c.intent, strategy: c.strategy, targetPageUrl: c.target_page_url, impressions: c.total_impressions, rationale: c.rationale, cannibalization: c.cannibalization })) }, { projectId, correlationId: input.correlationId });
      for (const c of r.data.clusters) {
        const row = top.find((t) => t.key === c.key);
        if (!row) continue;
        await ctx.db.query(`UPDATE keyword_clusters SET name = $2, strategy = $3, target_page_url = $4, rationale = $5, ai_refined = true, updated_at = now() WHERE id = $1`, [row.id, c.name, c.strategy, c.targetPageUrl ?? row.target_page_url, c.mergeWithKey ? `${c.rationale} (AI suggests merging with cluster ${c.mergeWithKey})` : c.rationale]);
        clustersReviewed++;
      }
    } catch (e) {
      ctx.log.warn('keywords.ai_cluster_review_failed', { error: (e as Error).message });
    }
  }

  return { keywords: candidates.length, expanded, clusters: clusterCount, clustersReviewed, strikingDistance: striking.length, aiRefined, periodEnd: end };
}
