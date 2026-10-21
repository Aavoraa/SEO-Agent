-- SaaS foundation: organizations (tenants), org roles, invitations, plans/usage, feature flags,
-- webhooks and the persistent Opportunity Engine.
--
-- Tenancy: organization → members → projects → websites → data. Every project belongs to exactly one
-- organization. Access = platform admin | org membership (role mapped to a project role) | explicit
-- project membership (overrides the org role for that project, e.g. clients limited to one site).

CREATE TABLE organizations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  slug           text NOT NULL UNIQUE,
  plan_id        text NOT NULL DEFAULT 'starter',
  plan_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,     -- per-org limit/feature overrides (sales deals, trials)
  billing_status text NOT NULL DEFAULT 'trialing' CHECK (billing_status IN ('trialing','active','past_due','canceled','internal')),
  branding       jsonb NOT NULL DEFAULT '{}'::jsonb,     -- white-label: name, logoUrl, primaryColor, reportFooter
  is_internal    boolean NOT NULL DEFAULT false,
  is_demo        boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('owner','admin','manager','seo_specialist','content_editor','developer','viewer','client')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX organization_members_user_idx ON organization_members(user_id);

CREATE TABLE organization_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email           text NOT NULL,
  role            text NOT NULL,
  token_hash      text NOT NULL UNIQUE,
  invited_by      text,
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE projects ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
CREATE INDEX projects_org_idx ON projects(organization_id);
ALTER TABLE api_keys ADD COLUMN organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE;
ALTER TABLE audit_logs ADD COLUMN organization_id uuid;

-- Existing installs: real projects move into an internal organization, the demo project into a demo one.
INSERT INTO organizations(name, slug, plan_id, billing_status, is_internal) SELECT 'Internal', 'internal', 'internal', 'internal', true WHERE EXISTS (SELECT 1 FROM projects WHERE NOT is_demo);
INSERT INTO organizations(name, slug, plan_id, billing_status, is_demo) SELECT 'Demo Organization', 'demo', 'agency', 'internal', true WHERE EXISTS (SELECT 1 FROM projects WHERE is_demo);
UPDATE projects SET organization_id = (SELECT id FROM organizations WHERE slug = 'internal') WHERE NOT is_demo AND organization_id IS NULL;
UPDATE projects SET organization_id = (SELECT id FROM organizations WHERE slug = 'demo') WHERE is_demo AND organization_id IS NULL;
INSERT INTO organization_members(organization_id, user_id, role)
  SELECT o.id, u.id, 'owner' FROM organizations o CROSS JOIN users u WHERE u.role = 'admin' AND o.slug IN ('internal','demo')
  ON CONFLICT DO NOTHING;

-- ── Usage metering (plans are enforced from this + live counts) ──
CREATE TABLE usage_events (
  id              bigserial PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id      uuid REFERENCES projects(id) ON DELETE SET NULL,
  metric          text NOT NULL,          -- pages_crawled, audits, deployments, automation_runs, ai_cost_usd, webhooks_delivered
  quantity        double precision NOT NULL DEFAULT 1,
  meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_org_metric_idx ON usage_events(organization_id, metric, created_at DESC);

-- ── Feature flags ──
CREATE TABLE feature_flags (
  key          text PRIMARY KEY,
  state        text NOT NULL DEFAULT 'disabled' CHECK (state IN ('disabled','internal','beta','orgs','public')),
  org_ids      uuid[] NOT NULL DEFAULT '{}',
  description  text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- ── Outbound webhooks (per organization, HMAC-signed) ──
CREATE TABLE webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  url              text NOT NULL,
  secret_encrypted text NOT NULL,
  events           text[] NOT NULL DEFAULT '{}',
  active           boolean NOT NULL DEFAULT true,
  failures         integer NOT NULL DEFAULT 0,
  last_delivery_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
  id           bigserial PRIMARY KEY,
  endpoint_id  uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event        text NOT NULL,
  status_code  integer,
  success      boolean NOT NULL,
  error        text,
  duration_ms  integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries(endpoint_id, created_at DESC);

-- ── Opportunity Engine (every issue/opportunity source lands here with a documented score) ──
CREATE TABLE opportunities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  fingerprint       text NOT NULL,
  source            text NOT NULL,        -- audit | keyword | content | internal_link | backlink | local | deployment | alert
  source_ref        text,
  category          text NOT NULL,        -- quick_win | high_impact | strategic | at_risk | competitive | ai_search | emerging
  title             text NOT NULL,
  summary           text NOT NULL,
  action            text NOT NULL,
  url               text,
  affected          integer NOT NULL DEFAULT 1,
  impact            double precision NOT NULL,   -- 0..1
  effort            double precision NOT NULL,   -- 0..1 (1 = large project)
  confidence        double precision NOT NULL,   -- 0..1
  business_value    double precision NOT NULL,   -- 0..1
  risk              double precision NOT NULL,   -- 0..1
  time_sensitivity  double precision NOT NULL,   -- 0..1
  priority_score    double precision NOT NULL,   -- 0..100 (formula in packages/seo-engine/src/opportunity.ts)
  factors           jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence          jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_outcome  text,
  data_sources      text[] NOT NULL DEFAULT '{}',
  recommendation_ids uuid[] NOT NULL DEFAULT '{}',
  automatable       boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','dismissed','snoozed')),
  snoozed_until     timestamptz,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX opportunities_project_idx ON opportunities(project_id, status, priority_score DESC);
