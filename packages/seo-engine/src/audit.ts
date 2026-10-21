import type { CrawledPage, Severity, SiteChecks } from '@phoenixx/shared';
import { listRules, type RuleOverrides } from './analyzer.js';
import { isHtmlOk, type DetectedIssue } from './rules/types.js';

/**
 * SEO audit scorecard. Every score is derived from pass/fail checks on the crawl:
 *  - each rule is one check per page it applies to (or one per site),
 *  - site-level checks (security headers, AI readiness) are added from the crawl's site profile,
 *  - a category score is the severity-weighted share of passed checks,
 *  - the overall score is the weighted mean of the categories that have checks.
 * Nothing is estimated; categories we can't measure yet say so (coverage: 'partial').
 */

export const AUDIT_CATEGORIES = [
  { id: 'technical', label: 'Technical SEO', weight: 20 },
  { id: 'onpage', label: 'On-Page SEO', weight: 15 },
  { id: 'content', label: 'Content', weight: 12 },
  { id: 'performance', label: 'Performance', weight: 8 },
  { id: 'links', label: 'Links', weight: 10 },
  { id: 'local', label: 'Local SEO', weight: 6 },
  { id: 'ai_search', label: 'AI Search', weight: 7 },
  { id: 'usability', label: 'Usability', weight: 7 },
  { id: 'security', label: 'Security', weight: 7 },
  { id: 'structured_data', label: 'Structured Data', weight: 8 },
] as const;
export type AuditCategoryId = (typeof AUDIT_CATEGORIES)[number]['id'];

/** Rule → audit category (rules not listed fall back by their engine category). */
const RULE_CATEGORY: Record<string, AuditCategoryId> = {
  missing_title: 'onpage',
  title_length: 'onpage',
  duplicate_title: 'onpage',
  missing_meta_description: 'onpage',
  meta_description_length: 'onpage',
  duplicate_meta_description: 'onpage',
  missing_h1: 'onpage',
  multiple_h1: 'onpage',
  heading_hierarchy: 'onpage',
  missing_social_meta: 'onpage',
  images_missing_alt: 'onpage',
  duplicate_meta_tags: 'onpage',
  thin_content: 'content',
  duplicate_content: 'content',
  unverified_claims: 'content',
  hotlinked_stock_images: 'content',
  encoding_errors: 'usability',
  missing_viewport: 'usability',
  missing_lang: 'usability',
  https_not_enforced: 'security',
  mixed_content: 'security',
  broken_internal_link: 'links',
  broken_external_link: 'links',
  internal_link_to_redirect: 'links',
  ai_search_crawlers_blocked: 'ai_search',
};
const ENGINE_FALLBACK: Record<string, AuditCategoryId> = { technical: 'technical', content: 'content', internal_linking: 'links', schema: 'structured_data', local: 'local', performance: 'performance' };

/** Rules evaluated on every crawled URL (errors, redirects) rather than only on HTML pages. */
const ALL_URL_RULES = new Set(['http_error', 'redirect_chain', 'redirect_loop', 'robots_blocks_sitemap_url', 'sitemap_bad_url']);

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 10, high: 6, medium: 3, low: 1, info: 0.3 };

export function auditCategoryForRule(ruleId: string, engineCategory: string): AuditCategoryId {
  return RULE_CATEGORY[ruleId] ?? ENGINE_FALLBACK[engineCategory] ?? 'technical';
}

export interface AuditCheck {
  id: string;
  category: AuditCategoryId;
  label: string;
  severity: Severity;
  evaluated: number;
  passed: number;
  detail?: string;
  source: 'rule' | 'site';
}

export interface AuditCategoryScore {
  id: AuditCategoryId;
  label: string;
  /** null when nothing in this category could be checked. */
  score: number | null;
  status: 'good' | 'fair' | 'needs_work' | 'poor' | 'not_measured';
  checks: number;
  passed: number;
  issues: Record<Severity, number>;
  coverage: 'full' | 'partial';
  note?: string;
}

export interface AuditScorecard {
  overall: number;
  grade: 'good' | 'fair' | 'needs_work' | 'poor';
  checksTotal: number;
  checksPassed: number;
  issuesBySeverity: Record<Severity, number>;
  categories: AuditCategoryScore[];
  checks: AuditCheck[];
}

const grade = (s: number): AuditScorecard['grade'] => (s >= 85 ? 'good' : s >= 70 ? 'fair' : s >= 50 ? 'needs_work' : 'poor');
const emptySev = (): Record<Severity, number> => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });

/** AI-search readiness checks from the crawl (shared by the audit and the AI Readiness page). */
export function aiReadinessChecks(pages: CrawledPage[], site: SiteChecks): AuditCheck[] {
  const html = pages.filter((p) => isHtmlOk(p) && p.indexable);
  if (!html.length) return [];
  const types = new Set(html.flatMap((p) => p.structuredData.filter((s) => s.valid).flatMap((s) => s.types)));
  const oneH1 = html.filter((p) => p.h1s.length === 1).length;
  const deep = html.filter((p) => p.wordCount >= 300).length;
  const checks: AuditCheck[] = [
    { id: 'ai_entity_schema', category: 'ai_search', label: 'Organization / LocalBusiness schema identifies the business', severity: 'medium', evaluated: 1, passed: [...types].some((t) => /Organization|LocalBusiness|ProfessionalService/.test(t)) ? 1 : 0, detail: [...types].join(', ') || 'no valid JSON-LD', source: 'site' },
    { id: 'ai_question_content', category: 'ai_search', label: 'Question-and-answer content (FAQPage)', severity: 'low', evaluated: 1, passed: types.has('FAQPage') ? 1 : 0, source: 'site' },
    { id: 'ai_clear_headings', category: 'ai_search', label: 'Pages with exactly one H1', severity: 'medium', evaluated: html.length, passed: oneH1, source: 'site' },
    { id: 'ai_substantive_pages', category: 'ai_search', label: 'Pages with 300+ words', severity: 'low', evaluated: html.length, passed: deep, source: 'site' },
  ];
  if (site.profile) checks.unshift({ id: 'ai_content_in_html', category: 'ai_search', label: 'Content is in the HTML (no JavaScript needed)', severity: 'high', evaluated: 1, passed: site.profile.rendering === 'client-side' ? 0 : 1, detail: site.profile.renderingNote, source: 'site' });
  return checks;
}

export function securityChecks(site: SiteChecks): AuditCheck[] {
  const h = site.profile?.securityHeaders;
  if (!h) return [];
  const has = (v: string | null) => (v ? 1 : 0);
  return [
    { id: 'sec_hsts', category: 'security', label: 'HTTP Strict-Transport-Security header', severity: 'medium', evaluated: 1, passed: has(h.hsts), detail: h.hsts ?? 'missing', source: 'site' },
    { id: 'sec_nosniff', category: 'security', label: 'X-Content-Type-Options: nosniff', severity: 'low', evaluated: 1, passed: h.contentTypeOptions && /nosniff/i.test(h.contentTypeOptions) ? 1 : 0, detail: h.contentTypeOptions ?? 'missing', source: 'site' },
    { id: 'sec_clickjacking', category: 'security', label: 'Clickjacking protection (X-Frame-Options or CSP frame-ancestors)', severity: 'low', evaluated: 1, passed: h.frameOptions || /frame-ancestors/i.test(h.csp ?? '') ? 1 : 0, detail: h.frameOptions ?? 'missing', source: 'site' },
    { id: 'sec_csp', category: 'security', label: 'Content-Security-Policy header', severity: 'low', evaluated: 1, passed: has(h.csp), source: 'site' },
    { id: 'sec_referrer', category: 'security', label: 'Referrer-Policy header', severity: 'info', evaluated: 1, passed: has(h.referrerPolicy), source: 'site' },
  ];
}

export function buildAuditScorecard(input: { pages: CrawledPage[]; site: SiteChecks; issues: DetectedIssue[]; overrides?: RuleOverrides }): AuditScorecard {
  const htmlPages = input.pages.filter(isHtmlOk).length;
  const allPages = input.pages.length;
  const byRule = new Map<string, DetectedIssue[]>();
  for (const i of input.issues) byRule.set(i.ruleId, [...(byRule.get(i.ruleId) ?? []), i]);

  const checks: AuditCheck[] = [];
  for (const r of listRules(input.overrides)) {
    if (!r.effective.enabled) continue;
    const found = byRule.get(r.id) ?? [];
    const category = auditCategoryForRule(r.id, r.category);
    let evaluated: number;
    let failed: number;
    if (r.scope === 'site') {
      evaluated = 1;
      failed = found.length ? 1 : 0;
    } else {
      evaluated = ALL_URL_RULES.has(r.id) ? allPages : htmlPages;
      failed = Math.min(evaluated, new Set(found.map((i) => i.url ?? '')).size);
    }
    if (!evaluated) continue;
    checks.push({ id: r.id, category, label: r.title, severity: r.effective.severity, evaluated, passed: evaluated - failed, source: 'rule' });
  }
  checks.push(...securityChecks(input.site), ...aiReadinessChecks(input.pages, input.site));

  const categories: AuditCategoryScore[] = AUDIT_CATEGORIES.map((c) => {
    const list = checks.filter((k) => k.category === c.id);
    const issues = emptySev();
    for (const i of input.issues) if (auditCategoryForRule(i.ruleId, i.category) === c.id) issues[i.severity]++;
    const total = list.reduce((s, k) => s + SEVERITY_WEIGHT[k.severity] * k.evaluated, 0);
    const got = list.reduce((s, k) => s + SEVERITY_WEIGHT[k.severity] * k.passed, 0);
    const score = total ? Math.round((got / total) * 100) : null;
    const partial = c.id === 'performance' || (c.id === 'security' && !input.site.profile?.securityHeaders) || (c.id === 'ai_search' && !input.site.profile);
    return {
      id: c.id,
      label: c.label,
      score,
      status: score === null ? 'not_measured' : grade(score),
      checks: list.reduce((s, k) => s + k.evaluated, 0),
      passed: list.reduce((s, k) => s + k.passed, 0),
      issues,
      coverage: partial ? 'partial' : 'full',
      note:
        c.id === 'performance'
          ? 'Server response time and page weight only. Core Web Vitals need the PageSpeed Insights integration.'
          : c.id === 'ai_search'
            ? 'Readiness (access and structure). Actual AI mentions/citations need the AI answer-engine integration.'
            : partial
              ? 'Re-run the audit to collect the missing site checks.'
              : undefined,
    };
  });
  const scored = categories.filter((c) => c.score !== null);
  const weightSum = scored.reduce((s, c) => s + AUDIT_CATEGORIES.find((x) => x.id === c.id)!.weight, 0);
  const overall = weightSum ? Math.round(scored.reduce((s, c) => s + c.score! * AUDIT_CATEGORIES.find((x) => x.id === c.id)!.weight, 0) / weightSum) : 0;
  const issuesBySeverity = emptySev();
  for (const i of input.issues) issuesBySeverity[i.severity]++;
  return { overall, grade: grade(overall), checksTotal: checks.reduce((s, k) => s + k.evaluated, 0), checksPassed: checks.reduce((s, k) => s + k.passed, 0), issuesBySeverity, categories, checks };
}
