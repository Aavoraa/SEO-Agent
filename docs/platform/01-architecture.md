# 1 · Architecture – Phoenixx Search Intelligence Platform

Status date: 2026-09-28. This document describes the platform the existing `phoenixx-seo-agent`
repository grows into. It is written against the code that exists today; anything not built yet
is marked **planned** with its phase.

## 1.1 Principles

| Principle | What it means in code |
|---|---|
| Data → Insight → Decision → Action → Result | Every module ends in a `recommendation` (decision) that can become a `seo_change` (action) with verification and measurement (result). Screens that only show data are secondary. |
| Never fabricate | Every metric carries a data label: `verified` (first-party API), `estimated` (third-party provider), `modeled` (our own calculation), `unavailable`, `demo`. Missing provider → UI shows **Integration required**, never a number. |
| Human in control | Risk `low` may be automated, `medium` needs approval, `high`/`critical` need explicit admin approval. The service key used by n8n can never approve. |
| Monitor, don't manipulate | No link buying, no mass outreach, no auto-disavow, no auto-submission. Outreach/PR features produce drafts and tracking only. |
| One source of logic | Business logic lives in TypeScript packages with tests. n8n only schedules and orchestrates API jobs. |
| Replaceable providers | AI, keyword data, SERP, backlinks, CWV, local and AI-visibility data all sit behind adapter interfaces. |

## 1.2 System context

```
                  ┌──────────────────────── Users (admin / editor / viewer, per project) ─────────────┐
                  │                                                                                     │
          ┌───────▼────────┐    REST/JSON (+ WebSocket, planned P7)     ┌──────────────────────────────┐
          │ Dashboard      │ ◄────────────────────────────────────────► │ API (Fastify, TypeScript)    │
          │ React+TS+TW    │                                            │ auth · RBAC · project scope  │
          └────────────────┘                                            │ jobs · routes · audit        │
                                                                        └──┬─────────┬──────────┬──────┘
   ┌──────────────┐  x-api-key (service)  jobs?wait=true                   │         │          │
   │ n8n          │ ─────────────────────────────────────────────────────►│         │          │
   │ schedules    │                                                        │         │          │
   └──────────────┘                                          ┌─────────────▼──┐  ┌───▼──────┐ ┌─▼──────────────┐
                                                             │ Engines (pkgs) │  │ Postgres │ │ Redis (P7)     │
                                                             │ seo · keyword  │  │ (PGlite  │ │ queue · cache  │
                                                             │ backlink · ai  │  │ local)   │ │ rate limits    │
                                                             └───────┬────────┘  └──────────┘ └────────────────┘
                                                                     │ adapters
      ┌──────────────┬───────────────┬───────────────┬───────────────┼───────────────┬────────────────┬──────────────┐
      ▼              ▼               ▼               ▼               ▼               ▼                ▼              ▼
  Crawler        Google (GSC,     AI providers    Keyword/SERP    Backlinks       PageSpeed/CrUX   AI visibility   Website adapters
  (own)          GA4, URL insp.)  Claude/OpenAI/  provider (P3)   (CSV,           (P2)             sources (P5)    manual · git ·
                                  Gemini (P5)                     DataForSEO)                                      WordPress · API
```

## 1.3 Components

| Component | Location | Responsibility | Status |
|---|---|---|---|
| Dashboard | `apps/dashboard` | React + TypeScript + Tailwind, custom component kit (`components/ui.tsx`), progressive disclosure | built |
| API | `apps/api` | Fastify; JWT + API keys; RBAC; project isolation; zod validation; rate limiting; audit log; job registry; correlation IDs | built (project isolation added in Phase 1) |
| Crawler | `apps/crawler` | robots/sitemaps, redirects, canonicals, indexability, headings, links, images, JSON-LD, encoding, site profile & AI-crawler access | built |
| SEO engine | `packages/seo-engine` | 40+ rules, health score, priority scoring, schema, internal links, migration diff, competitors, local, backlinks | built |
| Keyword engine | `packages/keyword-engine` | intent, clustering, cannibalisation, period comparison, anomalies | built |
| AI engine | `packages/ai-engine` | provider abstraction, 13 prompt templates, JSON-schema output, budget, cache, usage | built (Gemini P5) |
| Integrations | `packages/integrations` | Google, notifiers, website adapters, backlink provider | built |
| Reporting | `packages/reporting-engine` | weekly/initial HTML + Markdown | built (PDF/white-label P10) |
| Database | `packages/database`, `database/migrations` | Postgres/PGlite driver, migrations, helpers | built |
| Automation | `n8n/workflows` | 11 generated workflows + error handler | built |

### Package map: current → target

The target monorepo from the product brief is reached by **extracting** code when a module grows,
not by an up-front rename (renames would break 140+ tests and every import with no user value).

| Target package | Today | Extraction phase |
|---|---|---|
| `seo-engine` | `packages/seo-engine` | – |
| `keyword-engine` | `packages/keyword-engine` | – |
| `backlink-engine` | `seo-engine/src/backlinks.ts` + `integrations/src/backlinks.ts` | P4 |
| `migration-engine` | `seo-engine/src/migration.ts` + `api/services/migration.ts` | P9 |
| `competitor-engine` | `seo-engine/src/competitors.ts` | P3 |
| `content-engine` | `seo-engine/src/content-quality.ts` + `api/services/content.ts` | P4 |
| `local-seo-engine` | `seo-engine/src/local.ts` | P6 |
| `ai-search-engine` | – | P5 (new) |
| `automation-engine` | `api/services/jobs.ts` | P7 |
| `infra/docker`, `infra/postgres`, `infra/redis` | `docker/`, `docker-compose.yml` | P7 (with Redis) |

## 1.4 Runtime decisions

| Decision | Choice | Why |
|---|---|---|
| Database | PostgreSQL 16 in production; PGlite (embedded Postgres) for local, demo and tests | Same SQL everywhere; zero-install dev and hermetic tests |
| Jobs | In-process runner with `job_runs` rows (status, input, output, correlation id, timeout, single-flight per type) | Enough for one site; **Redis + BullMQ** arrive in P7 when multiple clients need parallel workers and retries |
| Realtime | Polling job status today; WebSocket channel for job progress/alerts in P7 | No user-visible need yet |
| UI kit | Existing Tailwind component kit, shadcn-style primitives adopted per component as screens are rebuilt | Avoid a big-bang UI rewrite; keep one visual language |
| Charts | Recharts | Already used |
| Secrets | Environment variables; OAuth refresh tokens encrypted (AES-GCM, `APP_ENCRYPTION_KEY`) in `integrations.secret_encrypted` | No secrets in DB plaintext or code |
| Demo | `DEMO_MODE` switches to a separate database (`.data/demo-db`), mock AI, `is_demo` project, banner on every screen | Demo data can't reach production |

## 1.5 Security model

- **Authentication:** email + password (scrypt) → JWT (12 h); API keys (hashed, revocable) for integrations; Google OAuth for data access only.
- **Authorisation:** platform role (`admin` sees every project) + **project membership** role (`admin`/`editor`/`viewer`) per project. API keys can be scoped to one project. The env service key (n8n) can run jobs on all projects but can never approve, edit settings or change users.
- **Isolation:** every `/api/projects/:projectId/*` request passes a membership check before any handler runs; project lists are filtered by membership.
- **Input:** zod on every body/query; parameterised SQL only; CSV/HTML parsing never executes content.
- **Outbound fetches** of user-supplied URLs (backlink sources) block private/loopback addresses on every redirect hop.
- **Web:** helmet headers, CORS allow-list, rate limiting (global + login/setup), bearer tokens (no cookies → no CSRF surface); OAuth `state` is signed.
- **Audit:** every approval, setting change, import, key/user change is written to `audit_logs` with actor, IP and request id.

## 1.6 Observability

Structured JSON logs with `correlationId` propagated from n8n (`x-correlation-id`) → API → job → AI calls;
`job_runs` and `ai_usage` tables; `/health` and `/ready`; n8n error-handler workflow turns failures into alerts.
