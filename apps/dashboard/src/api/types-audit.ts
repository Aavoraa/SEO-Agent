/* ── SEO audit, change requests & deployments ── */
import type { AiCrawler, DataLabelValue, Severity } from './types';

export type AuditCategoryId = 'technical' | 'onpage' | 'content' | 'performance' | 'links' | 'local' | 'ai_search' | 'usability' | 'security' | 'structured_data';

export interface AuditCategory {
  id: AuditCategoryId;
  label: string;
  score: number | null;
  status: 'good' | 'fair' | 'needs_work' | 'poor' | 'not_measured';
  checks: number;
  passed: number;
  issues: Record<Severity, number>;
  coverage: 'full' | 'partial';
  note?: string;
  trend: number | null;
}

export interface AuditCheckRow {
  category: AuditCategoryId;
  id: string;
  label: string;
  severity: Severity;
  evaluated: number;
  passed: number;
  detail: string | null;
}

export interface AuditGroupPage {
  issueId: string;
  url: string | null;
  found: string;
  evidence: Record<string, unknown>;
  recommendationId: string | null;
  recommendationStatus: string | null;
  currentValue: string | null;
  proposedValue: string | null;
  aiGenerated: boolean;
  risk: string | null;
}

export interface AuditGroup {
  ruleId: string;
  title: string;
  rationale: string | null;
  category: AuditCategoryId;
  severity: Severity;
  priority: string | null;
  impact: number | null;
  effort: number | null;
  changeType: string | null;
  risk: string | null;
  confidence: string | null;
  businessValue: number | null;
  action: string | null;
  expectedOutcome: string | null;
  pages: AuditGroupPage[];
  affected: number;
  canFixWithAi: boolean;
  deployable: boolean;
}

export interface AuditSummary {
  id: string;
  createdAt: string;
  device: 'desktop' | 'mobile';
  trigger: string;
  siteUrl: string;
  overall: number;
  grade: 'good' | 'fair' | 'needs_work' | 'poor';
  checksTotal: number;
  checksPassed: number;
  issuesBySeverity: Record<Severity, number>;
  pagesCrawled: number;
  isDemo: boolean;
  createdBy: string | null;
}

export interface AuditHistoryRow {
  id: string;
  created_at: string;
  device: 'desktop' | 'mobile';
  trigger: string;
  overall_score: number;
  grade: string;
  checks_total: number;
  checks_passed: number;
  issues_by_severity: Record<Severity, number>;
  pages_crawled: number;
  is_demo: boolean;
}

export interface AuditReport {
  project: { id: string; name: string; siteUrl: string; isDemo: boolean };
  device: 'desktop' | 'mobile';
  history: AuditHistoryRow[];
  audit: AuditSummary | null;
  dataLabel?: DataLabelValue;
  previous?: { id: string; createdAt: string; overall: number; delta: number } | null;
  categories?: AuditCategory[];
  checks?: AuditCheckRow[];
  recommendations?: AuditGroup[];
  quickWins?: AuditGroup[];
  preview?: { url: string; embeddable: boolean | null; reason: string | null; demo: boolean };
  siteProfile?: {
    server: string | null;
    rendering: string;
    technologies: { name: string; category: string }[];
    securityHeaders: Record<string, string | null> | null;
    aiCrawlers: AiCrawler[];
    llmsTxt: { found: boolean; status: number | null };
  } | null;
  protection?: {
    baseline: { id: string; label: string; created_at: string; page_count: number } | null;
    lastComparison: { id: string; title: string; summary: string | null; created_at: string } | null;
    changes: { verified: number; awaiting: number; failing: number; rolled_back: number };
  };
}

export interface AuditIssueRef {
  fingerprint: string;
  ruleId: string;
  category: string;
  severity: Severity;
  url: string | null;
  title: string;
}

export interface AuditComparison {
  from: { id: string; createdAt: string; overall: number; device: string };
  to: { id: string; createdAt: string; overall: number; device: string };
  scoreDelta: number;
  categories: { id: string; label: string; before: number | null; after: number | null; delta: number | null }[];
  newIssues: AuditIssueRef[];
  resolvedIssues: AuditIssueRef[];
  newIssuesByCategory: Record<string, number>;
  resolvedIssuesByCategory: Record<string, number>;
  newPages: string[];
  removedPages: string[];
  pageChanges: { path: string; field: string; before: unknown; after: unknown }[];
}

export interface AiExplanation {
  explanation: { whyItMatters: string; observed: string[]; inferred: string[]; expectedImpact: string; caveats: string[] };
  evidence: string[];
  model: string;
  cached: boolean;
  disclaimer: string;
}

export interface FieldCheck {
  field: string;
  kind: 'changed' | 'unchanged' | 'http';
  expected: string | number | boolean | null;
  actual: string | number | boolean | null;
  passed: boolean;
}

export interface PreviewResult {
  provider: string;
  mode: string;
  file: string | null;
  current: string | null;
  proposed: string | null;
  fileDiff: { before: string; after: string; line: number }[];
  checks: FieldCheck[];
  ok: boolean;
  message: string;
}

export interface DeploymentStep {
  step: string;
  status: 'done' | 'failed' | 'skipped';
  message: string;
  at: string;
}

export interface DeploymentRow {
  id: string;
  change_id: string;
  action: 'deploy' | 'rollback';
  provider: string;
  mode: 'demo' | 'live' | 'dry_run';
  status: string;
  steps: DeploymentStep[];
  target: string | null;
  verification_status: string | null;
  error_message: string | null;
  rollback_available: boolean;
  restored_automatically: boolean;
  created_by: string | null;
  deployment_started_at: string;
  deployment_completed_at: string | null;
  page_url: string;
  change_type: string;
}

export interface DeploymentDetail extends DeploymentRow {
  old_value: string | null;
  new_value: string | null;
  verifications: { id: string; url: string; http_status: number | null; passed: boolean; checks: FieldCheck[]; error: string | null; created_at: string }[];
  snapshots: { id: string; kind: string; target: string; original_checksum: string | null; new_checksum: string | null; original_bytes: number | null; new_bytes: number | null; created_at: string }[];
  fileDiff: { before: string; after: string; line: number }[];
}

export type ChangeRequestStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DEPLOYING' | 'DEPLOYED' | 'VERIFIED' | 'FAILED' | 'VERIFICATION_FAILED' | 'ROLLED_BACK';

export interface ChangeRequest {
  id: string;
  kind: 'recommendation' | 'change';
  changeId: string | null;
  recommendationId: string | null;
  title: string | null;
  page: string | null;
  changeType: string;
  oldValue: string | null;
  newValue: string | null;
  aiReason: string | null;
  confidence: string | null;
  risk: string | null;
  status: ChangeRequestStatus;
  rawStatus: string;
  createdBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  deployedAt: string | null;
  verifiedAt: string | null;
  deployment: { id: string; status: string; verification_status: string | null; rollback_available: boolean; restored_automatically: boolean; provider: string; mode: string; deployment_completed_at: string | null } | null;
  verificationStatus: string | null;
  rollback: { id?: string; status: string; deployment_completed_at: string | null } | null;
  rollbackAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentSettings {
  provider: string;
  mode: 'demo' | 'live';
  fileBased: boolean;
  configured: boolean;
  connected: boolean;
  missing: string[];
  description: string;
  source: 'demo' | 'project' | 'env';
  verifyBaseUrl: string;
  liveEnabled: boolean;
  liveEnabledBy: string | null;
  liveEnabledAt: string | null;
  lastTest: { status: string; at: string | null; error: string | null } | null;
  connection: {
    provider?: string;
    host?: string;
    port?: number;
    username?: string;
    remoteRoot?: string;
    secure?: string;
    tlsServername?: string;
    hostFingerprint?: string;
    verifyBaseUrl?: string;
    allowInsecure?: boolean;
    rejectUnauthorized?: boolean;
    hasPassword: boolean;
    hasPrivateKey: boolean;
  };
  envProvider: string;
  deployableChangeTypes: string[];
}

export interface ConnectionTestResult {
  ok: boolean;
  provider: string;
  message: string;
  steps: { step: string; ok: boolean; detail: string }[];
  fingerprint?: string | null;
}
