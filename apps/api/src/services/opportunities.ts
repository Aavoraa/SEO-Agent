import { CONFIDENCE_VALUE, demandImpact, RISK_VALUE, SEVERITY_URGENCY, scoreOpportunity, type OpportunityInput } from '@phoenixx/seo-engine';
import { addDays, AppError, isoDate, riskForType, type RecommendationType } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, latestGscDate, profileOf } from './common.js';
import { recommendationGroups } from './audits.js';

/**
 * Opportunity Engine service: gathers candidates from every source, scores them with the documented
 * formula (packages/seo-engine/src/opportunity.ts), and upserts them so status and history persist.
 * Candidates that disappear (fixed, resolved) are closed automatically.
 */
interface Candidate {
  fingerprint: string;
  source: string;
  sourceRef?: string | null;
  title: string;
  summary: string;
  action: string;
  url?: string | null;
  affected?: number;
  input: OpportunityInput;
  evidence: { label: string; value: string | number }[];
  expectedOutcome: string;
  dataSources: string[];
  recommendationIds?: string[];
  automatable?: boolean;
  historyKey?: string;
}

const pathOf = (u: string | null | undefined) => {
  try {
    return u ? new URL(u).pathname : '/';
  } catch {
    return u ?? '/';
  }
};

async function decisionHistory(ctx: AppContext, projectId: string) {
  const rows = await ctx.db.query<{ type: string; approved: number; rejected: number }>(
    `SELECT r.type, COUNT(*) FILTER (WHERE a.decision IN ('approved','edited'))::int AS approved, COUNT(*) FILTER (WHERE a.decision = 'rejected')::int AS rejected
     FROM approvals a JOIN recommendations r ON r.id = a.recommendation_id WHERE a.project_id = $1 GROUP BY r.type`,
    [projectId],
  );
  return new Map(rows.map((r) => [r.type, { approved: r.approved, rejected: r.rejected }]));
}

async function collect(ctx: AppContext, projectId: string): Promise<Candidate[]> {
  const project = await getProject(ctx, projectId);
  const profile = profileOf(project);
  const important = new Set((await ctx.db.query<{ url: string }>('SELECT url FROM pages WHERE is_important AND removed_at IS NULL AND website_id IN (SELECT id FROM websites WHERE project_id = $1)', [projectId])).map((r) => r.url));
  const servicePaths = new Set(profile.services.filter((s) => s.path).map((s) => s.path!));
  const bizValue = (url: string | null | undefined) => (!url ? 0.6 : important.has(url) || servicePaths.has(pathOf(url)) || pathOf(url) === '/' ? 1 : /privacy|terms|cookie/.test(url) ? 0.15 : 0.5);
  const out: Candidate[] = [];

  // 1. Audit findings (crawler) – one opportunity per finding type.
  for (const g of await recommendationGroups(ctx, projectId)) {
    if (g.severity === 'info') continue;
    const breadth = Math.min(1, g.affected / 5);
    const bv = g.businessValue !== null ? g.businessValue / 5 : Math.max(...g.pages.map((p: { url: string | null }) => bizValue(p.url)), 0.4);
    out.push({
      fingerprint: `audit:${g.ruleId}`,
      source: 'audit',
      sourceRef: g.ruleId,
      title: g.affected > 1 ? `${g.title} (${g.affected} pages)` : `${g.title}${g.pages[0]?.url ? ` · ${pathOf(g.pages[0].url)}` : ''}`,
      summary: g.pages[0]?.found ?? g.title,
      action: g.action ?? 'Review the affected pages',
      url: g.affected === 1 ? g.pages[0]?.url ?? null : null,
      affected: g.affected,
      input: {
        impact: ((g.impact ?? 2) / 5) * (0.7 + 0.3 * breadth),
        effort: (g.effort ?? 2) / 5,
        confidence: CONFIDENCE_VALUE[g.confidence ?? 'medium'] ?? 0.7,
        businessValue: bv,
        risk: RISK_VALUE[g.risk ?? 'medium'] ?? 0.4,
        timeSensitivity: SEVERITY_URGENCY[g.severity] ?? 0.2,
        kind: g.category === 'ai_search' ? 'ai_search' : g.severity === 'critical' ? 'at_risk' : null,
      },
      evidence: [
        { label: 'Found by', value: 'Site crawler (latest audit)' },
        { label: 'Pages affected', value: g.affected },
        { label: 'Severity', value: g.severity },
        ...g.pages.slice(0, 3).map((p: { url: string | null; found: string }) => ({ label: pathOf(p.url), value: p.found })),
      ],
      expectedOutcome: g.expectedOutcome ?? 'Resolves a detected SEO issue',
      dataSources: ['crawler'],
      recommendationIds: g.pages.map((p: { recommendationId: string | null }) => p.recommendationId).filter(Boolean) as string[],
      automatable: g.deployable && (g.canFixWithAi || g.pages.some((p: { proposedValue: string | null }) => !!p.proposedValue)),
      historyKey: g.changeType ?? undefined,
    });
  }

  // 2. Search Console: pages with demand ranking 4–20 and below-average CTR ("optimize this page").
  const end = await latestGscDate(ctx.db, projectId);
  const start = isoDate(addDays(end, -27));
  const pageRows = await ctx.db.query<{ page: string; clicks: number; impressions: number; position: number | null; queries: number; top: string[] }>(
    `SELECT page, SUM(clicks)::int AS clicks, SUM(impressions)::int AS impressions, (SUM(position*impressions)/NULLIF(SUM(impressions),0))::float AS position,
            COUNT(DISTINCT query)::int AS queries, (ARRAY_AGG(query ORDER BY impressions DESC))[1:3] AS top
     FROM search_console_data WHERE project_id = $1 AND page <> '' AND query <> '' AND date BETWEEN $2 AND $3 GROUP BY page`,
    [projectId, start, end],
  );
  const tot = pageRows.reduce((a, r) => ({ c: a.c + r.clicks, i: a.i + r.impressions }), { c: 0, i: 0 });
  const siteCtr = tot.i ? tot.c / tot.i : 0;
  for (const r of pageRows) {
    if (r.position === null || r.position < 3.5 || r.position > 20 || r.impressions < 100) continue;
    const ctr = r.impressions ? r.clicks / r.impressions : 0;
    if (ctr >= siteCtr && r.position < 8) continue;
    out.push({
      fingerprint: `gsc-page:${pathOf(r.page)}`,
      source: 'keyword',
      sourceRef: r.page,
      title: `Optimize ${pathOf(r.page)}`,
      summary: `${r.impressions.toLocaleString('en-US')} impressions, avg position ${r.position.toFixed(1)}, CTR ${(ctr * 100).toFixed(1)}% (site ${(siteCtr * 100).toFixed(1)}%) across ${r.queries} queries`,
      action: `Improve the title, meta description and on-page coverage of ${pathOf(r.page)} for “${r.top.slice(0, 2).join('”, “')}”.`,
      url: r.page,
      affected: 1,
      input: { impact: demandImpact(r.impressions, r.position), effort: 0.2, confidence: 0.85, businessValue: bizValue(r.page), risk: RISK_VALUE.low!, timeSensitivity: 0.3 },
      evidence: [
        { label: 'Impressions (28d)', value: r.impressions },
        { label: 'Clicks (28d)', value: r.clicks },
        { label: 'Avg position', value: Number(r.position.toFixed(1)) },
        { label: 'CTR vs site', value: `${(ctr * 100).toFixed(1)}% vs ${(siteCtr * 100).toFixed(1)}%` },
        { label: 'Top queries', value: r.top.join(', ') },
      ],
      expectedOutcome: 'More clicks from rankings the page already has (striking distance)',
      dataSources: ['google_search_console'],
      automatable: true,
      historyKey: 'title',
    });
  }

  // 3. Declining rankings (keyword trend) – at risk.
  const declining = await ctx.db.query<{ page: string | null; n: number; lost_clicks: number; examples: string[] }>(
    `SELECT m.top_page AS page, COUNT(*)::int AS n, SUM(GREATEST(m.prev_clicks - m.clicks, 0))::int AS lost_clicks, (ARRAY_AGG(k.keyword ORDER BY m.prev_clicks DESC))[1:3] AS examples
     FROM keywords k JOIN LATERAL (SELECT * FROM keyword_metrics km WHERE km.keyword_id = k.id AND km.window_days = 28 ORDER BY period_end DESC LIMIT 1) m ON true
     WHERE k.project_id = $1 AND m.trend IN ('declining','lost') AND m.prev_clicks > 0 GROUP BY m.top_page HAVING SUM(GREATEST(m.prev_clicks - m.clicks, 0)) >= 3`,
    [projectId],
  );
  for (const d of declining) {
    out.push({
      fingerprint: `decline:${pathOf(d.page)}`,
      source: 'keyword',
      title: `Rankings declining on ${pathOf(d.page)}`,
      summary: `${d.n} queries lost ${d.lost_clicks} clicks vs the previous 28 days`,
      action: 'Check what changed on the page and in the SERP; refresh the content if it is outdated.',
      url: d.page,
      input: { impact: Math.min(1, 0.3 + d.lost_clicks / 100), effort: 0.4, confidence: 0.75, businessValue: bizValue(d.page), risk: RISK_VALUE.medium!, timeSensitivity: 0.85, kind: 'at_risk' },
      evidence: [
        { label: 'Declining queries', value: d.n },
        { label: 'Clicks lost (28d vs prior 28d)', value: d.lost_clicks },
        { label: 'Examples', value: d.examples.join(', ') },
      ],
      expectedOutcome: 'Recover lost clicks before the decline compounds',
      dataSources: ['google_search_console'],
    });
  }

  // 4. Content gaps (demand without a page).
  for (const c of await ctx.db.query<any>(`SELECT id, type, title, target_keyword, score, priority, evidence FROM content_opportunities WHERE project_id = $1 AND status = 'open' ORDER BY score DESC LIMIT 20`, [projectId])) {
    const emerging = c.evidence?.trend === 'rising' || c.evidence?.trend === 'new' ? ('emerging' as const) : null;
    out.push({
      fingerprint: `content:${c.id}`,
      source: 'content',
      sourceRef: c.id,
      title: c.title,
      summary: c.target_keyword ? `Search demand for “${c.target_keyword}” without a matching page` : 'Content gap',
      action: c.type === 'refresh' || c.type === 'declining' ? 'Refresh and expand the existing page' : 'Create a brief and a new page (content workflow)',
      input: { impact: Math.min(1, (c.score ?? 50) / 100), effort: c.type === 'refresh' ? 0.4 : 0.7, confidence: 0.65, businessValue: 0.7, risk: RISK_VALUE.medium!, timeSensitivity: c.type === 'declining' ? 0.8 : 0.25, kind: c.type === 'declining' ? 'at_risk' : emerging },
      evidence: [{ label: 'Opportunity score', value: Math.round(c.score ?? 0) }, { label: 'Type', value: c.type }],
      expectedOutcome: 'New rankings for demand the site does not serve yet',
      dataSources: ['google_search_console', 'crawler'],
      historyKey: 'new_page',
    });
  }

  // 5. Internal links (grouped per target page).
  for (const l of await ctx.db.query<{ target_url: string; n: number; score: number }>(`SELECT target_url, COUNT(*)::int AS n, MAX(score)::float AS score FROM internal_link_opportunities WHERE project_id = $1 AND status IN ('open','recommended') GROUP BY target_url`, [projectId])) {
    out.push({
      fingerprint: `links:${pathOf(l.target_url)}`,
      source: 'internal_link',
      title: `Add ${l.n} internal link(s) to ${pathOf(l.target_url)}`,
      summary: 'Related pages do not link here yet',
      action: 'Review and approve the suggested contextual links',
      url: l.target_url,
      affected: l.n,
      input: { impact: Math.min(0.7, 0.25 + l.n * 0.08), effort: 0.15, confidence: 0.7, businessValue: bizValue(l.target_url), risk: RISK_VALUE.low!, timeSensitivity: 0.15 },
      evidence: [{ label: 'Suggested links', value: l.n }, { label: 'Best link score', value: Math.round(l.score) }],
      expectedOutcome: 'Better discovery and relevance signals for the target page',
      dataSources: ['crawler'],
      historyKey: 'internal_link',
    });
  }

  // 6. Backlinks pointing at broken pages.
  for (const b of await ctx.db.query<{ target: string; links: number; domains: number }>(
    `SELECT COALESCE(NULLIF(target_url, ''), target_final_url) AS target, COUNT(*)::int AS links, COUNT(DISTINCT source_domain)::int AS domains FROM backlinks WHERE project_id = $1 AND status IN ('live','unverified') AND target_status >= 400 GROUP BY 1`,
    [projectId],
  )) {
    out.push({
      fingerprint: `backlink-broken:${pathOf(b.target)}`,
      source: 'backlink',
      title: `Recover ${b.links} backlink(s) to ${pathOf(b.target)}`,
      summary: `${b.domains} site(s) link to a page that no longer works`,
      action: 'Approve the proposed 301 redirect (admin)',
      url: b.target,
      input: { impact: Math.min(1, 0.4 + b.domains * 0.1), effort: 0.1, confidence: 0.8, businessValue: 0.7, risk: RISK_VALUE.high!, timeSensitivity: 0.6, kind: 'at_risk' },
      evidence: [{ label: 'Backlinks', value: b.links }, { label: 'Referring domains', value: b.domains }],
      expectedOutcome: 'Recovered link value and visitors',
      dataSources: ['backlink_import', 'crawler'],
      historyKey: 'redirect',
    });
  }

  // 7. Deployments that failed or could not be verified.
  for (const c of await ctx.db.query<any>(`SELECT id, page_url, change_type, status FROM seo_changes WHERE project_id = $1 AND status IN ('failed','verification_failed')`, [projectId])) {
    out.push({
      fingerprint: `change:${c.id}`,
      source: 'deployment',
      sourceRef: c.id,
      title: `${c.status === 'failed' ? 'Deployment failed' : 'Change not verified'}: ${c.change_type.replace('_', ' ')} on ${pathOf(c.page_url)}`,
      summary: c.status === 'failed' ? 'The approved change is not live' : 'The live page does not show the approved change',
      action: c.status === 'failed' ? 'Open Changes, check the failed step and retry' : 'Check caches or roll back',
      url: c.page_url,
      input: { impact: 0.5, effort: 0.15, confidence: 0.95, businessValue: bizValue(c.page_url), risk: RISK_VALUE[riskForType(c.change_type as RecommendationType)] ?? 0.4, timeSensitivity: 0.9, kind: 'at_risk' },
      evidence: [{ label: 'Status', value: c.status }],
      expectedOutcome: 'The approved improvement actually reaches the site',
      dataSources: ['deployment_verification'],
    });
  }

  // 8. Open high/critical alerts (one opportunity per distinct alert title).
  for (const a of await ctx.db.query<any>(`SELECT DISTINCT ON (title) id, severity, type, title, message FROM alerts WHERE project_id = $1 AND status = 'open' AND severity IN ('critical','high') AND type NOT LIKE 'deployment%' ORDER BY title, last_seen_at DESC`, [projectId])) {
    out.push({
      fingerprint: `alert:${a.type}:${a.title}`,
      source: 'alert',
      sourceRef: a.id,
      title: a.title,
      summary: String(a.message).slice(0, 240),
      action: 'Investigate the alert',
      input: { impact: a.severity === 'critical' ? 0.9 : 0.6, effort: 0.3, confidence: 0.8, businessValue: 0.7, risk: 0.3, timeSensitivity: a.severity === 'critical' ? 1 : 0.8, kind: 'at_risk' },
      evidence: [{ label: 'Alert', value: `${a.severity} · ${a.type}` }],
      expectedOutcome: 'Stops an active loss',
      dataSources: ['alerts'],
    });
  }
  return out;
}

export async function refreshOpportunities(ctx: AppContext, projectId: string) {
  const [cands, history] = await Promise.all([collect(ctx, projectId), decisionHistory(ctx, projectId)]);
  const seen: string[] = [];
  let created = 0;
  for (const c of cands) {
    const s = scoreOpportunity({ ...c.input, history: c.historyKey ? history.get(c.historyKey) : undefined });
    seen.push(c.fingerprint);
    const row = await ctx.db.one<{ inserted: boolean }>(
      `INSERT INTO opportunities(project_id, fingerprint, source, source_ref, category, title, summary, action, url, affected, impact, effort, confidence, business_value, risk, time_sensitivity, priority_score, factors, evidence, expected_outcome, data_sources, recommendation_ids, automatable)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (project_id, fingerprint) DO UPDATE SET source_ref = EXCLUDED.source_ref, category = EXCLUDED.category, title = EXCLUDED.title, summary = EXCLUDED.summary, action = EXCLUDED.action, url = EXCLUDED.url, affected = EXCLUDED.affected,
         impact = EXCLUDED.impact, effort = EXCLUDED.effort, confidence = EXCLUDED.confidence, business_value = EXCLUDED.business_value, risk = EXCLUDED.risk, time_sensitivity = EXCLUDED.time_sensitivity, priority_score = EXCLUDED.priority_score,
         factors = EXCLUDED.factors, evidence = EXCLUDED.evidence, expected_outcome = EXCLUDED.expected_outcome, data_sources = EXCLUDED.data_sources, recommendation_ids = EXCLUDED.recommendation_ids, automatable = EXCLUDED.automatable, last_seen_at = now(),
         status = CASE WHEN opportunities.status = 'done' THEN 'open' WHEN opportunities.status = 'snoozed' AND opportunities.snoozed_until < now() THEN 'open' ELSE opportunities.status END,
         resolved_at = CASE WHEN opportunities.status = 'done' THEN NULL ELSE opportunities.resolved_at END
       RETURNING (xmax = 0) AS inserted`,
      [projectId, c.fingerprint, c.source, c.sourceRef ?? null, s.category, c.title, c.summary, c.action, c.url ?? null, c.affected ?? 1, c.input.impact, c.input.effort, c.input.confidence, c.input.businessValue, c.input.risk, c.input.timeSensitivity, s.score, s.factors, c.evidence, c.expectedOutcome, c.dataSources, c.recommendationIds ?? [], !!c.automatable],
    );
    if (row?.inserted) created++;
  }
  // Whatever is no longer detected has been dealt with (issue fixed, gap filled, alert resolved).
  const closed = await ctx.db.query(`UPDATE opportunities SET status = 'done', resolved_at = now() WHERE project_id = $1 AND status IN ('open','in_progress') AND NOT (fingerprint = ANY($2::text[])) RETURNING id`, [projectId, seen]);
  return { candidates: cands.length, created, closed: closed.length };
}

export async function listOpportunities(ctx: AppContext, projectId: string, opts: { category?: string; status?: string; limit?: number } = {}) {
  return ctx.db.query(
    `SELECT * FROM opportunities WHERE project_id = $1 AND ($2::text IS NULL OR category = $2) AND status = ANY($3::text[]) ORDER BY priority_score DESC LIMIT $4`,
    [projectId, opts.category ?? null, opts.status === 'all' ? ['open', 'in_progress', 'done', 'dismissed', 'snoozed'] : [opts.status ?? 'open'], opts.limit ?? 200],
  );
}

export async function nextBestAction(ctx: AppContext, projectId: string) {
  const top = await ctx.db.one<any>(`SELECT * FROM opportunities WHERE project_id = $1 AND status = 'open' ORDER BY priority_score DESC LIMIT 1`, [projectId]);
  if (!top) return null;
  // Plain-language reasons from the strongest factors, followed by the concrete evidence.
  const WHY: Record<string, (v: number) => string> = {
    impact: () => 'High expected impact on visibility or traffic',
    businessValue: () => 'Core page for the business (home, service or key landing page)',
    confidence: () => `Strong evidence (${(top.data_sources as string[]).map((d) => d.replace(/_/g, ' ')).join(', ')})`,
    ease: () => 'Low implementation effort',
    timeSensitivity: () => 'Time-sensitive – losses or errors are happening now',
    safety: () => 'Low-risk change',
  };
  const strong = (top.factors as { name: string; value: number }[]).filter((f) => f.name !== 'memory' && f.value >= 0.6 && WHY[f.name]).sort((a, b) => b.value - a.value);
  const memory = (top.factors as { name: string; value: number; note: string }[]).find((f) => f.name === 'memory' && f.value !== 1);
  const reasons = [...(top.evidence as { label: string; value: string | number }[]).slice(0, 3).map((e) => `${e.label}: ${e.value}`), ...strong.slice(0, 3).map((f) => WHY[f.name]!(f.value)), ...(memory ? [memory.note] : [])];
  return { ...top, reasons, expectedOpportunity: top.priority_score >= 70 ? 'HIGH' : top.priority_score >= 50 ? 'MEDIUM' : 'LOW' };
}

export async function setOpportunityStatus(ctx: AppContext, projectId: string, id: string, status: 'open' | 'in_progress' | 'dismissed' | 'snoozed', snoozeDays?: number) {
  const r = await ctx.db.one(`UPDATE opportunities SET status = $3, snoozed_until = CASE WHEN $3 = 'snoozed' THEN now() + ($4 || ' days')::interval ELSE NULL END WHERE id = $1 AND project_id = $2 RETURNING id`, [id, projectId, status, String(snoozeDays ?? 14)]);
  if (!r) throw new AppError('Opportunity not found', 404, 'not_found');
  return { ok: true };
}
