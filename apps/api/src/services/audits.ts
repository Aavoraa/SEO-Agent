import { AUDIT_CATEGORIES, auditCategoryForRule, buildAuditScorecard, listRules, ruleFixMeta, type AnalyzeResult, type AuditCategoryId, type RuleOverrides } from '@phoenixx/seo-engine';
import { AppError, riskForType, SEVERITY_RANK, type CrawlOutput, type Severity } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { getProject, primaryWebsite } from './common.js';
import { demoSiteOrigin } from '../demo/site.js';

/** Mobile audits fetch pages as a smartphone browser would; the agent still identifies itself. */
export function mobileUserAgent(base: string) {
  return `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36 ${base}`;
}

export type AuditDevice = 'desktop' | 'mobile';

interface CompactPage {
  url: string;
  path: string;
  status: number | null;
  indexable: boolean;
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  canonical: string | null;
  wordCount: number;
  schemaTypes: string[];
  inlinks: number;
}

/** Stores an audit (scorecard + compact issue/page lists for comparison) for a completed crawl. */
export async function recordAudit(
  ctx: AppContext,
  input: { projectId: string; crawlRunId: string; device: AuditDevice; trigger: string; createdBy?: string | null; siteUrl: string; out: CrawlOutput; analysis: AnalyzeResult; overrides?: RuleOverrides },
) {
  const card = buildAuditScorecard({ pages: input.out.pages, site: input.out.site, issues: input.analysis.issues, overrides: input.overrides });
  const project = await getProject(ctx, input.projectId);
  const issues = input.analysis.issues.map((i) => ({ fingerprint: i.fingerprint, ruleId: i.ruleId, category: auditCategoryForRule(i.ruleId, i.category), severity: i.severity, url: i.url, title: i.title }));
  const pages: CompactPage[] = input.out.pages.map((p) => ({
    url: p.url,
    path: new URL(p.url).pathname,
    status: p.redirectChain.length ? p.redirectChain[0]!.status : p.statusCode,
    indexable: p.indexable,
    title: p.title,
    metaDescription: p.metaDescription,
    h1: p.h1s[0] ?? null,
    canonical: p.canonical,
    wordCount: p.wordCount,
    schemaTypes: [...new Set(p.structuredData.filter((s) => s.valid).flatMap((s) => s.types))],
    inlinks: input.analysis.inlinks.get(p.url)?.size ?? 0,
  }));
  const row = await ctx.db.one<{ id: string }>(
    `INSERT INTO seo_audits(project_id, crawl_run_id, device, trigger, site_url, overall_score, grade, categories, checks_total, checks_passed, issues_by_severity, pages_crawled, issues, pages, is_demo, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [input.projectId, input.crawlRunId, input.device, input.trigger, input.siteUrl, card.overall, card.grade, card.categories, card.checksTotal, card.checksPassed, card.issuesBySeverity, input.out.stats.pagesCrawled, issues, pages, project.is_demo, input.createdBy ?? null],
  );
  for (const c of card.checks) {
    await ctx.db.query(`INSERT INTO seo_audit_checks(audit_id, category, check_id, label, severity, evaluated, passed, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [row!.id, c.category, c.id, c.label, c.severity, c.evaluated, c.passed, c.detail ?? null]);
  }
  return { auditId: row!.id, overall: card.overall, grade: card.grade, checksTotal: card.checksTotal, checksPassed: card.checksPassed };
}

/* ───────────────────────── Recommendation groups & quick wins ───────────────────────── */

/** Change types the website deployment pipeline can apply to a page's HTML. */
export const DEPLOYABLE_TYPES = ['title', 'meta_description', 'h1', 'canonical', 'schema', 'other'];
/** Change types the AI can write copy for (others are fully determined by facts or need a human). */
export const AI_FIXABLE_TYPES = ['title', 'meta_description', 'h1'];

const PRIORITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export async function recommendationGroups(ctx: AppContext, projectId: string) {
  const issues = await ctx.db.query<any>(`SELECT id, rule_id, category, severity, title, description, evidence, recommendation, url FROM seo_issues WHERE project_id = $1 AND status = 'open'`, [projectId]);
  const recs = await ctx.db.query<any>(
    `SELECT id, issue_id, page_url, type, title, status, priority, priority_score, risk, confidence, current_value, proposed_value, expected_purpose, score_breakdown, ai_generated
     FROM recommendations WHERE project_id = $1 AND issue_id IS NOT NULL AND status IN ('recommended','pending_approval','approved','implemented')`,
    [projectId],
  );
  const recByIssue = new Map(recs.map((r) => [r.issue_id, r]));
  const rules = new Map(listRules().map((r) => [r.id, r]));
  const groups = new Map<string, any>();
  for (const i of issues) {
    const rule = rules.get(i.rule_id);
    const meta = ruleFixMeta(i.rule_id);
    const g =
      groups.get(i.rule_id) ??
      {
        ruleId: i.rule_id,
        title: rule?.title ?? i.title,
        rationale: rule?.rationale ?? null,
        category: auditCategoryForRule(i.rule_id, i.category) as AuditCategoryId,
        severity: i.severity as Severity,
        priority: null as string | null,
        impact: meta?.impact ?? null,
        effort: meta?.effort ?? null,
        changeType: meta?.type ?? null,
        risk: meta ? riskForType(meta.type) : null,
        confidence: null as string | null,
        businessValue: null as number | null,
        action: i.recommendation,
        expectedOutcome: meta?.purpose ?? null,
        pages: [] as any[],
      };
    if (SEVERITY_RANK[i.severity as Severity] > SEVERITY_RANK[g.severity as Severity]) g.severity = i.severity;
    const rec = recByIssue.get(i.id);
    if (rec) {
      if (!g.priority || PRIORITY_RANK[rec.priority]! > PRIORITY_RANK[g.priority]!) g.priority = rec.priority;
      g.confidence ??= rec.confidence;
      const bv = (rec.score_breakdown?.factors ?? []).find((f: any) => f.name === 'Business relevance')?.value;
      if (typeof bv === 'number') g.businessValue = Math.max(g.businessValue ?? 0, bv);
    }
    g.pages.push({
      issueId: i.id,
      url: i.url,
      found: i.description,
      evidence: i.evidence,
      recommendationId: rec?.id ?? null,
      recommendationStatus: rec?.status ?? null,
      currentValue: rec?.current_value ?? null,
      proposedValue: rec?.proposed_value ?? null,
      aiGenerated: rec?.ai_generated ?? false,
      risk: rec?.risk ?? null,
    });
    groups.set(i.rule_id, g);
  }
  const list = [...groups.values()].map((g) => ({
    ...g,
    affected: g.pages.filter((p: any) => p.url).length || 1,
    canFixWithAi: ctx.ai.enabled && AI_FIXABLE_TYPES.includes(g.changeType ?? ''),
    deployable: DEPLOYABLE_TYPES.includes(g.changeType ?? ''),
  }));
  list.sort((a, b) => SEVERITY_RANK[b.severity as Severity] - SEVERITY_RANK[a.severity as Severity] || (PRIORITY_RANK[b.priority ?? 'low'] ?? 0) - (PRIORITY_RANK[a.priority ?? 'low'] ?? 0) || b.affected - a.affected);
  return list;
}

/** Low-effort fixes with real impact, ordered by impact × pages affected. */
export function quickWinsFrom(groups: Awaited<ReturnType<typeof recommendationGroups>>) {
  return groups
    .filter((g) => g.effort !== null && g.effort <= 1 && (g.impact ?? 0) >= 1.5 && g.severity !== 'info' && g.risk !== 'high')
    .map((g) => ({ ...g, winScore: (g.impact ?? 0) * Math.log2(1 + g.affected) }))
    .sort((a, b) => b.winScore - a.winScore)
    .slice(0, 8);
}

/* ───────────────────────── Report, history, comparison ───────────────────────── */

export async function auditHistory(ctx: AppContext, projectId: string, device?: AuditDevice, limit = 30) {
  return ctx.db.query(
    `SELECT id, created_at, device, trigger, overall_score, grade, checks_total, checks_passed, issues_by_severity, pages_crawled, is_demo FROM seo_audits
     WHERE project_id = $1 AND ($2::text IS NULL OR device = $2) ORDER BY created_at DESC LIMIT $3`,
    [projectId, device ?? null, limit],
  );
}

export async function auditReport(ctx: AppContext, projectId: string, opts: { auditId?: string; device?: AuditDevice } = {}) {
  const project = await getProject(ctx, projectId);
  const site = await primaryWebsite(ctx, projectId);
  const device = opts.device ?? 'desktop';
  const audit = opts.auditId
    ? await ctx.db.one<any>('SELECT * FROM seo_audits WHERE id = $1 AND project_id = $2', [opts.auditId, projectId])
    : await ctx.db.one<any>('SELECT * FROM seo_audits WHERE project_id = $1 AND device = $2 ORDER BY created_at DESC LIMIT 1', [projectId, device]);
  if (opts.auditId && !audit) throw new AppError('Audit not found', 404, 'not_found');
  const base = { project: { id: project.id, name: project.name, siteUrl: site.base_url, isDemo: project.is_demo }, device, history: await auditHistory(ctx, projectId, device) };
  if (!audit) return { ...base, audit: null };
  const previous = await ctx.db.one<any>('SELECT id, created_at, overall_score, categories FROM seo_audits WHERE project_id = $1 AND device = $2 AND created_at < $3 ORDER BY created_at DESC LIMIT 1', [projectId, audit.device, audit.created_at]);
  const prevCat = new Map<string, number | null>((previous?.categories ?? []).map((c: any) => [c.id, c.score]));
  const checks = await ctx.db.query('SELECT category, check_id AS id, label, severity, evaluated, passed, detail FROM seo_audit_checks WHERE audit_id = $1 ORDER BY category, severity', [audit.id]);
  const groups = await recommendationGroups(ctx, projectId);
  const crawl = audit.crawl_run_id ? await ctx.db.one<any>('SELECT site_checks FROM crawl_runs WHERE id = $1', [audit.crawl_run_id]) : null;
  const profile = crawl?.site_checks?.profile ?? null;
  const baseline = await ctx.db.one<any>(`SELECT id, label, created_at, page_count FROM migration_snapshots WHERE project_id = $1 AND kind = 'baseline' ORDER BY created_at DESC LIMIT 1`, [projectId]);
  const lastCompare = await ctx.db.one<any>(`SELECT id, title, summary, created_at FROM reports WHERE project_id = $1 AND type = 'migration' ORDER BY created_at DESC LIMIT 1`, [projectId]);
  const changeCounts = await ctx.db.one<any>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('verified','monitoring','completed'))::int AS verified, COUNT(*) FILTER (WHERE status IN ('approved','deploying'))::int AS awaiting, COUNT(*) FILTER (WHERE status IN ('failed','verification_failed'))::int AS failing, COUNT(*) FILTER (WHERE status = 'rolled_back')::int AS rolled_back FROM seo_changes WHERE project_id = $1`,
    [projectId],
  );
  return {
    ...base,
    dataLabel: project.is_demo ? 'demo' : 'verified',
    audit: {
      id: audit.id,
      createdAt: audit.created_at,
      device: audit.device,
      trigger: audit.trigger,
      siteUrl: audit.site_url,
      overall: audit.overall_score,
      grade: audit.grade,
      checksTotal: audit.checks_total,
      checksPassed: audit.checks_passed,
      issuesBySeverity: audit.issues_by_severity,
      pagesCrawled: audit.pages_crawled,
      isDemo: audit.is_demo,
      createdBy: audit.created_by,
    },
    previous: previous ? { id: previous.id, createdAt: previous.created_at, overall: previous.overall_score, delta: audit.overall_score - previous.overall_score } : null,
    categories: (audit.categories as any[]).map((c) => ({ ...c, trend: prevCat.has(c.id) && c.score !== null && prevCat.get(c.id) !== null ? c.score - (prevCat.get(c.id) as number) : null })),
    checks,
    recommendations: groups,
    quickWins: quickWinsFrom(groups),
    preview: project.is_demo && ctx.cfg.DEMO_MODE
      ? { url: `${demoSiteOrigin(ctx)}/`, embeddable: true, reason: null, demo: true }
      : { url: audit.site_url, embeddable: profile?.embeddable ?? null, reason: profile?.embeddable === false ? 'The site forbids being shown in a frame (X-Frame-Options / CSP).' : null, demo: false },
    siteProfile: profile ? { server: profile.server, rendering: profile.rendering, technologies: profile.technologies, securityHeaders: profile.securityHeaders ?? null, aiCrawlers: profile.aiCrawlers, llmsTxt: profile.llmsTxt } : null,
    protection: { baseline, lastComparison: lastCompare, changes: changeCounts },
  };
}

const PAGE_FIELDS: (keyof CompactPage)[] = ['status', 'indexable', 'title', 'metaDescription', 'h1', 'canonical'];

export async function compareAudits(ctx: AppContext, projectId: string, fromId: string, toId: string) {
  const [a, b] = await Promise.all([ctx.db.one<any>('SELECT * FROM seo_audits WHERE id = $1 AND project_id = $2', [fromId, projectId]), ctx.db.one<any>('SELECT * FROM seo_audits WHERE id = $1 AND project_id = $2', [toId, projectId])]);
  if (!a || !b) throw new AppError('Audit not found', 404, 'not_found');
  const aIss = new Map<string, any>((a.issues as any[]).map((i) => [i.fingerprint, i]));
  const bIss = new Map<string, any>((b.issues as any[]).map((i) => [i.fingerprint, i]));
  const newIssues = [...bIss.values()].filter((i) => !aIss.has(i.fingerprint));
  const resolvedIssues = [...aIss.values()].filter((i) => !bIss.has(i.fingerprint));
  const aPages = new Map<string, CompactPage>((a.pages as CompactPage[]).map((p) => [p.path, p]));
  const bPages = new Map<string, CompactPage>((b.pages as CompactPage[]).map((p) => [p.path, p]));
  const pageChanges: { path: string; field: string; before: unknown; after: unknown }[] = [];
  for (const [path, pb] of bPages) {
    const pa = aPages.get(path);
    if (!pa) continue;
    for (const f of PAGE_FIELDS) if ((pa[f] ?? null) !== (pb[f] ?? null)) pageChanges.push({ path, field: f, before: pa[f], after: pb[f] });
    if (Math.abs(pb.wordCount - pa.wordCount) >= Math.max(50, pa.wordCount * 0.2)) pageChanges.push({ path, field: 'wordCount', before: pa.wordCount, after: pb.wordCount });
    if (pa.schemaTypes.join(',') !== pb.schemaTypes.join(',')) pageChanges.push({ path, field: 'schemaTypes', before: pa.schemaTypes.join(', '), after: pb.schemaTypes.join(', ') });
  }
  const catA = new Map<string, any>((a.categories as any[]).map((c) => [c.id, c]));
  const byCategory = (list: any[]) => Object.fromEntries(AUDIT_CATEGORIES.map((c) => [c.id, list.filter((i) => i.category === c.id).length]));
  return {
    from: { id: a.id, createdAt: a.created_at, overall: a.overall_score, device: a.device },
    to: { id: b.id, createdAt: b.created_at, overall: b.overall_score, device: b.device },
    scoreDelta: b.overall_score - a.overall_score,
    categories: (b.categories as any[]).map((c) => ({ id: c.id, label: c.label, before: catA.get(c.id)?.score ?? null, after: c.score, delta: c.score !== null && catA.get(c.id)?.score != null ? c.score - catA.get(c.id).score : null })),
    newIssues,
    resolvedIssues,
    newIssuesByCategory: byCategory(newIssues),
    resolvedIssuesByCategory: byCategory(resolvedIssues),
    newPages: [...bPages.keys()].filter((p) => !aPages.has(p)),
    removedPages: [...aPages.keys()].filter((p) => !bPages.has(p)),
    pageChanges,
  };
}
