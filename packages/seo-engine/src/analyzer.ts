import { DEFAULT_BUSINESS_PROFILE, sha256, SEVERITY_RANK, type BusinessProfile, type CrawledPage, type Severity, type SiteChecks } from '@phoenixx/shared';
import { technicalRules } from './rules/technical.js';
import { contentRules } from './rules/content.js';
import { linkingRules, schemaRules, localRules } from './rules/linking-schema-local.js';
import { isHtmlOk, pathOf, type DetectedIssue, type RuleConfig, type RuleContext, type RuleDefinition } from './rules/types.js';

export const ALL_RULES: RuleDefinition[] = [...technicalRules, ...contentRules, ...linkingRules, ...schemaRules, ...localRules];

export type RuleOverrides = Record<string, Partial<RuleConfig> & { params?: Record<string, number | string | boolean> }>;

/** Effective config = defaults ⊕ project overrides (Settings → SEO rules). */
export function resolveRuleConfig(rule: RuleDefinition, overrides: RuleOverrides = {}): RuleConfig {
  const o = overrides[rule.id] ?? {};
  return { enabled: o.enabled ?? rule.defaults.enabled, severity: o.severity ?? rule.defaults.severity, params: { ...rule.defaults.params, ...(o.params ?? {}) } };
}

export function listRules(overrides: RuleOverrides = {}) {
  return ALL_RULES.map((r) => ({ id: r.id, category: r.category, title: r.title, rationale: r.rationale, scope: r.scope, defaults: r.defaults, effective: resolveRuleConfig(r, overrides) }));
}

export interface AnalyzeInput {
  pages: CrawledPage[];
  site: SiteChecks;
  profile?: BusinessProfile;
  overrides?: RuleOverrides;
  externalLinkStatus?: Record<string, number | null>;
  /** Extra important paths (e.g. top GSC landing pages). Service pages from the profile are always important. */
  importantPaths?: string[];
}

export interface AnalyzeResult {
  issues: DetectedIssue[];
  inlinks: Map<string, Set<string>>;
  healthScore: HealthScore;
  pageTypes: Map<string, string>;
}

export function buildInlinks(pages: CrawledPage[]): Map<string, Set<string>> {
  const byFinal = new Map<string, string>();
  for (const p of pages) byFinal.set(p.url, p.finalUrl);
  const inlinks = new Map<string, Set<string>>();
  for (const p of pages) {
    if (!isHtmlOk(p)) continue;
    for (const l of p.internalLinks) {
      if (l.href === p.url || l.href === p.finalUrl) continue;
      // Credit the resolved target too, so links to redirecting URLs still count for the destination.
      for (const target of new Set([l.href, byFinal.get(l.href) ?? l.href])) {
        (inlinks.get(target) ?? inlinks.set(target, new Set()).get(target)!).add(p.url);
      }
    }
  }
  return inlinks;
}

export function classifyPageType(url: string, profile: BusinessProfile): string {
  const path = pathOf(url);
  if (path === '/') return 'home';
  if (profile.services.some((s) => s.path && s.path === path)) return 'service';
  if (/faq/i.test(path)) return 'faq';
  if (/privacy|terms|cookie|disclaimer/i.test(path)) return 'legal';
  if (/contact/i.test(path)) return 'contact';
  if (/about/i.test(path)) return 'about';
  if (/blog|news|insights|article|resources/i.test(path)) return 'article';
  if (/case-stud|portfolio|work/i.test(path)) return 'case_study';
  if (profile.locations.some((l) => l.aliases.some((a) => path.toLowerCase().includes(a.replace(/\s+/g, '-'))))) return 'location';
  return 'other';
}

export function analyzeSite(input: AnalyzeInput): AnalyzeResult {
  const profile = input.profile ?? DEFAULT_BUSINESS_PROFILE;
  const byUrl = new Map(input.pages.map((p) => [p.url, p]));
  const inlinks = buildInlinks(input.pages);
  const importantPaths = new Set<string>(['/', ...profile.services.filter((s) => s.path).map((s) => s.path!), ...(input.importantPaths ?? [])]);
  const ctx: RuleContext = { pages: input.pages, site: input.site, profile, byUrl, inlinks, importantPaths, externalLinkStatus: input.externalLinkStatus ?? {} };
  const issues: DetectedIssue[] = [];
  for (const rule of ALL_RULES) {
    const cfg = resolveRuleConfig(rule, input.overrides);
    if (!cfg.enabled) continue;
    const drafts = rule.scope === 'site' ? rule.check(ctx, cfg) : input.pages.flatMap((p) => rule.check(ctx, cfg, p));
    for (const d of drafts) {
      const severity: Severity = d.severityOverride && SEVERITY_RANK[d.severityOverride] > SEVERITY_RANK[cfg.severity] ? d.severityOverride : cfg.severity;
      issues.push({ ...d, ruleId: rule.id, category: rule.category, severity, fingerprint: sha256(`${rule.id}|${d.url ?? ''}|${d.key ?? ''}`).slice(0, 40) });
    }
  }
  issues.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const pageTypes = new Map(input.pages.map((p) => [p.url, classifyPageType(p.finalUrl, profile)]));
  return { issues, inlinks, healthScore: computeHealthScore(issues, input.pages), pageTypes };
}

/* ───────────── Health score ───────────── */

export interface HealthScore {
  score: number;
  grade: 'good' | 'needs_work' | 'poor';
  breakdown: { category: string; deduction: number; issues: number }[];
  disclaimer: string;
}

const WEIGHT: Record<Severity, { per: number; cap: number }> = {
  critical: { per: 20, cap: 40 },
  high: { per: 4, cap: 10 },
  medium: { per: 1.5, cap: 5 },
  low: { per: 0.25, cap: 1.5 },
  info: { per: 0, cap: 0 },
};

/**
 * Internal diagnostic score (0–100). It is NOT a Google metric and does not predict rankings.
 * Deductions are capped per rule so one widespread low-severity issue cannot dominate.
 */
export function computeHealthScore(issues: DetectedIssue[], pages: CrawledPage[]): HealthScore {
  const byRule = new Map<string, DetectedIssue[]>();
  for (const i of issues) byRule.set(i.ruleId, [...(byRule.get(i.ruleId) ?? []), i]);
  const catDeduction = new Map<string, { deduction: number; issues: number }>();
  let total = 0;
  void pages;
  for (const [, list] of byRule) {
    const sev = list.reduce<Severity>((m, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[m] ? i.severity : m), 'info');
    const w = WEIGHT[sev];
    // Deduction = weight × occurrences, capped per rule.
    const d = Math.min(w.cap, w.per * list.length);
    total += d;
    const cat = list[0]!.category;
    const c = catDeduction.get(cat) ?? { deduction: 0, issues: 0 };
    c.deduction += d;
    c.issues += list.length;
    catDeduction.set(cat, c);
  }
  const score = Math.max(0, Math.min(100, Math.round(100 - total)));
  return {
    score,
    grade: score >= 80 ? 'good' : score >= 55 ? 'needs_work' : 'poor',
    breakdown: [...catDeduction.entries()].map(([category, v]) => ({ category, deduction: Math.round(v.deduction * 10) / 10, issues: v.issues })).sort((a, b) => b.deduction - a.deduction),
    disclaimer: 'Internal diagnostic score based on the issues this tool detected. It is not a Google metric and does not predict rankings.',
  };
}
