/* ── Multi-tenant SaaS: organizations, plans, opportunities, command center, onboarding ── */

export type OrgRole = 'owner' | 'admin' | 'manager' | 'seo_specialist' | 'content_editor' | 'developer' | 'viewer' | 'client';
export const ORG_ROLE_LABEL: Record<OrgRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  seo_specialist: 'SEO specialist',
  content_editor: 'Content editor',
  developer: 'Developer',
  viewer: 'Viewer',
  client: 'Client',
};

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  planId: string;
  isDemo: boolean;
  branding: { name?: string; logoUrl?: string; primaryColor?: string; reportFooter?: string };
}

export interface PlanLimits {
  projects: number | null;
  pagesPerCrawl: number | null;
  users: number | null;
  competitorsPerProject: number | null;
  aiBudgetUsdMonthly: number | null;
  auditsPerMonth: number | null;
  automationLevelMax: number;
  webhooks: number | null;
}

export interface UsageSummary {
  plan: { id: string; name: string };
  features: Record<string, boolean>;
  items: { key: string; label: string; used: number; limit: number | null }[];
  limits: PlanLimits;
}

export interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  branding: OrgSummary['branding'];
  billingStatus: string;
  isDemo: boolean;
  entitlements: { planId: string; planName: string; limits: PlanLimits; features: Record<string, boolean> };
  projects: { id: string; name: string; is_demo: boolean; base_url: string | null }[];
  usage: UsageSummary | null;
}

export interface OrgMember {
  userId: string;
  email: string;
  name: string;
  isActive: boolean;
  role: OrgRole;
  addedAt: string;
}

export interface OrgInvitation {
  id: string;
  email: string;
  role: OrgRole;
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface WebhookEndpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  failures: number;
  last_delivery_at: string | null;
  created_at: string;
}

export interface WebhookDelivery {
  id: number;
  endpoint_id: string;
  event: string;
  status_code: number | null;
  success: boolean;
  error: string | null;
  duration_ms: number | null;
  created_at: string;
}

export type OpportunityCategory = 'quick_win' | 'high_impact' | 'strategic' | 'at_risk' | 'competitive' | 'ai_search' | 'emerging';
export const OPPORTUNITY_CATEGORY_LABEL: Record<OpportunityCategory, string> = {
  quick_win: 'Quick win',
  high_impact: 'High impact',
  strategic: 'Strategic',
  at_risk: 'At risk',
  competitive: 'Competitive',
  ai_search: 'AI search',
  emerging: 'Emerging',
};

export interface OpportunityFactor {
  name: string;
  value: number;
  weight: number;
  contribution: number;
  note: string;
}

export interface Opportunity {
  id: string;
  fingerprint: string;
  source: string;
  source_ref: string | null;
  category: OpportunityCategory;
  title: string;
  summary: string;
  action: string;
  url: string | null;
  affected: number;
  impact: number;
  effort: number;
  confidence: number;
  business_value: number;
  risk: number;
  time_sensitivity: number;
  priority_score: number;
  factors: OpportunityFactor[];
  evidence: { label: string; value: string | number }[];
  expected_outcome: string | null;
  data_sources: string[];
  recommendation_ids: string[];
  automatable: boolean;
  status: 'open' | 'in_progress' | 'done' | 'dismissed' | 'snoozed';
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export interface NextBestAction extends Opportunity {
  reasons: string[];
  expectedOpportunity: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface CcMetric {
  key: string;
  label: string;
  value: number | null;
  previous: number | null;
  unit: string;
  source: string;
  updatedAt: string | null;
  dataLabel: 'verified' | 'modeled' | 'unavailable' | 'demo';
  note?: string;
  href?: string;
}

export interface CommandCenterData {
  project: { id: string; name: string; isDemo: boolean; automationLevel: number };
  metrics: CcMetric[];
  nextBestAction: NextBestAction | null;
  opportunities: Opportunity[];
  categoryCounts: Partial<Record<OpportunityCategory, number>>;
  loop: { opportunities: number; awaiting_decision: number; approved: number; deployed: number; verified: number; measured: number; resolved: number };
}

export interface ConnectionOption {
  method: string;
  label: string;
  available: boolean;
  reason: string;
  handles: ('content' | 'code')[];
}

export interface Detection {
  url: string;
  status: number | null;
  https: boolean;
  title: string | null;
  cms: string | null;
  framework: string | null;
  rendering: string;
  renderingNote: string;
  server: string | null;
  cdn: string[];
  seoPlugins: string[];
  analytics: { ga4: string[]; gtm: string[] };
  technologies: { name: string; category: string }[];
  robots: { found: boolean; sitemaps: string[]; blocksAll: boolean };
  sitemap: { url: string; found: boolean };
  schemaTypes: string[];
  language: string | null;
  recommendedConnection: ConnectionOption;
  connectionOptions: ConnectionOption[];
  hostingNote: string;
}

export interface OnboardingStatus {
  steps: { id: string; label: string; done: boolean; optional?: boolean; href?: string }[];
  detection: Detection | null;
  complete: boolean;
}

export interface AutomationSettings {
  level: 0 | 1 | 2 | 3 | 4;
  allowedMediumTypes: string[];
  dailyLimit: number;
}

export interface SearchResults {
  query: string;
  groups: { type: string; label: string; items: { id: string; title: string; subtitle: string; href: string }[] }[];
}

export interface AdminOverview {
  totals: { organizations: number; users: number; projects: number; failed_jobs_24h: number; running_jobs: number; crawls_24h: number; deployment_failures_7d: number; ai_cost_month: number; failed_logins_24h: number };
  orgs: { id: string; name: string; slug: string; plan_id: string; billing_status: string; status: string; is_internal: boolean; is_demo: boolean; created_at: string; projects: number; users: number; ai_cost_month: number; pages_crawled_month: number }[];
  failedJobs: { id: string; job_type: string; error: string | null; created_at: string; project: string | null }[];
  securityEvents: { action: string; actor_label: string | null; ip: string | null; created_at: string }[];
  flags: { key: string; state: string; org_ids: string[]; description: string | null; updated_at: string }[];
  plans: string[];
}
