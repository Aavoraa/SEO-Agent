import { checkContentQuality, compareCompetitors, scorePriority, buildLocalMatrix } from '@phoenixx/seo-engine';
import { classifyIntent, comparePeriods, searchIntentProfile } from '@phoenixx/keyword-engine';
import { AppError, addDays, isoDate, slugify, type BusinessProfile } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { audit, getProject, latestCrawledPages, latestGscDate, profileOf, type Actor } from './common.js';
import { loadGscRows } from './alerts.js';
import { fingerprint } from './recommendations.js';
import { competitorSummaries, ownSummaries } from './competitors.js';
import { localQueries, pageLocalCoverage } from './local.js';

type OppType = 'missing_service_page' | 'missing_location_page' | 'informational' | 'faq' | 'comparison' | 'supporting_article' | 'refresh' | 'weak_coverage' | 'declining';

async function upsertOpportunity(ctx: AppContext, projectId: string, o: { type: OppType; title: string; targetKeyword?: string | null; clusterId?: string | null; targetPageUrl?: string | null; impact: number; effort: number; impressions?: number; position?: number | null; relevance: number; reasons: string[]; evidence: Record<string, unknown>; key: string }) {
  const pr = scorePriority({ impact: o.impact, effort: o.effort, impressions: o.impressions, position: o.position ?? null, businessRelevance: o.relevance, confidence: 0.65, notes: o.reasons });
  await ctx.db.query(
    `INSERT INTO content_opportunities(project_id, type, title, target_keyword, cluster_id, target_page_url, score, priority, score_breakdown, reasons, evidence, fingerprint, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (project_id, fingerprint) DO UPDATE SET title = EXCLUDED.title, score = EXCLUDED.score, priority = EXCLUDED.priority, score_breakdown = EXCLUDED.score_breakdown, reasons = EXCLUDED.reasons, evidence = EXCLUDED.evidence, target_page_url = EXCLUDED.target_page_url, updated_at = now()`,
    [projectId, o.type, o.title, o.targetKeyword ?? null, o.clusterId ?? null, o.targetPageUrl ?? null, pr.score, pr.priority, pr.factors, pr.reasons, o.evidence, fingerprint('opp', o.type, o.key)],
  );
}

/** Content Opportunity Agent – deterministic gap detection (+ optional AI content-gap review). */
export async function runContentOpportunities(ctx: AppContext, projectId: string, input: { useAi?: boolean; correlationId?: string } = {}) {
  const project = await getProject(ctx, projectId);
  const profile = profileOf(project);
  const { pages } = await latestCrawledPages(ctx, projectId);
  let n = 0;

  // 1. Clusters that need content
  const clusters = await ctx.db.query<any>(`SELECT * FROM keyword_clusters WHERE project_id = $1 AND total_impressions >= 20 ORDER BY opportunity_score DESC LIMIT 60`, [projectId]);
  for (const c of clusters) {
    const kws = await ctx.db.query<{ keyword: string }>(`SELECT keyword FROM keywords WHERE cluster_id = $1 ORDER BY opportunity_score DESC LIMIT 8`, [c.id]);
    const head = kws[0]?.keyword ?? c.name;
    const svc = profile.services.find((s) => c.services.includes(s.id));
    const common = { targetKeyword: head, clusterId: c.id, impressions: c.total_impressions, relevance: svc ? 4 : 2, evidence: { cluster: c.name, keywords: kws.map((k) => k.keyword), impressions: c.total_impressions, clicks: c.total_clicks }, key: c.key };
    if (c.strategy === 'faq') {
      await upsertOpportunity(ctx, projectId, { ...common, type: 'faq', title: `Add FAQs: ${c.name}`, targetPageUrl: c.target_page_url, impact: 2.5, effort: 1, reasons: ['Question queries about a service – answer them on the service page'] });
      n++;
    } else if (c.strategy === 'blog') {
      const isComparison = kws.some((k) => /\b(vs|versus|compare|comparison|alternatives?)\b/.test(k.keyword));
      await upsertOpportunity(ctx, projectId, { ...common, type: isComparison ? 'comparison' : 'informational', title: `${isComparison ? 'Comparison article' : 'Guide'}: ${head}`, impact: 3, effort: 3, reasons: ['Informational demand with no dedicated article'] });
      n++;
    } else if (c.strategy === 'single_page' && svc) {
      await upsertOpportunity(ctx, projectId, { ...common, type: 'missing_service_page', title: `Service page: ${svc.name}`, impact: 4, effort: 4, reasons: [`Commercial demand for ${svc.name} but no page targets it`] });
      n++;
    }
  }

  // 2. Local coverage – only where the matrix justifies it
  const matrix = buildLocalMatrix(await localQueries(ctx, projectId), pageLocalCoverage(pages, profile), profile, { minImpressionsForNewPage: project.settings?.thresholds?.minImpressionsForLocationPage });
  for (const cell of matrix.filter((m) => m.action === 'create_location_page' || m.action === 'add_location_section')) {
    await upsertOpportunity(ctx, projectId, {
      type: cell.action === 'create_location_page' ? 'missing_location_page' : 'weak_coverage',
      title: cell.action === 'create_location_page' ? `${cell.serviceName} in ${cell.locationName} page` : `Strengthen ${cell.locationName} relevance on ${cell.serviceName} page`,
      targetKeyword: cell.queries[0] ?? `${cell.serviceName.toLowerCase()} ${cell.locationName.toLowerCase()}`,
      targetPageUrl: cell.coveringPage,
      impact: 3,
      effort: cell.action === 'create_location_page' ? 4 : 2,
      impressions: cell.impressions,
      position: cell.avgPosition,
      relevance: 5,
      reasons: [cell.rationale],
      evidence: { queries: cell.queries, impressions: cell.impressions, avgPosition: cell.avgPosition },
      key: `${cell.serviceId}-${cell.locationId}`,
    });
    n++;
  }

  // 3. Declining pages → refresh
  const end = await latestGscDate(ctx.db, projectId);
  const rows = await loadGscRows(ctx, projectId, isoDate(addDays(end, -55)), end);
  for (const c of comparePeriods(rows, 'page', 28, end).filter((x) => x.trend === 'declining' && x.previous.impressions >= 100).slice(0, 10)) {
    await upsertOpportunity(ctx, projectId, { type: 'declining', title: `Refresh declining page ${new URL(c.key).pathname}`, targetPageUrl: c.key, impact: 3, effort: 2, impressions: c.previous.impressions, position: c.current.position, relevance: 3.5, reasons: [`Impressions ${c.previous.impressions} → ${c.current.impressions}, clicks ${c.previous.clicks} → ${c.current.clicks} (28d vs prior 28d)`], evidence: c as unknown as Record<string, unknown>, key: c.key });
    n++;
  }

  // 4. Thin important pages → refresh
  const thin = await ctx.db.query<any>(`SELECT url, evidence FROM seo_issues WHERE project_id = $1 AND rule_id = 'thin_content' AND status = 'open' AND severity IN ('high','critical')`, [projectId]);
  for (const t of thin) {
    await upsertOpportunity(ctx, projectId, { type: 'refresh', title: `Expand thin service page ${new URL(t.url).pathname}`, targetPageUrl: t.url, impact: 3.5, effort: 3, relevance: 5, reasons: [`Only ${t.evidence?.wordCount ?? '?'} words including navigation`], evidence: t.evidence, key: `thin-${t.url}` });
    n++;
  }

  // 5. Competitor structural gaps (page types / topics)
  const comps = await competitorSummaries(ctx, projectId);
  if (comps.length) {
    const rowsCmp = compareCompetitors(ownSummaries(pages), comps, profile).filter((r) => r.dimension === 'page_type' || (r.dimension === 'topic' && r.strength >= 2)).slice(0, 8);
    for (const r of rowsCmp) {
      await upsertOpportunity(ctx, projectId, { type: 'supporting_article', title: `Competitor gap: ${r.item}`, targetKeyword: r.dimension === 'topic' ? r.item : null, impact: 2, effort: 3, relevance: 2.5, reasons: [r.opportunity], evidence: { competitors: r.competitorsHave }, key: `comp-${r.dimension}-${r.item}` });
      n++;
    }
  }

  // 6. Optional AI review
  let aiItems = 0;
  if ((input.useAi ?? true) && ctx.ai.enabled && clusters.length) {
    try {
      const r = await ctx.ai.run(
        'content-gap',
        {
          profile: profileSummary(profile),
          pages: pages.filter((p) => p.indexable).map((p) => ({ url: p.url, title: p.title, h1: p.h1s[0] ?? null, words: p.wordCount })),
          clusters: clusters.slice(0, 25).map((c) => ({ name: c.name, strategy: c.strategy, intent: c.intent, totalImpressions: c.total_impressions, targetPageUrl: c.target_page_url })),
          competitorGaps: comps.length ? compareCompetitors(ownSummaries(pages), comps, profile).slice(0, 15) : [],
        },
        { projectId, correlationId: input.correlationId },
      );
      for (const it of r.data.items) {
        await upsertOpportunity(ctx, projectId, { type: it.type, title: it.title, targetKeyword: it.targetKeyword, targetPageUrl: it.suggestedUrl, impact: it.priority === 'high' ? 4 : it.priority === 'medium' ? 3 : 2, effort: 3, relevance: 3, reasons: [`AI: ${it.rationale}`], evidence: { evidence: it.evidence, aiModel: r.model }, key: `ai-${slugify(it.title)}` });
        aiItems++;
      }
    } catch (e) {
      ctx.log.warn('content.ai_gap_failed', { error: (e as Error).message });
    }
  }
  return { opportunities: n + aiItems, aiItems };
}

export function profileSummary(p: BusinessProfile) {
  return { name: p.name, description: p.description, url: p.url, phone: p.phone, address: p.address, services: p.services.map((s) => ({ name: s.name, url: s.path ?? null })), targetLocations: p.locations.filter((l) => l.target).map((l) => l.name), facts: p.facts, ctas: p.ctas, languages: p.languages };
}

/** Deterministic brief used when AI is off – a real, usable outline built from intent + evidence. */
export function deterministicBrief(keyword: string, profile: BusinessProfile, related: string[], pages: { url: string; title: string | null }[]) {
  const intent = classifyIntent(keyword, profile);
  const prof = searchIntentProfile(keyword, intent, profile);
  const svc = profile.services.find((s) => intent.services.includes(s.id));
  const loc = profile.locations.find((l) => intent.locations.includes(l.id));
  const title = keyword.replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    targetKeyword: keyword,
    searchIntent: `${intent.intent} – ${prof.userProblem}`,
    targetAudience: `Businesses${loc ? ` in ${loc.name}` : ''} evaluating ${svc?.name.toLowerCase() ?? 'IT and digital services'}`,
    suggestedTitle: `${title} | ${profile.name}`.slice(0, 65),
    h1: title,
    metaDescription: `${title}: what to expect, how the process works and how ${profile.name} can help. ${profile.ctas[0] ?? 'Contact us'}.`.slice(0, 158),
    outline: [
      { h2: `What ${keyword} involves`, h3s: ['Scope and deliverables', 'Who it is for'], notes: 'Plain-language explanation; no jargon.' },
      { h2: 'How the process works', h3s: ['Discovery', 'Delivery', 'Support after launch'], notes: 'Describe the real Phoenixx IT process – requires business input.' },
      { h2: 'Costs and timelines: what affects them', h3s: [], notes: 'Explain factors; do not publish prices unless provided by the business.' },
      { h2: 'Frequently asked questions', h3s: related.slice(0, 5), notes: 'Answer the real Search Console questions.' },
    ],
    entities: related.slice(0, 10),
    faqs: related.filter((r) => /^(how|what|why|which|is|can|does)\b/.test(r)).slice(0, 6).map((q) => ({ question: q, answerGuidance: 'Answer directly in 2–4 sentences using verified facts.' })),
    internalLinks: pages.filter((p) => p.title && p.url !== profile.url).slice(0, 4).map((p) => ({ url: p.url, anchor: p.title!.split('|')[0]!.trim().toLowerCase(), reason: 'Related service' })),
    cta: prof.recommendedCta,
    schemaRecommendations: prof.recommendedPageType === 'blog_article' ? ['Article', 'BreadcrumbList'] : ['Service', 'BreadcrumbList', 'FAQPage (only for visible Q&A)'],
    factsNeededFromBusiness: ['Delivery process and typical timeline', 'Engagement/pricing model (if it can be shared)', 'Real project examples the business can reference'],
    wordCountRange: prof.recommendedPageType === 'faq_entry' ? '150–300' : '900–1,500',
    avoid: ['Invented statistics or client names', 'Ranking guarantees', 'Keyword stuffing', 'Copying competitor text'],
    generatedBy: 'deterministic-template',
  };
}

export async function generateBrief(ctx: AppContext, projectId: string, opportunityId: string, actor: Actor, correlationId?: string) {
  const project = await getProject(ctx, projectId);
  const profile = profileOf(project);
  const opp = await ctx.db.one<any>('SELECT * FROM content_opportunities WHERE id = $1 AND project_id = $2', [opportunityId, projectId]);
  if (!opp) throw new AppError('Opportunity not found', 404, 'not_found');
  const keyword = opp.target_keyword ?? opp.title;
  const related = opp.cluster_id ? (await ctx.db.query<{ keyword: string }>('SELECT keyword FROM keywords WHERE cluster_id = $1 ORDER BY opportunity_score DESC LIMIT 15', [opp.cluster_id])).map((k) => k.keyword) : (opp.evidence?.queries ?? opp.evidence?.keywords ?? []);
  const { pages } = await latestCrawledPages(ctx, projectId);
  const sitePages = pages.filter((p) => p.indexable).map((p) => ({ url: p.url, title: p.title }));
  let brief: Record<string, unknown>;
  let model: string | null = null;
  if (ctx.ai.enabled) {
    const intent = classifyIntent(keyword, profile);
    const r = await ctx.ai.run('content-brief', { profile: profileSummary(profile), keyword, relatedQueries: related, intent: intent.intent, opportunity: { type: opp.type, title: opp.title, reasons: opp.reasons, evidence: opp.evidence }, pages: sitePages }, { projectId, correlationId });
    brief = { ...r.data, generatedBy: r.provider === 'mock' ? 'mock-ai (demo)' : `ai:${r.model}` };
    model = r.model;
  } else brief = deterministicBrief(keyword, profile, related, sitePages);
  const row = await ctx.db.one<{ id: string }>(`INSERT INTO content_briefs(project_id, opportunity_id, target_keyword, brief, status, ai_model, created_by) VALUES ($1,$2,$3,$4,'pending_approval',$5,$6) RETURNING id`, [projectId, opportunityId, keyword, brief, model, actor.type === 'user' ? actor.id : null]);
  await ctx.db.query(`UPDATE content_opportunities SET status = 'brief_created', updated_at = now() WHERE id = $1`, [opportunityId]);
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: 'content.brief_generated', entityType: 'content_brief', entityId: row!.id });
  return { briefId: row!.id, brief };
}

export async function decideBrief(ctx: AppContext, projectId: string, briefId: string, actor: Actor, decision: 'approve' | 'reject', comment?: string, editedBrief?: Record<string, unknown>) {
  if (!['admin', 'editor'].includes(actor.role)) throw new AppError('Only editors or admins can review briefs', 403, 'forbidden');
  const b = await ctx.db.one<any>('SELECT * FROM content_briefs WHERE id = $1 AND project_id = $2', [briefId, projectId]);
  if (!b) throw new AppError('Brief not found', 404, 'not_found');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await ctx.db.query(`UPDATE content_briefs SET status = $2, brief = COALESCE($3, brief), reviewed_by = $4, updated_at = now() WHERE id = $1`, [briefId, status, editedBrief ?? null, actor.type === 'user' ? actor.id : null]);
  await ctx.db.query(`INSERT INTO approvals(project_id, brief_id, decision, reviewer_id, reviewer_label, comment) VALUES ($1,$2,$3,$4,$5,$6)`, [projectId, briefId, editedBrief ? 'edited' : status, actor.type === 'user' ? actor.id : null, actor.label, comment ?? null]);
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: `content.brief_${status}`, entityType: 'content_brief', entityId: briefId });
  return { status };
}

export async function generateDraft(ctx: AppContext, projectId: string, briefId: string, actor: Actor, correlationId?: string) {
  const b = await ctx.db.one<any>('SELECT * FROM content_briefs WHERE id = $1 AND project_id = $2', [briefId, projectId]);
  if (!b) throw new AppError('Brief not found', 404, 'not_found');
  if (b.status !== 'approved') throw new AppError('The brief must be approved before a draft is generated', 409, 'invalid_state');
  if (!ctx.ai.enabled) throw new AppError('Draft generation requires an AI provider (set AI_PROVIDER). Briefs, opportunities and quality checks work without AI.', 400, 'ai_disabled');
  const profile = profileOf(await getProject(ctx, projectId));
  const r = await ctx.ai.run('content-draft', { profile: profileSummary(profile), brief: b.brief }, { projectId, correlationId });
  const quality = await runQuality(ctx, projectId, { title: r.data.title, bodyMarkdown: r.data.bodyMarkdown, targetKeyword: b.target_keyword, metaDescription: r.data.metaDescription, intent: String(b.brief?.searchIntent ?? '') }, profile, correlationId);
  const status = quality.verdict === 'reject' ? 'draft' : 'pending_approval';
  const prevVersion = await ctx.db.one<{ v: number }>('SELECT COALESCE(MAX(version),0)::int AS v FROM content_drafts WHERE brief_id = $1', [briefId]);
  const row = await ctx.db.one<{ id: string }>(
    `INSERT INTO content_drafts(project_id, brief_id, title, slug, body_markdown, meta, quality_report, quality_score, version, status, ai_model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [projectId, briefId, r.data.title, r.data.slug, r.data.bodyMarkdown, { metaDescription: r.data.metaDescription, placeholders: r.data.placeholders }, quality, quality.score, (prevVersion?.v ?? 0) + 1, status, r.model],
  );
  if (b.opportunity_id) await ctx.db.query(`UPDATE content_opportunities SET status = 'draft_created' WHERE id = $1`, [b.opportunity_id]);
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: 'content.draft_generated', entityType: 'content_draft', entityId: row!.id, details: { quality: quality.score, verdict: quality.verdict } });
  return { draftId: row!.id, status, quality };
}

/** Deterministic checks always; AI editorial review added when available. */
export async function runQuality(ctx: AppContext, projectId: string, d: { title: string; bodyMarkdown: string; targetKeyword: string; metaDescription?: string; intent?: string }, profile: BusinessProfile, correlationId?: string) {
  const report = checkContentQuality({ ...d, allowedFacts: profile.facts, requiredCta: undefined });
  const placeholders = (d.bodyMarkdown.match(/\[NEEDS INPUT[^\]]*\]/g) ?? []).length;
  let ai: unknown = null;
  if (ctx.ai.enabled) {
    try {
      const r = await ctx.ai.run('content-quality', { keyword: d.targetKeyword, intent: d.intent ?? '', facts: profile.facts, automated: report.checks.map((c) => `${c.id}: ${c.status} (${c.detail})`), title: d.title, body: d.bodyMarkdown }, { projectId, correlationId });
      ai = r.data;
    } catch (e) {
      ai = { error: (e as Error).message };
    }
  }
  const aiVerdict = (ai as { verdict?: string } | null)?.verdict;
  const verdict = report.verdict === 'reject' || aiVerdict === 'reject' ? 'reject' : report.verdict === 'needs_revision' || aiVerdict === 'needs_revision' || placeholders > 0 ? 'needs_revision' : 'ready_for_review';
  return { ...report, verdict, placeholders, ai };
}

export async function decideDraft(ctx: AppContext, projectId: string, draftId: string, actor: Actor, decision: 'approve' | 'reject', comment?: string, edited?: { title?: string; bodyMarkdown?: string }) {
  if (!['admin', 'editor'].includes(actor.role)) throw new AppError('Only editors or admins can review drafts', 403, 'forbidden');
  const d = await ctx.db.one<any>('SELECT * FROM content_drafts WHERE id = $1 AND project_id = $2', [draftId, projectId]);
  if (!d) throw new AppError('Draft not found', 404, 'not_found');
  if (decision === 'approve' && /\[NEEDS INPUT/.test(edited?.bodyMarkdown ?? d.body_markdown)) throw new AppError('Draft still contains [NEEDS INPUT] placeholders – fill them with verified facts before approving.', 409, 'placeholders');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  await ctx.db.query(`UPDATE content_drafts SET status = $2, title = COALESCE($3, title), body_markdown = COALESCE($4, body_markdown), reviewed_by = $5, updated_at = now() WHERE id = $1`, [draftId, status, edited?.title ?? null, edited?.bodyMarkdown ?? null, actor.type === 'user' ? actor.id : null]);
  await ctx.db.query(`INSERT INTO approvals(project_id, draft_id, decision, reviewer_id, reviewer_label, comment) VALUES ($1,$2,$3,$4,$5,$6)`, [projectId, draftId, edited ? 'edited' : status, actor.type === 'user' ? actor.id : null, actor.label, comment ?? null]);
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: `content.draft_${status}`, entityType: 'content_draft', entityId: draftId });
  return { status, note: status === 'approved' ? 'Approved drafts are never auto-published. Export the Markdown and publish through your CMS / website repository.' : undefined };
}
