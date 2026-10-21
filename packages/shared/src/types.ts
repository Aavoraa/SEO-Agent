/** Domain vocabulary shared by every package. Keep these string unions in sync with database CHECK constraints. */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_RANK: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export const ISSUE_CATEGORIES = ['technical', 'content', 'internal_linking', 'local', 'schema', 'performance'] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

export const INTENTS = ['informational', 'commercial', 'transactional', 'navigational', 'local'] as const;
export type Intent = (typeof INTENTS)[number];

export const KEYWORD_TYPES = ['primary', 'secondary', 'long_tail', 'local', 'question', 'commercial'] as const;
export type KeywordType = (typeof KEYWORD_TYPES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Lifecycle shared by recommendations and seo_changes. */
export const CHANGE_STATUSES = [
  'detected',
  'analyzed',
  'recommended',
  'pending_approval',
  'approved',
  'rejected',
  'implemented',
  'verified',
  'monitoring',
  'completed',
  'rolled_back',
  'failed',
] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const RECOMMENDATION_TYPES = [
  'title',
  'meta_description',
  'h1',
  'headings',
  'content',
  'faq',
  'schema',
  'internal_link',
  'alt_text',
  'canonical',
  'redirect',
  'robots',
  'noindex',
  'sitemap',
  'new_page',
  'cta',
  'technical',
  'other',
] as const;
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];

/**
 * Change types that can alter indexing, URLs, templates or server behaviour. They require an explicit
 * admin approval after viewing the preview and are never auto-implemented.
 */
export const HIGH_RISK_TYPES: RecommendationType[] = ['canonical', 'redirect', 'robots', 'noindex', 'sitemap', 'new_page', 'technical'];

/** Rewrites of visible content and heading structure. */
export const MEDIUM_RISK_TYPES: RecommendationType[] = ['h1', 'headings', 'content', 'faq', 'cta'];

/**
 * Deployment safety levels:
 *  low      – metadata/additive (title, meta description, ALT, schema, internal links): one-click approval
 *  medium   – visible content & heading structure: explicit approval
 *  high     – URLs, redirects, canonicals, robots, sitemap, templates/server: explicit admin approval + preview
 *  critical – deleting files, auth, database, DNS, server config: never executed by the platform
 */
export function riskForType(type: RecommendationType): RiskLevel {
  if (HIGH_RISK_TYPES.includes(type)) return 'high';
  if (MEDIUM_RISK_TYPES.includes(type)) return 'medium';
  return 'low';
}

export interface RiskPolicy {
  /** Approve + deploy in one action. */
  oneClick: boolean;
  /** Minimum reviewer role. */
  approver: 'editor' | 'admin' | null;
  /** The reviewer must have opened the before/after preview. */
  requiresPreview: boolean;
  /** The platform may execute it at all. */
  executable: boolean;
}

export function riskPolicy(risk: RiskLevel): RiskPolicy {
  switch (risk) {
    case 'low':
      return { oneClick: true, approver: 'editor', requiresPreview: false, executable: true };
    case 'medium':
      return { oneClick: false, approver: 'editor', requiresPreview: false, executable: true };
    case 'high':
      return { oneClick: false, approver: 'admin', requiresPreview: true, executable: true };
    default:
      return { oneClick: false, approver: null, requiresPreview: true, executable: false };
  }
}

export const ROLES = ['admin', 'editor', 'viewer', 'service'] as const;
export type Role = (typeof ROLES)[number];

export interface ScoreFactor {
  name: string;
  /** 0..5 */
  value: number;
  weight: number;
  note: string;
}

export interface ScoredPriority {
  priority: Priority;
  score: number;
  factors: ScoreFactor[];
  reasons: string[];
}

export interface Evidence {
  label: string;
  value: string | number | null;
}

/**
 * Provenance of every number shown to a user. Nothing without a label reaches the UI:
 * verified = first-party API (GSC, GA4, our crawler) · estimated = third-party provider ·
 * modeled = our own calculation from labelled inputs · unavailable = provider not configured ·
 * demo = sample data in demo mode.
 */
export const DATA_LABELS = ['verified', 'estimated', 'modeled', 'unavailable', 'demo'] as const;
export type DataLabel = (typeof DATA_LABELS)[number];

export const INTEGRATION_STATUSES = ['connected', 'configured', 'manual', 'integration_required', 'planned'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
