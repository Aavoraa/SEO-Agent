-- Phoenixx SEO Agent – initial schema (PostgreSQL 14+; also runs on PGlite for local/demo/test)

-- ───────────────────────── Identity & access ─────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin','editor','viewer')),
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  role         text NOT NULL DEFAULT 'service' CHECK (role IN ('admin','editor','viewer','service')),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

-- ───────────────────────── Projects & websites ─────────────────────────
CREATE TABLE projects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             text NOT NULL UNIQUE,
  is_demo          boolean NOT NULL DEFAULT false,
  business_profile jsonb NOT NULL DEFAULT '{}'::jsonb,
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,
  onboarding       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE websites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_url       text NOT NULL,
  role           text NOT NULL DEFAULT 'production' CHECK (role IN ('production','staging','legacy')),
  sitemap_url    text,
  is_primary     boolean NOT NULL DEFAULT false,
  adapter_type   text NOT NULL DEFAULT 'manual' CHECK (adapter_type IN ('manual','git','wordpress','api')),
  adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, base_url)
);
CREATE INDEX websites_project_idx ON websites(project_id);

CREATE TABLE integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider         text NOT NULL CHECK (provider IN ('google_search_console','google_analytics','google_oauth')),
  status           text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','disconnected','error')),
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_encrypted text,
  connected_at     timestamptz,
  last_sync_at     timestamptz,
  last_error       text,
  UNIQUE (project_id, provider)
);

-- ───────────────────────── Crawling ─────────────────────────
CREATE TABLE crawl_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id     uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','cancelled')),
  trigger        text NOT NULL DEFAULT 'manual',
  correlation_id text,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  site_checks    jsonb NOT NULL DEFAULT '{}'::jsonb,   -- robots.txt, sitemap, https, host canonicalisation
  stats          jsonb NOT NULL DEFAULT '{}'::jsonb,
  pages_crawled  integer NOT NULL DEFAULT 0,
  pages_failed   integer NOT NULL DEFAULT 0,
  health_score   integer,
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);
CREATE INDEX crawl_runs_website_idx ON crawl_runs(website_id, started_at DESC);

CREATE TABLE pages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  website_id           uuid NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  url                  text NOT NULL,
  path                 text NOT NULL,
  page_type            text,
  is_important         boolean NOT NULL DEFAULT false,
  primary_keyword      text,
  status_code          integer,
  title                text,
  meta_description     text,
  h1                   text,
  word_count           integer,
  indexable            boolean,
  in_sitemap           boolean NOT NULL DEFAULT false,
  inlinks              integer NOT NULL DEFAULT 0,
  content_hash         text,
  last_crawl_result_id uuid,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  removed_at           timestamptz,
  UNIQUE (website_id, url)
);
CREATE INDEX pages_website_idx ON pages(website_id);

CREATE TABLE crawl_results (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crawl_run_id        uuid NOT NULL REFERENCES crawl_runs(id) ON DELETE CASCADE,
  page_id             uuid REFERENCES pages(id) ON DELETE SET NULL,
  url                 text NOT NULL,
  final_url           text,
  status_code         integer,
  redirect_chain      jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_time_ms    integer,
  content_type        text,
  content_length      integer,
  canonical           text,
  robots_meta         text,
  x_robots_tag        text,
  indexable           boolean,
  indexability_reason text,
  title               text,
  meta_description    text,
  h1s                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  h2s                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  h3s                 jsonb NOT NULL DEFAULT '[]'::jsonb,
  word_count          integer,
  images              jsonb NOT NULL DEFAULT '[]'::jsonb,
  internal_links      jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_links      jsonb NOT NULL DEFAULT '[]'::jsonb,
  structured_data     jsonb NOT NULL DEFAULT '[]'::jsonb,
  open_graph          jsonb NOT NULL DEFAULT '{}'::jsonb,
  hreflang            jsonb NOT NULL DEFAULT '[]'::jsonb,
  lang                text,
  content_hash        text,
  text_sample         text,
  signals             jsonb NOT NULL DEFAULT '{}'::jsonb,  -- mojibake, meta charset, viewport, mixed content…
  depth               integer,
  in_sitemap          boolean NOT NULL DEFAULT false,
  discovered_from     text,
  error               text,
  fetched_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crawl_results_run_idx ON crawl_results(crawl_run_id);
CREATE INDEX crawl_results_page_idx ON crawl_results(page_id, fetched_at DESC);

-- ───────────────────────── Issues ─────────────────────────
CREATE TABLE seo_issues (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  website_id        uuid REFERENCES websites(id) ON DELETE CASCADE,
  page_id           uuid REFERENCES pages(id) ON DELETE CASCADE,
  crawl_run_id      uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
  rule_id           text NOT NULL,
  category          text NOT NULL CHECK (category IN ('technical','content','internal_linking','local','schema','performance')),
  severity          text NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  title             text NOT NULL,
  description       text NOT NULL,
  evidence          jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommendation    text,
  url               text,
  fingerprint       text NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','ignored','resolved')),
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  last_detected_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX seo_issues_filter_idx ON seo_issues(project_id, status, severity);
CREATE INDEX seo_issues_page_idx ON seo_issues(page_id);

-- ───────────────────────── Search data ─────────────────────────
CREATE TABLE search_console_data (
  id          bigserial PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date        date NOT NULL,
  query       text NOT NULL DEFAULT '',
  page        text NOT NULL DEFAULT '',
  country     text NOT NULL DEFAULT '',
  device      text NOT NULL DEFAULT '',
  clicks      integer NOT NULL DEFAULT 0,
  impressions integer NOT NULL DEFAULT 0,
  ctr         double precision NOT NULL DEFAULT 0,
  position    double precision NOT NULL DEFAULT 0,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, date, query, page, country, device)
);
CREATE INDEX gsc_project_date_idx ON search_console_data(project_id, date);
CREATE INDEX gsc_project_query_idx ON search_console_data(project_id, query);
CREATE INDEX gsc_project_page_idx ON search_console_data(project_id, page);

CREATE TABLE analytics_data (
  id               bigserial PRIMARY KEY,
  project_id       uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  date             date NOT NULL,
  landing_page     text NOT NULL DEFAULT '',
  channel_group    text NOT NULL DEFAULT '',
  source           text NOT NULL DEFAULT '',
  medium           text NOT NULL DEFAULT '',
  sessions         integer NOT NULL DEFAULT 0,
  users            integer NOT NULL DEFAULT 0,
  engaged_sessions integer NOT NULL DEFAULT 0,
  engagement_rate  double precision NOT NULL DEFAULT 0,
  conversions      double precision NOT NULL DEFAULT 0,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, date, landing_page, channel_group, source, medium)
);
CREATE INDEX ga_project_date_idx ON analytics_data(project_id, date);

-- ───────────────────────── Keywords ─────────────────────────
CREATE TABLE keyword_clusters (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  key                   text NOT NULL,
  intent                text,
  strategy              text CHECK (strategy IN ('single_page','separate_pages','faq','blog','existing_page')),
  recommended_page_type text,
  target_page_url       text,
  rationale             text,
  services              text[] NOT NULL DEFAULT '{}',
  locations             text[] NOT NULL DEFAULT '{}',
  total_clicks          integer NOT NULL DEFAULT 0,
  total_impressions     integer NOT NULL DEFAULT 0,
  opportunity_score     double precision NOT NULL DEFAULT 0,
  cannibalization       jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_refined            boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE TABLE keywords (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  keyword              text NOT NULL,
  normalized           text NOT NULL,
  intent               text CHECK (intent IN ('informational','commercial','transactional','navigational','local')),
  intent_confidence    double precision,
  intent_source        text NOT NULL DEFAULT 'rules',
  keyword_type         text CHECK (keyword_type IN ('primary','secondary','long_tail','local','question','commercial')),
  services             text[] NOT NULL DEFAULT '{}',
  locations            text[] NOT NULL DEFAULT '{}',
  source               text NOT NULL DEFAULT 'gsc' CHECK (source IN ('gsc','expansion','competitor','manual','content')),
  search_volume        integer,
  search_volume_source text NOT NULL DEFAULT 'unavailable' CHECK (search_volume_source IN ('unavailable','estimated','provider')),
  target_page_url      text,
  cluster_id           uuid REFERENCES keyword_clusters(id) ON DELETE SET NULL,
  is_branded           boolean NOT NULL DEFAULT false,
  user_problem         text,
  expected_content     text,
  recommended_page_type text,
  recommended_cta      text,
  opportunity_score    double precision NOT NULL DEFAULT 0,
  opportunity_reasons  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, normalized)
);
CREATE INDEX keywords_cluster_idx ON keywords(cluster_id);
CREATE INDEX keywords_project_opp_idx ON keywords(project_id, opportunity_score DESC);

CREATE TABLE keyword_metrics (
  id           bigserial PRIMARY KEY,
  keyword_id   uuid NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
  window_days  integer NOT NULL,
  period_end   date NOT NULL,
  clicks       integer NOT NULL DEFAULT 0,
  impressions  integer NOT NULL DEFAULT 0,
  ctr          double precision NOT NULL DEFAULT 0,
  position     double precision,
  prev_clicks      integer NOT NULL DEFAULT 0,
  prev_impressions integer NOT NULL DEFAULT 0,
  prev_position    double precision,
  trend        text CHECK (trend IN ('rising','declining','stable','new','lost')),
  top_page     text,
  pages_count  integer NOT NULL DEFAULT 0,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (keyword_id, window_days, period_end)
);

-- ───────────────────────── Content ─────────────────────────
CREATE TABLE content_opportunities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type            text NOT NULL CHECK (type IN ('missing_service_page','missing_location_page','informational','faq','comparison','supporting_article','refresh','weak_coverage','declining')),
  title           text NOT NULL,
  target_keyword  text,
  cluster_id      uuid REFERENCES keyword_clusters(id) ON DELETE SET NULL,
  target_page_url text,
  score           double precision NOT NULL DEFAULT 0,
  priority        text NOT NULL DEFAULT 'medium',
  score_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  reasons         jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence        jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint     text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','brief_created','draft_created','published','dismissed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, fingerprint)
);

CREATE TABLE content_briefs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  opportunity_id uuid REFERENCES content_opportunities(id) ON DELETE SET NULL,
  target_keyword text NOT NULL,
  brief          jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','rejected')),
  ai_model       text,
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_drafts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  brief_id       uuid REFERENCES content_briefs(id) ON DELETE SET NULL,
  title          text NOT NULL,
  slug           text,
  body_markdown  text NOT NULL,
  meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
  quality_report jsonb,
  quality_score  integer,
  version        integer NOT NULL DEFAULT 1,
  status         text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','rejected','published')),
  ai_model       text,
  reviewed_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Recommendations, approvals, changes ─────────────────────────
CREATE TABLE recommendations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  page_id         uuid REFERENCES pages(id) ON DELETE SET NULL,
  page_url        text,
  issue_id        uuid REFERENCES seo_issues(id) ON DELETE SET NULL,
  source          text NOT NULL CHECK (source IN ('rule','ai','keyword','internal_linking','local','content','migration','competitor','manual')),
  type            text NOT NULL,
  title           text NOT NULL,
  what            text NOT NULL,
  why             text NOT NULL,
  evidence        jsonb NOT NULL DEFAULT '[]'::jsonb,
  current_value   text,
  proposed_value  text,
  expected_purpose text,
  risk            text NOT NULL DEFAULT 'medium' CHECK (risk IN ('low','medium','high')),
  priority        text NOT NULL DEFAULT 'medium' CHECK (priority IN ('critical','high','medium','low')),
  priority_score  double precision NOT NULL DEFAULT 0,
  score_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence      text NOT NULL DEFAULT 'medium' CHECK (confidence IN ('low','medium','high')),
  status          text NOT NULL DEFAULT 'pending_approval',
  requires_approval boolean NOT NULL DEFAULT true,
  ai_generated    boolean NOT NULL DEFAULT false,
  ai_model        text,
  fingerprint     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX recommendations_queue_idx ON recommendations(project_id, status, priority_score DESC);

CREATE TABLE seo_changes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recommendation_id uuid REFERENCES recommendations(id) ON DELETE SET NULL,
  page_id           uuid REFERENCES pages(id) ON DELETE SET NULL,
  page_url          text,
  change_type       text NOT NULL,
  old_value         text,
  new_value         text,
  reason            text,
  ai_recommendation jsonb,
  reviewer_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  approval_status   text NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','rejected')),
  status            text NOT NULL DEFAULT 'approved',
  adapter           text,
  adapter_ref       text,
  implemented_at    timestamptz,
  implemented_by    text,
  verified_at       timestamptz,
  verification      jsonb,
  rolled_back_at    timestamptz,
  result            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX seo_changes_project_idx ON seo_changes(project_id, created_at DESC);
CREATE INDEX seo_changes_status_idx ON seo_changes(project_id, status);

CREATE TABLE approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  recommendation_id uuid REFERENCES recommendations(id) ON DELETE CASCADE,
  brief_id          uuid REFERENCES content_briefs(id) ON DELETE CASCADE,
  draft_id          uuid REFERENCES content_drafts(id) ON DELETE CASCADE,
  change_id         uuid REFERENCES seo_changes(id) ON DELETE SET NULL,
  decision          text NOT NULL CHECK (decision IN ('approved','rejected','edited')),
  reviewer_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_label    text,
  comment           text,
  edited_value      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE change_events (
  id          bigserial PRIMARY KEY,
  change_id   uuid NOT NULL REFERENCES seo_changes(id) ON DELETE CASCADE,
  from_status text,
  to_status   text NOT NULL,
  actor       text,
  note        text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX change_events_change_idx ON change_events(change_id, created_at);

-- ───────────────────────── Internal links ─────────────────────────
CREATE TABLE internal_link_opportunities (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_url     text NOT NULL,
  target_url     text NOT NULL,
  anchor_text    text NOT NULL,
  reason         text NOT NULL,
  priority       text NOT NULL DEFAULT 'medium',
  score          double precision NOT NULL DEFAULT 0,
  similarity     double precision,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open','recommended','dismissed','implemented')),
  recommendation_id uuid REFERENCES recommendations(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, source_url, target_url)
);

-- ───────────────────────── Competitors ─────────────────────────
CREATE TABLE competitors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            text NOT NULL,
  base_url        text NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  notes           text,
  max_pages       integer NOT NULL DEFAULT 40,
  last_crawled_at timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, base_url)
);

-- Only structural metadata is stored – never competitor body copy.
CREATE TABLE competitor_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id    uuid NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  url              text NOT NULL,
  status_code      integer,
  title            text,
  meta_description text,
  h1               text,
  h2s              jsonb NOT NULL DEFAULT '[]'::jsonb,
  word_count       integer,
  internal_link_count integer,
  topics           jsonb NOT NULL DEFAULT '[]'::jsonb,
  services         text[] NOT NULL DEFAULT '{}',
  locations        text[] NOT NULL DEFAULT '{}',
  schema_types     text[] NOT NULL DEFAULT '{}',
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (competitor_id, url)
);

-- ───────────────────────── Experiments ─────────────────────────
CREATE TABLE experiments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  change_id      uuid REFERENCES seo_changes(id) ON DELETE SET NULL,
  page_url       text NOT NULL,
  name           text NOT NULL,
  hypothesis     text,
  primary_metric text NOT NULL DEFAULT 'ctr' CHECK (primary_metric IN ('ctr','clicks','impressions','position')),
  monitor_days   integer NOT NULL DEFAULT 28,
  start_date     date NOT NULL,
  end_date       date,
  baseline       jsonb,
  result         jsonb,
  status         text NOT NULL DEFAULT 'running' CHECK (status IN ('planned','running','completed','inconclusive','cancelled')),
  conclusion     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Alerts & reports ─────────────────────────
CREATE TABLE alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  severity     text NOT NULL CHECK (severity IN ('critical','high','medium','low','info')),
  type         text NOT NULL,
  title        text NOT NULL,
  message      text NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  fingerprint  text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','resolved')),
  occurrences  integer NOT NULL DEFAULT 1,
  notified     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz
);
CREATE UNIQUE INDEX alerts_open_fingerprint_idx ON alerts(project_id, fingerprint) WHERE status <> 'resolved';

CREATE TABLE reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('weekly','initial','migration','custom')),
  title        text NOT NULL,
  period_start date,
  period_end   date,
  summary      text,
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  html         text,
  markdown     text,
  ai_generated boolean NOT NULL DEFAULT false,
  sent_to      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reports_project_idx ON reports(project_id, created_at DESC);

-- ───────────────────────── Migration monitor ─────────────────────────
CREATE TABLE migration_snapshots (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  label          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('baseline','comparison')),
  source_url     text NOT NULL,
  crawl_run_id   uuid REFERENCES crawl_runs(id) ON DELETE SET NULL,
  top_queries    jsonb NOT NULL DEFAULT '[]'::jsonb,
  page_count     integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE migration_snapshot_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id      uuid NOT NULL REFERENCES migration_snapshots(id) ON DELETE CASCADE,
  url              text NOT NULL,
  path             text NOT NULL,
  status_code      integer,
  title            text,
  meta_description text,
  h1               text,
  canonical        text,
  indexable        boolean,
  inlinks          integer NOT NULL DEFAULT 0,
  outlinks         jsonb NOT NULL DEFAULT '[]'::jsonb,
  clicks           integer NOT NULL DEFAULT 0,
  impressions      integer NOT NULL DEFAULT 0,
  UNIQUE (snapshot_id, path)
);

-- ───────────────────────── Operations ─────────────────────────
CREATE TABLE job_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid REFERENCES projects(id) ON DELETE CASCADE,
  job_type       text NOT NULL,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  trigger        text NOT NULL DEFAULT 'manual',
  correlation_id text NOT NULL,
  input          jsonb NOT NULL DEFAULT '{}'::jsonb,
  output         jsonb,
  error          text,
  attempts       integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now(),
  started_at     timestamptz,
  finished_at    timestamptz
);
CREATE INDEX job_runs_project_idx ON job_runs(project_id, created_at DESC);

CREATE TABLE ai_usage (
  id                 bigserial PRIMARY KEY,
  project_id         uuid REFERENCES projects(id) ON DELETE CASCADE,
  provider           text NOT NULL,
  model              text NOT NULL,
  prompt_name        text NOT NULL,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cached             boolean NOT NULL DEFAULT false,
  estimated_cost_usd double precision NOT NULL DEFAULT 0,
  duration_ms        integer,
  success            boolean NOT NULL DEFAULT true,
  error              text,
  correlation_id     text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_project_idx ON ai_usage(project_id, created_at DESC);

CREATE TABLE ai_cache (
  key         text PRIMARY KEY,
  provider    text NOT NULL,
  model       text NOT NULL,
  prompt_name text NOT NULL,
  response    jsonb NOT NULL,
  hits        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE TABLE audit_logs (
  id          bigserial PRIMARY KEY,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  actor_type  text NOT NULL CHECK (actor_type IN ('user','api_key','system')),
  actor_id    text,
  actor_label text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip          text,
  request_id  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_project_idx ON audit_logs(project_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type, entity_id);
