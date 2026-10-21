# Phoenixx IT – AI SEO Agent

An SEO automation and intelligence platform for **https://www.phoenixxit.com/**. It continuously crawls the site, pulls Search Console and GA4 data, finds problems and opportunities, uses AI (Claude or OpenAI, switchable) to draft improvements, **routes every website change through human approval**, implements approved changes through a safe adapter, verifies them on the live site and measures the result.

```
COLLECT → CRAWL → ANALYZE → DISCOVER → PRIORITIZE → GENERATE → HUMAN APPROVAL → IMPLEMENT → VERIFY → MEASURE → LEARN
```

> **Safety model.** The AI never publishes, deletes, redirects, changes canonicals/robots or edits metadata on its own. Everything that touches the website becomes a *recommendation* → *approval* (editor; **admin** for high-risk URL/indexing changes) → *change record* with before/after values → implementation via an adapter → live verification → rollback available. n8n runs with a *service* key that can run analysis jobs but **cannot approve anything**.

---

## What's inside

| Area | Where | Notes |
|---|---|---|
| Crawler | `apps/crawler` | robots.txt, sitemaps, redirect chains/loops, canonicals, indexability, headings, images, links, JSON-LD validation, encoding errors, soft-404, host/HTTPS canonicalisation |
| SEO engine | `packages/seo-engine` | 40+ configurable rules (technical, content, internal linking, schema, local), health score, transparent priority scoring, internal-link graph, schema generator/validator, content quality checker, migration monitor, competitor comparison, local SEO matrix |
| SEO Audit | `packages/seo-engine/src/audit.ts`, `apps/api/src/services/audits.ts`, dashboard **SEO Audit** | 10-category score from pass/fail checks, quick wins, grouped recommendations with AI explanations from recorded evidence, sandboxed preview, history + comparison, PDF/share |
| Website deployment | `apps/api/src/services/deployments.ts`, `packages/integrations/src/deploy/` | SFTP/FTPS/local/Git/WordPress/API; backup → deploy → checksum → HTTP → field-by-field verification → re-score; automatic restore; rollback; live switch per project. See [docs/deployment.md](docs/deployment.md) |
| Backlinks | `apps/api/src/services/backlinks.ts`, `packages/seo-engine/src/backlinks.ts` | CSV import (Search Console Links export / any SEO tool) or DataForSEO; weekly live check of every linking page; lost-link alerts; 301 proposals for links pointing at broken pages. **Monitoring only – never buys, requests or submits links** |
| Keyword engine | `packages/keyword-engine` | intent (informational/commercial/transactional/navigational/local), keyword types, clustering + cannibalisation, 7/28/90-day comparisons, anomaly detection, expansion hypotheses (**no fabricated volumes**) |
| AI engine | `packages/ai-engine` | `AIProvider` → `ClaudeProvider` / `OpenAIProvider` / `MockProvider`; 13 centralised prompt templates; JSON-schema structured output validated with zod; caching, budgets, retries, usage/cost tracking |
| Integrations | `packages/integrations` | Search Console + GA4 (service account or OAuth), Email/Slack/Teams/Telegram, website adapters (Manual export, Git, WordPress, API) |
| Reporting | `packages/reporting-engine` | weekly + initial SEO reports (HTML email + Markdown) |
| API | `apps/api` | Fastify + TypeScript, RBAC, API keys, audit log, rate limiting, jobs with correlation IDs |
| Dashboard | `apps/dashboard` | React + TypeScript + Tailwind |
| Automation | `n8n/workflows` | 8 required workflows + monthly competitor + weekly backlink workflows + error handler |
| Database | `database/migrations` | PostgreSQL schema (also runs on embedded PGlite for local/demo/tests) |

More detail: [docs/architecture.md](docs/architecture.md) · [docs/api.md](docs/api.md) · [docs/website-audit.md](docs/website-audit.md) (findings on the current phoenixxit.com) · [docs/operations.md](docs/operations.md) · [n8n/README.md](n8n/README.md)

---

## Quick start: demo mode (2 minutes, no credentials)

```bash
npm install
npm run demo            # seeds a SEPARATE demo database with clearly-labelled sample data, starts the API on :4000
npm run dev:dashboard   # in a second terminal → http://localhost:5173 → "Explore demo"
```

Demo mode uses a real crawl snapshot of phoenixxit.com (structure only), **synthetic** Search Console/GA4 numbers and a mock AI provider. Every screen shows a "DEMO – sample data" banner. Demo data lives in `.data/demo-db` and is never mixed with production data.

---

## Production setup (step by step)

### Step 1 – Install prerequisites
- **Docker** + Docker Compose (recommended), or **Node.js 20+** (22 LTS recommended) for running without Docker.
- Git (needed only for the Git website adapter).

### Step 2 – Clone / open the project
```bash
git clone <your-repo-url> phoenixx-seo-agent && cd phoenixx-seo-agent
```

### Step 3 – Configure `.env`
```bash
cp .env.example .env
```
Minimum for production: `POSTGRES_PASSWORD`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `SERVICE_API_KEY`, `N8N_ENCRYPTION_KEY` (each a long random string):
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```
Set `NODE_ENV=production`. Optionally set `ADMIN_EMAIL` / `ADMIN_PASSWORD` to create the first admin automatically.

### Step 4 – Start PostgreSQL
```bash
docker compose up -d postgres
```
*(Without Docker: leave `DATABASE_URL` empty to use the embedded PostgreSQL (PGlite) in `./.data/db`, or point it at any PostgreSQL 14+ server. Then run `npm run db:migrate`.)*

### Step 5 – Start the API
```bash
docker compose up -d --build api
```
Migrations run automatically on start. Without Docker: `npm install && npm run dev:api` (development) or `npm run build && npm start`. On first start the API creates the **Phoenixx IT** project for `SEO_SITE_URL`.

### Step 6 – Start the dashboard
```bash
docker compose up -d --build dashboard      # → http://localhost:8080
```
Without Docker: `npm run dev:dashboard` → http://localhost:5173. Open it and create the first admin account (setup screen) if you didn't set `ADMIN_EMAIL`.

### Step 7 – Start the crawler
The crawler runs inside the API (as the `crawl` job) – nothing extra to start. For a standalone audit without a database:
```bash
npm run crawl -- https://www.phoenixxit.com/ --max 200 --out exports/audit.json
```

### Step 8 – Start n8n and import the workflows
```bash
npm run cli -- create-api-key n8n        # or: docker compose exec api node dist/cli.js create-api-key n8n
npm run cli -- list-projects             # copy the Phoenixx IT project id
```
Put the key and id into `.env` as `SEO_API_KEY` and `SEO_PROJECT_ID`, then:
```bash
docker compose up -d n8n
docker compose --profile setup run --rm n8n-import
```
Open http://localhost:5678, check the workflows and **activate** them (start with *00 Error Handler*). See [n8n/README.md](n8n/README.md).

### Step 9 – Configure Google Search Console
Choose one:
- **Service account (recommended):** Google Cloud → create a service account + JSON key → enable *Google Search Console API* and *Google Analytics Data API* → in Search Console add the service-account email as a user of the property. Mount the key and set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`.
- **OAuth:** create an OAuth client (Web application) with redirect URI `<PUBLIC_API_URL>/api/integrations/google/callback`, set `GOOGLE_CLIENT_ID/SECRET`, then Dashboard → Settings → Integrations → **Connect Google**.

Set `SEARCH_CONSOLE_SITE_URL` (`sc-domain:phoenixxit.com` for a Domain property or `https://www.phoenixxit.com/` for URL-prefix) and run **Settings → Integrations → Sync Search Console** (or wait for the daily workflow). The first sync pulls 16 days; for history run `npm run cli -- job gsc-sync <projectId> '{"days":480}'` (GSC keeps ~16 months).

### Step 10 – Configure GA4
Add the service-account email (or OAuth user) as a **Viewer** on the GA4 property and set `GA4_PROPERTY_ID` (numeric ID from Admin → Property settings – the site's measurement ID `G-7Z9VDR6JRF` is **not** the property ID). Run *Sync GA4*.

### Step 11 – Configure the AI provider
```env
AI_PROVIDER=claude          # or openai
ANTHROPIC_API_KEY=...       # or OPENAI_API_KEY
AI_MODEL=                   # optional; defaults: claude-opus-5 / gpt-5
AI_MONTHLY_BUDGET_USD=50
```
Everything except AI copy generation (titles/metas, briefs → drafts, AI summaries) works with `AI_PROVIDER=none`.

### Step 12 – Run the first crawl
Dashboard → Overview → setup checklist → **Run initial crawl** (or `npm run cli -- job crawl`). Then **Generate SEO health report** (`job initial-report`).

### Step 13 – Open the dashboard
Review **Overview → SEO Issues → Recommendations → Approvals**. Approved changes are implemented by the configured website adapter (default: exported instructions for your developer) and verified automatically every 30 minutes by n8n.

---

## Required credentials

| Credential | Needed for | Required? |
|---|---|---|
| Google service account **or** OAuth client | Search Console, GA4 | Strongly recommended (keyword/performance features) |
| `SEARCH_CONSOLE_SITE_URL`, `GA4_PROPERTY_ID` | which property to read | with Google |
| `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` | AI analysis & content | Optional |
| SMTP / Slack / Teams / Telegram | alerts & weekly report delivery | Optional |
| Backlink export (Search Console → Links) **or** `DATAFORSEO_LOGIN/PASSWORD` | backlink monitoring | Optional |
| Website repo path / WordPress app password / website API | automated implementation | Optional (manual export works without) |

## Connecting Phoenixx IT production data
1. Verify phoenixxit.com in Search Console (the site already has a `google-site-verification` tag) and grant the service account access.
2. Grant the service account Viewer on the GA4 property that owns `G-7Z9VDR6JRF`.
3. Set the env vars above, restart the API, run *Sync Search Console* with `{"days": 480}` once for history, then *Keywords*.
4. **Before the redesign launches:** Migration Monitor → *Capture baseline from latest crawl*. After staging is up: *Crawl & snapshot* the staging URL and **Compare** – fix every critical finding (missing URLs → approved 301s) before go-live.

## Baseline a site without a database
```bash
npm run baseline -- https://www.phoenixxit.com/          # → exports/baseline/<host>-<date>/
```
Writes `inventory.csv` (one row per URL: status, indexability, title/meta/H1, canonical, words, inlinks, schema…), `internal-links.csv`, `issues.csv`, `baseline.json` (migration baseline), `site-profile.json` (stack, analytics IDs, AI-crawler access) and `SUMMARY.md`.

## Multiple clients (SaaS)
The platform is multi-tenant: **organizations → projects (websites) → members**. Anyone can sign up at `/signup` (when `SIGNUP_ENABLED=true`) and gets an organization on `SIGNUP_DEFAULT_PLAN`; the very first user becomes platform admin. Phoenixx IT is the built-in *internal* organization, and the demo data lives in a separate *demo* organization.

- **Roles:** owner, admin, manager, SEO specialist, content editor, developer, viewer, client (Organization → Members). A per-project role (Settings → Members) overrides the organization role. Non-members get 404.
- **Plans:** starter / growth / agency / enterprise / internal, defined in `packages/shared/src/plans.ts` and overridable via `PLANS_FILE`. They set limits on projects, users, pages per crawl, audits per month, AI budget and automation level, plus features (API, webhooks, white-label, autopilot…). Usage is metered in `usage_events`.
- **Command Center** (`/`) shows the *next best action* from the Opportunity Engine (the formula is in [docs/api.md](docs/api.md)). Press **Ctrl/⌘K** for the command palette, or **/** to search.
- **Automation levels 0–4** (Settings → Automation). Level 3–4 autopilot applies only low-risk, high-confidence fixes (plus medium-risk types you explicitly allow at level 4) up to a daily cap. High and critical risk are never automatic.
- **Heatmaps** (Analyze → Heatmaps): click and scroll maps drawn over a snapshot of each page, from the first-party `hm.js` snippet shown on that page. The page also lists Microsoft Clarity insights (sessions, scroll depth, dead/rage clicks) once a Clarity Data Export token is added. Clarity's own heatmap images stay in Clarity; its API doesn't expose them.
- **Recordings** (Analyze → Recordings): Clarity-style session replays recorded by the same snippet, using rrweb (MIT).
  - The timeline shows page changes, clicks, rage clicks, dead clicks and JS errors. You can skip idle time and play at 1–8× speed.
  - Filters cover device, rage/dead clicks, errors, visited page, duration, favorites and not-yet-viewed sessions.
  - Every input is masked (use the strict mode to mask all text), no cookies are set, and recordings are deleted after `RECORDING_RETENTION_DAYS`.
- **Webhooks and API keys** are per organization and HMAC-signed. The **Platform admin** page covers orgs, plans, feature flags, costs, failed jobs and security events.

Design docs: [docs/platform/](docs/platform/01-architecture.md) · competitive matrix: [09-competitive-matrix.md](docs/platform/09-competitive-matrix.md).

## Running tests
```bash
npm test            # unit + integration + n8n payload + end-to-end (≈10 s, no network needed)
npm run typecheck
```

## Current limitations
- Backlinks: Google offers no Links API, so without a paid provider the link list is refreshed by re-uploading the Search Console export (monthly is enough). Link *building* is deliberately not automated.
- JavaScript rendering is not performed (the current site is static HTML; if the redesign is a client-side SPA, add Playwright rendering to the crawler).
- Search volume is intentionally **not** estimated – there is no keyword-volume provider integrated; impressions are the demand signal.
- Google Business Profile has no public read API without approval; NAP consistency is checked on-site only.
- Core Web Vitals are not measured (crawler response time is reported instead); PageSpeed Insights can be added as another job.
- The Git adapter commits to a branch in a local clone and only pushes if configured; deployment/merge stays with your developer.
