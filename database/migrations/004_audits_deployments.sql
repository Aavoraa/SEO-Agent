-- SEO audits (history + per-check results) and the website deployment pipeline
-- (backups, verification, rollback) for approved changes.

-- ── Audit history ──
CREATE TABLE seo_audits (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  crawl_run_id       uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
  device             text NOT NULL DEFAULT 'desktop' CHECK (device IN ('desktop','mobile')),
  trigger            text NOT NULL DEFAULT 'manual',
  site_url           text NOT NULL,
  overall_score      integer NOT NULL,
  grade              text NOT NULL,
  categories         jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id, label, score, checks, passed, issues:{critical..info}, coverage}]
  checks_total       integer NOT NULL DEFAULT 0,
  checks_passed      integer NOT NULL DEFAULT 0,
  issues_by_severity jsonb NOT NULL DEFAULT '{}'::jsonb,
  pages_crawled      integer NOT NULL DEFAULT 0,
  issues             jsonb NOT NULL DEFAULT '[]'::jsonb,   -- compact: fingerprint, ruleId, category, severity, url, title
  pages              jsonb NOT NULL DEFAULT '[]'::jsonb,   -- compact page facts for audit comparison
  is_demo            boolean NOT NULL DEFAULT false,
  created_by         text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seo_audits_project_idx ON seo_audits(project_id, created_at DESC);

CREATE TABLE seo_audit_checks (
  id         bigserial PRIMARY KEY,
  audit_id   uuid NOT NULL REFERENCES seo_audits(id) ON DELETE CASCADE,
  category   text NOT NULL,
  check_id   text NOT NULL,
  label      text NOT NULL,
  severity   text NOT NULL,
  evaluated  integer NOT NULL,
  passed     integer NOT NULL,
  detail     text
);
CREATE INDEX seo_audit_checks_audit_idx ON seo_audit_checks(audit_id);

-- ── Risk levels: add CRITICAL (never executable) ──
ALTER TABLE recommendations DROP CONSTRAINT recommendations_risk_check;
ALTER TABLE recommendations ADD CONSTRAINT recommendations_risk_check CHECK (risk IN ('low','medium','high','critical'));

-- ── Change requests: risk/confidence copied at approval, deployment timestamps ──
ALTER TABLE seo_changes ADD COLUMN risk text;
ALTER TABLE seo_changes ADD COLUMN confidence text;
ALTER TABLE seo_changes ADD COLUMN approved_at timestamptz;
ALTER TABLE seo_changes ADD COLUMN deployed_at timestamptz;
UPDATE seo_changes c SET risk = r.risk, confidence = r.confidence, approved_at = c.created_at FROM recommendations r WHERE r.id = c.recommendation_id;

-- ── Deployments (one row per deploy or rollback attempt) ──
CREATE TABLE website_deployments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  change_id               uuid NOT NULL REFERENCES seo_changes(id) ON DELETE CASCADE,
  action                  text NOT NULL DEFAULT 'deploy' CHECK (action IN ('deploy','rollback')),
  provider                text NOT NULL,
  mode                    text NOT NULL CHECK (mode IN ('demo','live','dry_run')),
  status                  text NOT NULL DEFAULT 'running' CHECK (status IN ('running','deployed','verified','verification_failed','failed','restored','awaiting_publish','exported')),
  steps                   jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{step, status, message, at}]
  target                  text,
  verification_status     text CHECK (verification_status IN ('pending','passed','failed','skipped')),
  error_message           text,
  rollback_available      boolean NOT NULL DEFAULT false,
  restored_automatically  boolean NOT NULL DEFAULT false,
  created_by              text,
  deployment_started_at   timestamptz NOT NULL DEFAULT now(),
  deployment_completed_at timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX website_deployments_change_idx ON website_deployments(change_id, created_at DESC);
CREATE INDEX website_deployments_project_idx ON website_deployments(project_id, created_at DESC);

-- Backup taken BEFORE a file/value is changed; used for automatic restore and rollback.
CREATE TABLE deployment_snapshots (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id     uuid NOT NULL REFERENCES website_deployments(id) ON DELETE CASCADE,
  change_id         uuid NOT NULL REFERENCES seo_changes(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('file','value')),
  target            text NOT NULL,              -- remote file path or page URL
  original_content  text,
  original_checksum text,
  new_content       text,
  new_checksum      text,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- extracted SEO fields before/after
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deployment_snapshots_change_idx ON deployment_snapshots(change_id, created_at DESC);

CREATE TABLE deployment_verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id uuid NOT NULL REFERENCES website_deployments(id) ON DELETE CASCADE,
  change_id     uuid NOT NULL REFERENCES seo_changes(id) ON DELETE CASCADE,
  url           text NOT NULL,
  http_status   integer,
  passed        boolean NOT NULL,
  checks        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{field, expected, actual, passed, kind: 'changed'|'unchanged'}]
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX deployment_verifications_deployment_idx ON deployment_verifications(deployment_id);

-- Per-project website deployment connection (host, user, root…) with the password/key encrypted
-- (AES-256-GCM, APP_ENCRYPTION_KEY) in secret_encrypted. Never returned to the browser.
ALTER TABLE integrations DROP CONSTRAINT integrations_provider_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_provider_check CHECK (provider IN ('google_search_console','google_analytics','google_oauth','website_deploy'));
