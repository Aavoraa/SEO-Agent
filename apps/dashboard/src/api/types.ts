/* Response types for the Phoenixx SEO Agent API (apps/api/src/routes/*). */

export type Role = 'admin' | 'editor' | 'viewer';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Risk = 'low' | 'medium' | 'high' | 'critical';
export type Priority = 'critical' | 'high' | 'medium' | 'low';
/** Free-form JSON (evidence blobs, AI outputs). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
  is_active?: boolean;
  created_at?: string;
  last_login_at?: string | null;
  memberships?: ProjectMembership[];
}

export interface ProjectMembership {
  projectId: string;
  role: Role;
}

export interface ProjectMember {
  userId: string;
  email: string;
  name: string;
  isActive: boolean;
  role: Role;
  addedAt: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface MeResponse {
  actor: { type: string; id: string; label: string; role: Role | 'service' };
  user?: User;
  organizations?: import('./types-saas').OrgSummary[];
  product?: { name: string };
}

export interface AiInfo {
  provider: string;
  model: string;
  lightModel: string | null;
  monthlyBudgetUsd: number;
}

export interface SystemStatus {
  version: string;
  demoMode: boolean;
  needsSetup: boolean;
  database: string;
  ai: AiInfo;
  google: { serviceAccount: boolean; oauthClient: boolean; searchConsoleSiteUrl: string | null; ga4PropertyId: string | null };
  websiteAdapter: string;
  notifications: string[];
  siteUrl: string;
  productName?: string;
  signupEnabled?: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  is_demo: boolean;
  created_at: string;
  base_url: string | null;
  organization_id?: string | null;
  organization_name?: string | null;
  organization_branding?: { name?: string; logoUrl?: string; primaryColor?: string } | null;
}

export interface ServiceDef {
  id: string;
  name: string;
  path?: string;
  terms: string[];
}
export interface LocationDef {
  id: string;
  name: string;
  level: 'locality' | 'city' | 'region' | 'country';
  aliases: string[];
  target: boolean;
}
export interface Address {
  streetAddress: string;
  addressLocality: string;
  addressRegion: string;
  postalCode?: string;
  addressCountry: string;
}
export interface BusinessProfile {
  name: string;
  description: string;
  url: string;
  logoUrl?: string;
  phone?: string;
  email?: string;
  address?: Address;
  sameAs: string[];
  services: ServiceDef[];
  locations: LocationDef[];
  facts: string[];
  ctas: string[];
  languages: string[];
}

export interface RuleOverride {
  enabled?: boolean;
  severity?: Severity;
  params?: Record<string, number | string | boolean>;
}
export interface ProjectSettings {
  rules?: Record<string, RuleOverride>;
  alertMinSeverity?: Record<string, Severity>;
  crawl?: { maxPages?: number; checkExternalLinks?: boolean };
  ai?: { autoAnalyzeCrawl?: boolean; refineKeywordIntent?: boolean };
  thresholds?: { minImpressionsForLocationPage?: number; trafficDropPct?: number };
  searchConsoleSiteUrl?: string;
  ga4PropertyId?: string;
}

export interface Website {
  id: string;
  base_url: string;
  role: string;
  sitemap_url: string | null;
  is_primary: boolean;
  adapter_type: string;
}

export interface Project {
  id: string;
  name: string;
  slug: string;
  is_demo: boolean;
  settings: ProjectSettings;
  businessProfile: BusinessProfile;
  websites: Website[];
  created_at: string;
  /** The signed-in user's role in THIS project (platform admins: 'admin'). */
  myRole: Role | 'service';
}

export interface SetupStatus {
  projectId: string;
  isDemo: boolean;
  complete: boolean;
  steps: { id: string; label: string; done: boolean; detail?: string }[];
  integrations: { provider: string; status: string; last_sync_at: string | null; last_error: string | null }[];
  ai: AiInfo;
}

/* ── Analytics ── */
export interface Totals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  source?: string;
}
export interface Period {
  start: string;
  end: string;
  prevStart: string;
  prevEnd: string;
  current: Totals;
  previous: Totals;
}
export interface SeriesPoint {
  date: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
export interface ScoreFactor {
  name: string;
  note: string;
  value: number;
  weight: number;
}
export interface AiSummary {
  model: string;
  cached: boolean;
  summary: string;
  quickWins?: string[];
  watchouts?: string[];
  topPriorities?: { what: string; why: string; evidence: string; risk: Risk; effort: string; expectedPurpose: string }[];
}
export interface Overview {
  period: Period | null;
  health: {
    score: number | null;
    previous: number | null;
    crawledAt: string | null;
    grade: string | null;
    breakdown: { issues: number; category: string; deduction: number }[];
    disclaimer: string;
  } | null;
  kpis: { clicks: [number, number]; impressions: [number, number]; ctr: [number, number]; position: [number, number]; indexedPages: number };
  counts: { critical: number; high: number; open_issues: number; pending_approvals: number; pending_content: number; open_alerts: number };
  series: SeriesPoint[];
  rankingDistribution: { bucket: string; queries: number }[];
  topOpportunities: { id: string; title: string; type: string; priority: Priority; priority_score: number; page_url: string | null; status: string }[];
  alerts: { id: string; severity: Severity; title: string; created_at: string }[];
  aiSummary: AiSummary | null;
  hasSearchData: boolean;
}

export interface PeriodRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  prevClicks: number;
  prevImpressions: number;
  prevPosition: number | null;
  clicksChangePct: number | null;
  positionChange: number | null;
  trend: string;
  topPage: string | null;
  analytics?: { landing_page: string; sessions: number; users: number; engaged: number; conversions: number } | null;
}
export interface Performance {
  period: Period | null;
  topQueries: PeriodRow[];
  risingQueries: PeriodRow[];
  decliningQueries: PeriodRow[];
  topPages: PeriodRow[];
  decliningPages: PeriodRow[];
  analytics: {
    organic: { sessions: number; users: number; conversions: number; engaged: number } | null;
    channels: { channel_group: string; sessions: number }[];
    connected: boolean;
  } | null;
  windows: (Period & { days: number })[];
}

/* ── Issues ── */
export interface Issue {
  id: string;
  page_id: string | null;
  rule_id: string;
  category: string;
  severity: Severity;
  title: string;
  description: string | null;
  evidence: Json;
  recommendation: string | null;
  url: string | null;
  status: string;
  first_detected_at: string;
  last_detected_at: string;
  resolved_at: string | null;
  recommendation_id: string | null;
  recommendation_status: string | null;
  proposed_value: string | null;
  current_value: string | null;
  risk: Risk | null;
}
export interface IssuesResponse {
  items: Issue[];
  summary: { severity: Severity; category: string; n: number }[];
  rules: { id: string; title: string; category: string }[];
}

/* ── Pages ── */
export interface PageRow {
  id: string;
  url: string;
  path: string;
  page_type: string | null;
  is_important: boolean;
  status_code: number | null;
  title: string | null;
  meta_description: string | null;
  h1: string | null;
  word_count: number | null;
  indexable: boolean | null;
  in_sitemap: boolean;
  inlinks: number;
  last_seen_at: string | null;
  removed_at: string | null;
  open_issues: number;
  serious_issues: number;
  clicks: number | null;
  impressions: number | null;
  position: number | null;
}
export interface CrawlResult {
  id: string;
  url: string;
  final_url: string | null;
  status_code: number | null;
  response_time_ms: number | null;
  canonical: string | null;
  robots_meta: string | null;
  x_robots_tag: string | null;
  indexable: boolean | null;
  indexability_reason: string | null;
  title: string | null;
  meta_description: string | null;
  h1s: string[];
  h2s: string[];
  h3s: string[];
  word_count: number | null;
  images: { src: string; alt: string | null; hasAlt: boolean }[];
  structured_data: { raw?: string; types: string[]; valid: boolean; error?: string }[];
  open_graph: Record<string, string>;
  lang: string | null;
  depth: number | null;
  fetched_at: string;
}
export interface PageDetail {
  page: PageRow & { primary_keyword: string | null; first_seen_at: string };
  latest: CrawlResult | null;
  issues: Issue[];
  recommendations: Recommendation[];
  queries: { query: string; clicks: number; impressions: number; position: number }[];
  changes: Change[];
  history: { date: string; clicks: number; impressions: number }[];
  analytics: { sessions: number | null; engaged: number | null; conversions: number | null } | null;
}

/* ── Keywords ── */
export interface Keyword {
  id: string;
  keyword: string;
  intent: string | null;
  intent_confidence: number | null;
  keyword_type: string | null;
  services: string[];
  locations: string[];
  source: string;
  search_volume: number | null;
  search_volume_source: string | null;
  target_page_url: string | null;
  is_branded: boolean;
  user_problem: string | null;
  expected_content: string | null;
  recommended_page_type: string | null;
  recommended_cta: string | null;
  opportunity_score: number | null;
  opportunity_reasons: string[] | null;
  cluster_id: string | null;
  cluster_name: string | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  prev_clicks: number | null;
  prev_impressions: number | null;
  prev_position: number | null;
  trend: string | null;
  top_page: string | null;
}
export interface KeywordsResponse {
  items: Keyword[];
  total: number;
  filters: { services: { id: string; name: string }[]; locations: { id: string; name: string }[] };
  note: string;
}
export interface KeywordCluster {
  id: string;
  name: string;
  intent: string | null;
  strategy: string;
  recommended_page_type: string | null;
  target_page_url: string | null;
  rationale: string | null;
  services: string[];
  locations: string[];
  total_clicks: number;
  total_impressions: number;
  opportunity_score: number;
  cannibalization: { url: string; share: number; impressions: number }[] | null;
  ai_refined: boolean;
  keyword_count: number;
  top_keywords: string[] | null;
}

/* ── Content ── */
export interface ContentOpportunity {
  id: string;
  type: string;
  title: string;
  target_keyword: string | null;
  target_page_url: string | null;
  score: number;
  priority: Priority;
  score_breakdown: ScoreFactor[] | null;
  reasons: string[] | null;
  evidence: Json;
  status: string;
  created_at: string;
}
export interface Brief {
  targetKeyword?: string;
  searchIntent?: string;
  targetAudience?: string;
  suggestedTitle?: string;
  h1?: string;
  metaDescription?: string;
  outline?: { h2: string; h3s: string[]; notes: string }[];
  entities?: string[];
  faqs?: { question: string; answerGuidance: string }[];
  internalLinks?: { url: string; anchor: string; reason: string }[];
  cta?: string;
  schemaRecommendations?: string[];
  factsNeededFromBusiness?: string[];
  wordCountRange?: string;
  avoid?: string[];
}
export interface ContentBrief {
  id: string;
  target_keyword: string;
  status: string;
  created_at: string;
  ai_model: string | null;
  opportunity_id: string | null;
  brief: Brief;
}
export interface QualityCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}
export interface QualityReport {
  score: number;
  verdict: 'ready_for_review' | 'needs_revision' | 'reject';
  checks: QualityCheck[];
  metrics?: Record<string, number>;
  flaggedClaims?: string[];
  genericPhrases?: string[];
  placeholders?: number;
  ai?: Json;
}
export interface DraftRow {
  id: string;
  brief_id: string | null;
  title: string;
  slug: string | null;
  status: string;
  quality_score: number | null;
  verdict: string | null;
  version: number;
  created_at: string;
  ai_model: string | null;
}
export interface Draft extends DraftRow {
  body_markdown: string;
  meta: { metaDescription?: string; placeholders?: string[] } | null;
  quality_report: QualityReport | null;
}
export interface ContentResponse {
  opportunities: ContentOpportunity[];
  briefs: ContentBrief[];
  drafts: DraftRow[];
  needsRefresh: ContentOpportunity[];
  declining: ContentOpportunity[];
  published: DraftRow[];
}

/* ── Internal links ── */
export interface LinkOpportunity {
  id: string;
  source_url: string;
  target_url: string;
  anchor_text: string | null;
  reason: string | null;
  priority: Priority;
  score: number;
  similarity: number | null;
  status: string;
  recommendation_id: string | null;
}
export interface LinkPage {
  url: string;
  path: string;
  title: string | null;
  inlinks: number;
  is_important: boolean;
  indexable: boolean | null;
  page_type: string | null;
}
export interface InternalLinksResponse {
  opportunities: LinkOpportunity[];
  pages: LinkPage[];
  orphans: LinkPage[];
  weak: LinkPage[];
}

/* ── Local ── */
export interface MatrixCell {
  serviceId: string;
  serviceName: string;
  locationId: string;
  locationName: string;
  impressions: number;
  clicks: number;
  avgPosition: number | null;
  queries: string[];
  coveringPage: string | null;
  action: string;
  rationale: string;
  score: number;
}
export interface LocalResponse {
  nap: { name: string; address: Address | null; phone: string | null; email: string | null; phonesFoundOnSite: string[] };
  localSchema: { present: boolean; existing?: Json; suggested: Json; validation: { valid: boolean; errors: string[]; warnings: string[]; types: string[] } | null };
  matrix: MatrixCell[];
  issues: { id: string; rule_id: string; severity: Severity; title: string; description: string | null; url: string | null }[];
  targetLocations: string[];
  googleBusinessProfile: { status: string; note: string };
}

/* ── Competitors ── */
export interface Competitor {
  id: string;
  name: string;
  base_url: string;
  is_active: boolean;
  notes: string | null;
  max_pages: number;
  last_crawled_at: string | null;
  last_error: string | null;
  created_at: string;
  pages: number;
}
export interface ComparisonResponse {
  competitors: { name: string; baseUrl: string; pages: number; avgWords: number }[];
  phoenixx: { pages: number; avgWords: number };
  rows: { dimension: string; item: string; phoenixxHas: string; competitorsHave: { name: string; evidence: string }[]; opportunity: string; strength: number }[];
  note: string;
}

/* ── Recommendations & approvals ── */
export interface Recommendation {
  id: string;
  page_id: string | null;
  page_url: string | null;
  issue_id: string | null;
  source: string;
  type: string;
  title: string;
  what: string | null;
  why: string | null;
  evidence: { label: string; value: unknown }[] | Json;
  current_value: string | null;
  proposed_value: string | null;
  expected_purpose: string | null;
  risk: Risk;
  priority: Priority;
  priority_score: number;
  score_breakdown: { factors?: ScoreFactor[]; reasons?: string[] } | null;
  confidence: string | null;
  status: string;
  requires_approval: boolean;
  ai_generated: boolean;
  ai_model: string | null;
  created_at: string;
  updated_at: string;
}
export interface RecommendationsResponse {
  items: Recommendation[];
  counts: { status: string; n: number }[];
}
export interface Decision {
  id: string;
  recommendation_id: string | null;
  brief_id: string | null;
  draft_id: string | null;
  change_id: string | null;
  decision: string;
  reviewer_label: string | null;
  comment: string | null;
  edited_value: string | null;
  created_at: string;
  recommendation_title: string | null;
}
export interface ApprovalsResponse {
  recommendations: Recommendation[];
  briefs: { id: string; target_keyword: string; brief: Brief; created_at: string; ai_model: string | null }[];
  drafts: { id: string; title: string; quality_score: number | null; quality_report: QualityReport | null; created_at: string; ai_model: string | null }[];
  recentDecisions: Decision[];
  total: number;
}

/* ── Changes / experiments ── */
export interface Change {
  id: string;
  recommendation_id: string | null;
  page_url: string | null;
  change_type: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  ai_recommendation: Json;
  approval_status: string | null;
  status: string;
  adapter: string | null;
  implemented_at: string | null;
  verified_at: string | null;
  verification: Json;
  rolled_back_at: string | null;
  result: Json;
  created_at: string;
  updated_at: string;
  reviewer_email?: string | null;
  recommendation_title?: string | null;
}
export interface ChangeEvent {
  id: string;
  from_status: string | null;
  to_status: string;
  actor: string;
  note: string | null;
  created_at: string;
}
export interface Experiment {
  id: string;
  change_id: string | null;
  page_url: string | null;
  name: string;
  hypothesis: string | null;
  primary_metric: string;
  monitor_days: number;
  start_date: string | null;
  end_date: string | null;
  baseline: Record<string, number | boolean> | null;
  result: Record<string, number | boolean | string> | null;
  status: string;
  conclusion: string | null;
  created_at: string;
  change_type?: string | null;
  old_value?: string | null;
  new_value?: string | null;
}
export interface ChangeDetail extends Change {
  events: ChangeEvent[];
  experiment: Experiment | null;
}
export interface TimelineItem {
  kind: 'change' | 'traffic';
  at: string;
  title: string;
  detail: string | null;
  page: string | null;
  actor: string | null;
  changeId?: string;
  impact: string | null;
}

/* ── Alerts / reports / AI / audit / jobs ── */
export interface Alert {
  id: string;
  severity: Severity;
  type: string;
  title: string;
  message: string | null;
  evidence: Json;
  status: string;
  occurrences: number;
  notified: string[];
  created_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}
export interface ReportRow {
  id: string;
  type: string;
  title: string;
  period_start: string | null;
  period_end: string | null;
  summary: string | null;
  ai_generated: boolean;
  sent_to: string[] | null;
  created_at: string;
}
export interface AiUsage {
  ai: AiInfo;
  totals: { calls: number; cost: number; input_tokens: number; output_tokens: number; cache_hit_rate: number };
  monthToDate: { cost: number };
  byPrompt: { prompt_name: string; provider: string; model: string; calls: number; cache_hits: number; failures: number; input_tokens: number; output_tokens: number; cost: number }[];
  byDay: { day: string; calls: number; cost: number; tokens: number }[];
  recent: { created_at: string; prompt_name: string; model: string; input_tokens: number; output_tokens: number; cached: boolean; estimated_cost_usd: number; duration_ms: number; success: boolean; error: string | null }[];
  note: string;
}
export interface AuditLog {
  id: number;
  actor_type: string;
  actor_label: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  details: Json;
  ip: string | null;
  created_at: string;
}
export interface JobRunRow {
  id: string;
  job_type: string;
  status: 'running' | 'succeeded' | 'failed' | string;
  trigger: string;
  correlation_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  seconds: number | null;
}
export interface JobRun extends JobRunRow {
  input: Json;
  output: Json;
}
export interface JobType {
  type: string;
  description: string;
  timeoutMs: number;
}
export interface RuleInfo {
  id: string;
  category: string;
  title: string;
  rationale: string;
  scope: string;
  defaults: { enabled: boolean; severity: Severity; params: Record<string, number | string | boolean> };
  effective: { enabled: boolean; severity: Severity; params: Record<string, number | string | boolean> };
}
export interface ApiKeyRow {
  id: string;
  name: string;
  role: string;
  project_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

/* ── Migration ── */
export interface MigrationSnapshot {
  id: string;
  label: string;
  kind: 'baseline' | 'comparison';
  source_url: string;
  crawl_run_id: string | null;
  page_count: number;
  created_at: string;
}
export interface MigrationFinding {
  severity: Severity;
  type: string;
  path: string;
  before: string | null;
  after: string | null;
  message: string;
  clicks: number;
  impressions: number;
  suggestedRedirect?: { to: string; confidence: number; basis: string } | null;
}
export interface MigrationReportData {
  baseline: { id: string; label: string; url: string };
  comparison: { id: string; label: string; url: string };
  summary: { baselinePages: number; newPages: number; preserved: number; missing: number; redirected: number; atRiskClicks: number; atRiskImpressions: number; critical: number; high: number };
  findings: MigrationFinding[];
  redirectMap: { from: string; to: string; confidence: number; basis: string }[];
  apacheRules: string;
}
export interface MigrationResponse {
  snapshots: MigrationSnapshot[];
  reports: { id: string; title: string; summary: string | null; data: MigrationReportData; created_at: string }[];
}

/* ── Backlinks ── */
export type BacklinkStatus = 'unverified' | 'live' | 'lost' | 'error';
export interface Backlink {
  id: string;
  source_url: string;
  source_domain: string;
  target_url: string;
  anchor: string | null;
  nofollow: boolean | null;
  origin: 'import' | 'dataforseo' | 'manual' | 'demo';
  status: BacklinkStatus;
  first_seen_at: string;
  last_seen_at: string;
  last_checked_at: string | null;
  check_error: string | null;
  found_anchor: string | null;
  found_nofollow: boolean | null;
  lost_at: string | null;
  target_status: number | null;
  target_final_url: string | null;
}
export interface ReferringDomain {
  domain: string;
  links: number;
  live: number;
  lost: number;
  followed: number;
  first_seen_at: string;
}
export interface BrokenBacklinkTarget {
  target: string;
  status: number;
  links: number;
  domains: number;
}
export interface BacklinksResponse {
  summary: { backlinks: number; referringDomains: number; liveReferringDomains: number; live: number; lost: number; unverified: number; nofollow: number };
  provider: { name: string; configured: boolean };
  domains: ReferringDomain[];
  backlinks: Backlink[];
  brokenTargets: BrokenBacklinkTarget[];
  lastVerify: { status: string; finished_at: string | null; output: Record<string, unknown> | null } | null;
  note: string;
}
export interface BacklinkImportResult {
  inserted: number;
  updated: number;
  rows: number;
  skipped: number;
  skippedSample: { line: number; reason: string }[];
  columns: { source: string | null; target: string | null; anchor: string | null; nofollow: string | null };
}

/* ── Integrations & AI readiness ── */
export type DataLabelValue = 'verified' | 'estimated' | 'modeled' | 'unavailable' | 'demo';
export type IntegrationStatusValue = 'connected' | 'configured' | 'manual' | 'integration_required' | 'planned';
export interface CatalogEntry {
  id: string;
  name: string;
  category: string;
  status: IntegrationStatusValue;
  dataLabel: DataLabelValue;
  powers: string[];
  detail: string;
  setup: string;
  phase?: number;
}
export interface IntegrationCatalog {
  demo: boolean;
  entries: CatalogEntry[];
}
export interface AiCrawler {
  token: string;
  owner: string;
  product: string;
  purpose: 'search' | 'user' | 'training';
  allowed: boolean;
  matchedGroup: string | null;
}
export type AiReadiness =
  | { available: false; reason: string }
  | {
      available: true;
      crawledAt: string;
      dataLabel: DataLabelValue;
      crawlers: AiCrawler[];
      llmsTxt: { url: string; status: number | null; found: boolean; note: string };
      checks: { id: string; label: string; ok: boolean; detail: string }[];
      stack: { server: string | null; rendering: string; technologies: { name: string; category: string }[]; analytics: { ga4: string[]; gtm: string[] } };
      note: string;
    };

export * from './types-audit';
export * from './types-saas';
