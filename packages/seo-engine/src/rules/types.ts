import type { BusinessProfile, CrawledPage, IssueCategory, Severity, SiteChecks } from '@phoenixx/shared';

export interface RuleConfig {
  enabled: boolean;
  severity: Severity;
  params: Record<string, number | string | boolean>;
}

export interface RuleDefinition {
  id: string;
  category: IssueCategory;
  title: string;
  /** Why it matters – shown to non-specialists. */
  rationale: string;
  defaults: RuleConfig;
  /** 'page' rules run per crawled page; 'site' rules run once. */
  scope: 'page' | 'site';
  check: (ctx: RuleContext, cfg: RuleConfig, page?: CrawledPage) => IssueDraft[];
}

export interface IssueDraft {
  url: string | null;
  title: string;
  description: string;
  recommendation: string;
  evidence: Record<string, unknown>;
  /** Extra discriminator when a rule can fire multiple times per URL. */
  key?: string;
  /** Rule may escalate/de-escalate severity based on context. */
  severityOverride?: Severity;
}

export interface RuleContext {
  pages: CrawledPage[];
  site: SiteChecks;
  profile: BusinessProfile;
  byUrl: Map<string, CrawledPage>;
  /** url → set of internal source URLs linking to it (only from 2xx HTML pages). */
  inlinks: Map<string, Set<string>>;
  /** Paths flagged as business-critical (service pages, home). */
  importantPaths: Set<string>;
  externalLinkStatus: Record<string, number | null>;
}

export interface DetectedIssue extends IssueDraft {
  ruleId: string;
  category: IssueCategory;
  severity: Severity;
  fingerprint: string;
}

export const isHtmlOk = (p: CrawledPage) => p.statusCode !== null && p.statusCode >= 200 && p.statusCode < 300 && !p.redirectChain.length && /html/i.test(p.contentType ?? '');
export const pathOf = (url: string) => {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return url;
  }
};
