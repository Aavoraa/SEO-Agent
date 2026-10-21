# Architecture

## Components

```
                      phoenixxit.com  (static HTML today; redesign-ready)
                              │  polite crawl (robots.txt, 3 workers, 250 ms delay)
                              ▼
 ┌──────────── n8n (schedules, retries, error workflow) ────────────┐
 │  POST /api/projects/:id/jobs/:type?wait=true   (service API key) │
 └──────────────────────────────┬───────────────────────────────────┘
                                ▼
 ┌──────────────────────────── API (Fastify) ─────────────────────────────┐
 │ auth/RBAC · rate limit · validation (zod) · audit log · correlation IDs │
 │                                                                         │
 │ services/  crawl · search-data · keywords · content · optimization ·    │
 │            local · competitors · recommendations · changes · alerts ·   │
 │            reports · migration · analytics · jobs                       │
 └──┬───────────┬──────────────┬───────────────┬──────────────┬───────────┘
    │           │              │               │              │
 crawler   seo-engine    keyword-engine    ai-engine      integrations
 (fetch,   (rules,       (intent,          (AIProvider:   (GSC, GA4, notifiers,
 cheerio)  scoring,      clusters,         Claude/OpenAI/  WebsiteAdapter:
           schema, links trends)           Mock; prompts,  Manual/Git/WordPress/API)
           quality, migration)             cache, budget)
    │
    ▼
 PostgreSQL (prod)  /  PGlite (local, demo, tests)         Dashboard (React) ← humans approve here
```

**Design decision – n8n orchestrates, the API decides.** n8n workflows are thin: schedule → call a job → log. All SEO logic, AI calls and state transitions live in TypeScript where they are unit/integration-tested and versioned. n8n adds scheduling, retries (3× / 30 s), execution history and an error workflow that turns failures into dashboard alerts + notifications.

## Lifecycle mapping

| Stage | Implementation |
|---|---|
| COLLECT | `gsc-sync` (query×page×date + site totals), `ga4-sync` (landing page × channel) |
| CRAWL | `crawlSite()` – sitemap + link discovery, redirect chains, robots, host/HTTPS checks, soft-404 probe |
| ANALYZE | `analyzeSite()` – rule engine → `seo_issues` (fingerprinted; auto-resolved when fixed) |
| DISCOVER | keyword intent/cluster/cannibalisation, content gaps, internal-link graph, local matrix, competitor structure |
| PRIORITIZE | `scorePriority()` – 6 visible factors (impact, severity, traffic opportunity, business relevance, ease, confidence) |
| GENERATE | deterministic fixes (e.g. valid JSON-LD from the business profile) + AI prompts for copy/briefs/drafts |
| HUMAN APPROVAL | `recommendations` → `approvals`; editors approve low/medium risk, **admins** approve high risk; service keys never approve |
| IMPLEMENT | `seo_changes` + `WebsiteAdapter.apply()` (manual export by default; git branch commit; WordPress; API) |
| VERIFY | live page fetch compares the field with the approved value → `verified` |
| MEASURE | `experiments` – 28-day before/after windows from Search Console |
| LEARN | experiment conclusion (correlation language), change log with traffic markers, weekly report |

## Status model (recommendations & changes)
`detected → analyzed → recommended → pending_approval → approved | rejected → implemented → verified → monitoring → completed | rolled_back` (+ `failed`).

## Data model (main tables)
`users, api_keys, projects, websites, integrations, crawl_runs, pages, crawl_results, seo_issues, search_console_data, analytics_data, keywords, keyword_metrics, keyword_clusters, content_opportunities, content_briefs, content_drafts, recommendations, approvals, seo_changes, change_events, internal_link_opportunities, competitors, competitor_pages, backlinks, experiments, alerts, reports, migration_snapshots, migration_snapshot_pages, job_runs, ai_usage, ai_cache, audit_logs` – see `database/migrations/` (indexes on every filter path; natural-key uniques make syncs idempotent).

## AI architecture
- `packages/ai-engine/prompts/*.prompt` – one file per task, shared `_principles.prompt` (no fabrication, no ranking guarantees, no competitor copying, high-risk flags, JSON only).
- `schemas.ts` – zod schema per prompt → JSON Schema sent as structured output; **every response is re-validated before storage**; invalid output is retried with the validation error, then rejected.
- `AIService.run()` – template rendering with per-variable truncation (`AI_MAX_INPUT_CHARS`), cache keyed by provider+model+prompt version+rendered input (`ai_cache`, TTL), monthly budget guard, 3 attempts with backoff, usage + estimated cost per call (`ai_usage`).
- Cost control: pages are summarised (first 3,000 chars) rather than sent whole; crawl AI summary only runs when the issue set changed; keyword intent AI only for low-confidence rows, batched 40 at a time; `AI_MODEL_LIGHT` for bulk classification.
- Provider switch: `AI_PROVIDER=claude|openai|mock|none`. The Claude provider uses the official SDK with structured JSON output and server-side refusal fallbacks on Opus-tier models; refusals and truncation are surfaced as typed errors.

## SEO rules engine
`packages/seo-engine/src/rules/{technical,content,linking-schema-local}.ts`. Each rule: id, category, rationale, default severity, params, check(). Projects override `enabled`, `severity` and `params` in Settings → SEO rules (stored in `projects.settings.rules`), e.g. `thin_content.minWords`, `slow_response.warnMs`, `title_length.max`.

## Health score
Internal diagnostic: 100 minus capped deductions per rule (critical 20/rule (cap 40), high 4 (cap 10), medium 1.5 (cap 5), low 0.25 (cap 1.5)). Always displayed with the disclaimer that it is **not** a Google metric.

## Security
- Secrets only from env; production refuses to start without `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `SERVICE_API_KEY`.
- Passwords: scrypt. API keys: stored as SHA-256 hashes, shown once. Google refresh tokens: AES-256-GCM encrypted at rest.
- RBAC: viewer (read), editor (generate/approve low+medium risk), admin (high-risk approval, rollback, settings, users), service (n8n: jobs + generation, never approvals).
- Helmet headers, CORS allow-list, rate limiting (stricter on login/setup), zod validation on every body/query, identifier whitelisting in SQL helpers, parameterised queries only.
- Audit log for logins, approvals, edits, implementations, rollbacks, settings, keys; secrets redacted from logs.

## Observability
Structured JSON logs with `correlationId` (from `x-correlation-id` or generated), per-request timing, `job_runs` (status, input, output, error, duration), `/health` and `/ready`, n8n execution history + error workflow → alerts → notifications.
