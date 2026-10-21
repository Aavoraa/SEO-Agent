import { existsSync, readFileSync } from 'node:fs';

/**
 * Plan configuration. Plans define measurable limits and feature switches only – prices live in the
 * billing provider, never in code. Override or add plans without a release via PLANS_FILE (JSON with
 * the same shape); per-organization deals go in organizations.plan_overrides.
 * `null` = unlimited.
 */
export interface PlanLimits {
  projects: number | null;
  pagesPerCrawl: number | null;
  users: number | null;
  competitorsPerProject: number | null;
  aiBudgetUsdMonthly: number | null;
  auditsPerMonth: number | null;
  automationLevelMax: 0 | 1 | 2 | 3 | 4;
  webhooks: number | null;
}

export interface PlanFeatures {
  liveDeployment: boolean;
  autopilot: boolean;
  webhooks: boolean;
  apiAccess: boolean;
  whiteLabel: boolean;
  clientPortal: boolean;
  mobileAudits: boolean;
  pdfReports: boolean;
  backlinkProvider: boolean;
}

export interface PlanDefinition {
  name: string;
  limits: PlanLimits;
  features: PlanFeatures;
}

export type FeatureKey = keyof PlanFeatures;
export type LimitKey = keyof PlanLimits;

const all = (v: boolean): PlanFeatures => ({ liveDeployment: v, autopilot: v, webhooks: v, apiAccess: v, whiteLabel: v, clientPortal: v, mobileAudits: v, pdfReports: v, backlinkProvider: v });

export const DEFAULT_PLANS: Record<string, PlanDefinition> = {
  starter: {
    name: 'Starter',
    limits: { projects: 1, pagesPerCrawl: 500, users: 2, competitorsPerProject: 3, aiBudgetUsdMonthly: 5, auditsPerMonth: 30, automationLevelMax: 2, webhooks: 0 },
    features: { ...all(false), liveDeployment: true, mobileAudits: true, pdfReports: true },
  },
  growth: {
    name: 'Growth',
    limits: { projects: 5, pagesPerCrawl: 5_000, users: 10, competitorsPerProject: 5, aiBudgetUsdMonthly: 40, auditsPerMonth: 300, automationLevelMax: 3, webhooks: 5 },
    features: { ...all(true), whiteLabel: false, clientPortal: false },
  },
  agency: {
    name: 'Agency',
    limits: { projects: 50, pagesPerCrawl: 20_000, users: 50, competitorsPerProject: 10, aiBudgetUsdMonthly: 250, auditsPerMonth: 3_000, automationLevelMax: 4, webhooks: 20 },
    features: all(true),
  },
  enterprise: {
    name: 'Enterprise',
    limits: { projects: null, pagesPerCrawl: 100_000, users: null, competitorsPerProject: 25, aiBudgetUsdMonthly: null, auditsPerMonth: null, automationLevelMax: 4, webhooks: null },
    features: all(true),
  },
  internal: {
    name: 'Internal',
    limits: { projects: null, pagesPerCrawl: null, users: null, competitorsPerProject: null, aiBudgetUsdMonthly: null, auditsPerMonth: null, automationLevelMax: 4, webhooks: null },
    features: all(true),
  },
};

let cache: Record<string, PlanDefinition> | null = null;

export function loadPlans(file = process.env.PLANS_FILE): Record<string, PlanDefinition> {
  if (cache) return cache;
  let extra: Record<string, PlanDefinition> = {};
  if (file && existsSync(file)) extra = JSON.parse(readFileSync(file, 'utf8'));
  cache = { ...DEFAULT_PLANS, ...extra };
  return cache;
}

export interface Entitlements {
  planId: string;
  planName: string;
  limits: PlanLimits;
  features: PlanFeatures;
}

/** Plan + per-organization overrides ({ limits: {...}, features: {...} }). Unknown plans fall back to starter. */
export function resolveEntitlements(planId: string, overrides: { limits?: Partial<PlanLimits>; features?: Partial<PlanFeatures> } = {}): Entitlements {
  const plans = loadPlans();
  const plan = plans[planId] ?? plans.starter!;
  return { planId: plans[planId] ? planId : 'starter', planName: plan.name, limits: { ...plan.limits, ...(overrides.limits ?? {}) }, features: { ...plan.features, ...(overrides.features ?? {}) } };
}

/** Organization roles → the project role they grant on every project of the organization. */
export const ORG_ROLES = ['owner', 'admin', 'manager', 'seo_specialist', 'content_editor', 'developer', 'viewer', 'client'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const ORG_ROLE_TO_PROJECT_ROLE: Record<OrgRole, 'admin' | 'editor' | 'viewer'> = {
  owner: 'admin',
  admin: 'admin',
  manager: 'admin',
  seo_specialist: 'editor',
  content_editor: 'editor',
  developer: 'editor',
  viewer: 'viewer',
  client: 'viewer',
};

/** Organization-level permissions (project-level actions keep using the mapped project role). */
export const ORG_PERMISSIONS = {
  'org.update': ['owner', 'admin'],
  'members.manage': ['owner', 'admin'],
  'billing.manage': ['owner'],
  'projects.create': ['owner', 'admin', 'manager'],
  'projects.delete': ['owner', 'admin'],
  'webhooks.manage': ['owner', 'admin', 'developer'],
  'apikeys.manage': ['owner', 'admin', 'developer'],
  'usage.view': ['owner', 'admin', 'manager'],
} as const satisfies Record<string, readonly OrgRole[]>;
export type OrgPermission = keyof typeof ORG_PERMISSIONS;

export function orgCan(role: OrgRole | null | undefined, permission: OrgPermission): boolean {
  return !!role && (ORG_PERMISSIONS[permission] as readonly string[]).includes(role);
}
