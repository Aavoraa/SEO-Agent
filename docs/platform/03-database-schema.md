# 3 · Database schema

PostgreSQL 16 (PGlite locally). Migrations: `database/migrations/NNN_*.sql`, applied in order,
checksummed, never edited after release. All ids are `uuid`, all timestamps `timestamptz`.

## 3.1 Conventions

- Every project-owned table has `project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE`
  and an index starting with `project_id` → one-query tenant isolation and clean project deletion.
- Natural-key `UNIQUE` constraints make every sync idempotent (`ON CONFLICT … DO UPDATE`).
- Enumerations are `text` + `CHECK`, mirrored in `packages/shared/src/types.ts`.
- Metric tables fed by external providers carry `source text` and `data_label text CHECK (data_label IN
  ('verified','estimated','modeled','unavailable','demo'))` (introduced with each provider table from P3 on).
- Demo rows live in a separate database; `projects.is_demo` is a second guard.

## 3.2 Requested entity → table

| Requested | Table(s) | Status |
|---|---|---|
| projects | `projects`, `project_members` | built (members: Phase 1, migration 003) |
| sites | `websites` | built |
| pages | `pages` | built |
| crawls / crawl_results | `crawl_runs` (incl. `site_checks` JSON: robots, sitemaps, host variants, **site profile, AI-crawler access**), `crawl_results` | built |
| keywords / keyword_groups | `keywords`, `keyword_metrics`, `keyword_clusters` | built |
| rankings / serps | `rank_tracking_keywords`, `rankings`, `serp_snapshots`, `serp_results` | P3 |
| competitors / competitor_pages / competitor_keywords | `competitors`, `competitor_pages`; `competitor_keywords` | built; keywords P3 |
| backlinks / referring_domains | `backlinks` (referring domains derived by `GROUP BY source_domain`); `referring_domains` table P4 when provider metrics (rank, spam score) are stored | built / P4 |
| content / content_briefs / content_versions | `content_opportunities`, `content_briefs`, `content_drafts`; `content_versions` | built; versions P4 |
| internal_links | `internal_link_opportunities`; link edges stored per crawl in `crawl_results.internal_links` | built |
| ai_prompts / ai_visibility / ai_mentions / ai_citations / ai_sentiment | `ai_prompts`, `ai_prompt_runs`, `ai_mentions`, `ai_citations` (sentiment is a column on `ai_mentions`), `ai_visibility_daily` | P5 |
| local_profiles / local_rankings / reviews | `local_profiles`, `local_rank_grids`, `local_rank_points`, `reviews`, `citations` | P6 |
| recommendations / approvals / changes | `recommendations`, `approvals`, `seo_changes`, `change_events` | built |
| experiments | `experiments` | built |
| alerts / reports | `alerts`, `reports` | built |
| integrations | `integrations` (per-project OAuth/credentials, encrypted) | built |
| agent_runs / workflow_runs | `job_runs` (agent = job type; `trigger` = `n8n` / `user:…` / `system`; correlation id links to n8n execution) | built; split into `agent_runs` + `workflow_runs` in P7 |
| ai_usage | `ai_usage`, `ai_cache` | built |
| migration_snapshots / migration_changes | `migration_snapshots`, `migration_snapshot_pages`; findings stored in `reports` (type `migration`) | built; `migration_changes` table P9 |
| audit | `audit_logs` | built |

## 3.3 Phase 1 additions (migration `003_project_isolation.sql`)

```sql
CREATE TABLE project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('admin','editor','viewer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
ALTER TABLE api_keys ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE CASCADE;
-- existing non-admin users keep access to existing projects (backfill)
```

Access rule: platform `admin` → all projects. Everyone else → projects in `project_members`, with that
membership's role. API keys with `project_id` → that project only; without → all (legacy, admin-created).

## 3.4 Planned tables (key columns)

```text
P2  page_speed_runs(project_id, url, strategy[mobile|desktop], lcp_ms, inp_ms, cls, ttfb_ms, performance_score,
                    field_data jsonb, source['psi'|'crux'], data_label, fetched_at)
    index_inspections(project_id, url, verdict, coverage_state, last_crawl_time, google_canonical, fetched_at)

P3  rank_tracking_keywords(project_id, keyword, device, country, location_code, search_engine, is_active)
    rankings(tracking_keyword_id, date, position, url, serp_features text[], source, data_label)
    serp_snapshots(project_id, keyword, device, location_code, fetched_at, features jsonb, source, data_label)
    serp_results(snapshot_id, rank, url, domain, title, type)
    keyword_data(project_id, keyword, country, search_volume, cpc, difficulty, trend jsonb, source, data_label, fetched_at)
    competitor_keywords(competitor_id, keyword, position, url, source, data_label, fetched_at)

P4  referring_domains(project_id, domain, domain_rank, first_seen_at, last_seen_at, source, data_label)
    content_versions(project_id, draft_id, version, body_markdown, meta jsonb, created_by, created_at)
    link_opportunities(project_id, kind['broken_target'|'mention'|'resource'|'pr'], url, domain, status, notes)

P5  ai_prompts(project_id, prompt, topic, intent, source['gsc'|'service'|'manual'], is_active)
    ai_prompt_runs(prompt_id, engine['chatgpt'|'claude'|'gemini'|'perplexity'|'google_aio'|'google_ai_mode'],
                   model, run_at, answer_text, raw jsonb, source, data_label)
    ai_mentions(run_id, brand, is_own_brand, position, sentiment[-1..1], context)
    ai_citations(run_id, url, domain, is_own_domain, position)
    ai_visibility_daily(project_id, engine, date, visibility, share_of_voice, citation_score, sentiment)

P6  local_profiles(project_id, place_id, name, address jsonb, phone, categories text[], source, fetched_at)
    local_rank_grids(project_id, keyword, center_lat, center_lng, radius_km, grid_size, run_at, source)
    local_rank_points(grid_id, lat, lng, rank, top_result)
    reviews(project_id, profile_id, rating, text, author_hash, published_at, sentiment, replied)
    citations(project_id, directory, url, name, address, phone, nap_consistent, checked_at)

P7  agent_runs(project_id, agent, job_run_id, input jsonb, output jsonb, recommendations int, status)
    workflow_runs(project_id, workflow, n8n_execution_id, correlation_id, status, started_at, finished_at)

P8  scheduled_changes(change_id, run_at, status)   -- "Schedule" in the Approval Center

P9  migration_changes(snapshot_pair, path, type, severity, before, after, clicks_at_risk, backlinks_at_risk)

P10 report_templates(project_id, name, sections jsonb, branding jsonb)   -- white-label
```
