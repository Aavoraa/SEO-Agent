# 4 · API specification

The complete reference for built endpoints is [`docs/api.md`](../api.md) (kept in sync with the code and
covered by API tests). This document defines the conventions every endpoint follows and the endpoints each
phase adds.

## 4.1 Conventions

| Topic | Rule |
|---|---|
| Style | REST + JSON. Project data under `/api/projects/:projectId/…`. Long work = **job** (`POST …/jobs/:type`). |
| Auth | `Authorization: Bearer <JWT>` (users) or `x-api-key` (integrations/n8n). |
| Access | Platform admin → all projects; otherwise project membership decides the role *for that project*. Project-scoped API keys only reach their project. Non-members get `404` (existence isn't leaked). |
| Roles | viewer: read · editor: generate, approve low/medium risk, import, run jobs · admin: high-risk approvals, rollback, settings, members · service: read, jobs, generation – never approvals |
| Validation | zod on body and query → `400 {error:{code:'validation', details:[{path,message}]}}` |
| Errors | `{error:{code, message, details?, correlationId}}`; 401 unauthenticated, 403 role, 404 not found / not a member, 409 state conflict or job already running, 429 rate limit |
| Tracing | `x-correlation-id` in → echoed out, stored on `job_runs`, logs and `ai_usage` |
| Lists | `limit` (≤500) / `offset`; `format=csv` on tabular endpoints |
| Data labels | Metrics from providers are returned with `source` and `dataLabel` (`verified`, `estimated`, `modeled`, `unavailable`, `demo`). An endpoint whose provider is missing returns `{ available: false, integration: '<id>', reason }` – the UI renders **Integration required**. |
| Idempotency | Imports/syncs upsert on natural keys; re-running a job never duplicates rows. |
| Webhooks (P7) | Inbound webhooks (n8n, CMS) verify an HMAC-SHA256 signature header over the raw body with a per-integration secret and reject >5 min old timestamps. |

## 4.2 Phase 1 endpoints (built in this phase)

| Method | Path | Body / query | Role |
|---|---|---|---|
| GET | `/api/projects` | – (filtered to the caller's projects) | any |
| GET | `/api/projects/:pid/members` | – | project admin |
| PUT | `/api/projects/:pid/members/:userId` | `{role: admin|editor|viewer}` | project admin |
| DELETE | `/api/projects/:pid/members/:userId` | – | project admin |
| POST | `/api/auth/users` | adds `projects?: [{projectId, role}]` | platform admin |
| GET | `/api/auth/me` | returns `memberships: [{projectId, role}]` | any |
| POST | `/api/auth/api-keys` | adds `projectId?` (scoped key) | platform admin |
| GET | `/api/projects/:pid/integrations/catalog` | – every provider: `{id, name, category, status: connected|configured|integration_required|not_available, powers[], dataLabel, setup}` | any member |
| GET | `/api/projects/:pid/ai-readiness` | – AI-crawler access per bot (robots.txt), llms.txt, schema coverage, from the latest crawl | any member |

CLI (Phase 1): `npm run baseline -- <url> [--out dir] [--max N]` → SEO inventory CSV, internal-link edges
CSV, migration baseline JSON, site profile JSON and a Markdown summary, without a database.

## 4.3 Endpoints by later phase

```text
P2  GET  …/core-web-vitals?url&strategy          POST …/jobs/pagespeed {urls?}
    GET  …/indexation                            POST …/jobs/url-inspection {urls?}
P3  GET  …/rank-tracking/keywords                POST/DELETE …/rank-tracking/keywords[/:id]
    GET  …/rankings?keyword&device&location&from&to
    GET  …/serp/:keywordId                       POST …/jobs/rank-check, …/jobs/serp-snapshot
    GET  …/keywords/:id/metrics                  (volume/CPC/difficulty with dataLabel)
    GET  …/competitors/discovered                POST …/competitors/:id/confirm
    GET  …/gaps/keywords?competitorId
P4  GET  …/backlinks/audit                       GET …/gaps/backlinks?competitorId
    GET  …/link-opportunities                    PATCH …/link-opportunities/:id {status, notes}
    GET  …/content/calendar                      GET/POST …/content/drafts/:id/versions
P5  GET/POST/PATCH …/ai/prompts[/:id]            POST …/jobs/ai-prompt-run {engines?, promptIds?}
    GET  …/ai/visibility?engine&from&to          GET …/ai/citations   GET …/ai/mentions   GET …/ai/share-of-voice
P6  GET  …/local/profile  …/local/reviews  …/local/citations  …/local/grid?keyword
P7  GET  …/agents  …/agents/runs                 WS /api/ws?projectId  (job progress, alerts, approvals count)
P8  POST …/changes/:id/schedule {runAt}          GET …/changes/:id/preview (rendered before/after)
P9  GET  …/migration/:pairId/changes             (backlinks + rankings at risk per URL)
P10 GET/POST …/report-templates                   GET …/reports/:id?format=pdf
    POST /api/clients  (client workspace = group of projects)   GET /api/clients/:id/projects
P11 GET  …/market/trends  …/brand/mentions  …/pr/opportunities  …/social/posts
```
