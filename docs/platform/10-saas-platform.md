# 10 · SaaS platform: status, architecture and roadmap (28 Sep 2026)

This document records what the multi-tenant transformation delivered and what is still open. Phoenixx IT is the
first **internal** organization. Everything else is tenant data.

Legend: **Implemented** = code + tests · **Partial** = working subset · **Planned** = designed, not built ·
**Provider** = needs a licensed data source.

## 1. Product architecture

```
Browser (React SPA)  ──JWT──►  Fastify API  ──►  PostgreSQL (PGlite in demo/dev)
  Command Center, palette        │  tenancy · access · entitlements · events
                                 ├─ services: crawl/audit, opportunities, recommendations,
                                 │  deployments (FileStore adapters), autopilot, alerts, search, detection
                                 ├─ packages: seo-engine (rules, scoring, opportunity formula),
                                 │  keyword-engine, ai-engine (budgets, cache, mock), integrations
                                 │  (GSC, GA4, backlinks, deploy adapters), reporting-engine
                                 └─ events ─► org webhooks (HMAC) + n8n (HMAC) ─► workflows 00–14
Crawler (apps/crawler): HTTP crawler, site-profile fingerprints, AI-crawler checks
```

Tenancy: **organization → projects → websites/data**. Every project query goes through `actorForProject`.
Every org action goes through `requireOrgPermission`.

## 2. Competitive matrix
See [09-competitive-matrix.md](09-competitive-matrix.md).

## 3. Feature matrix (SaaS spec modules)

| Module | Status |
|---|---|
| Multi-tenant orgs, 8 roles, invitations, last-owner protection | Implemented |
| Plans, entitlements (402), usage metering, per-org overrides | Implemented |
| Feature flags (disabled/internal/beta/orgs/public) | Implemented |
| Platform admin console (orgs, costs, failures, security events, flags) | Implemented |
| Sign-up, accept invite, brand-neutral UI, org branding (white-label feature) | Implemented |
| Command Center: next best action, labelled metrics, closed-loop counts | Implemented |
| Opportunity Engine: 8 sources, documented formula, decision memory | Implemented |
| Global search and Ctrl/⌘K command palette | Implemented |
| Heatmaps: click + scroll maps (first-party hm.js), rage/dead clicks, Microsoft Clarity page insights | Implemented |
| Session recordings: rrweb replay, masking (balanced/strict), rage/dead/error markers, filters, favorites, sampling, retention | Implemented |
| Website auto-detection and onboarding checklist | Implemented |
| Automation levels 0–4 and autopilot (daily cap, low-risk only) | Implemented |
| Org webhooks: 12 signed events, delivery log, auto-disable | Implemented |
| Per-tenant AI budget enforcement | Implemented |
| Audit → AI fix → approve → deploy → verify → re-score → rollback | Implemented (earlier phase) |
| SFTP / FTPS / FTP / local / Git / WordPress / manual adapters | Implemented; Shopify/Webflow/edge Planned |
| Billing (Stripe checkout, invoices, dunning) | Planned: `billing_status` field only |
| Rank tracking, SERP, keyword volume, backlink index, traffic estimates | **Provider** (not connected) |
| AI visibility / citation tracking | Planned + **Provider** |
| Content editor with SERP scoring | Partial (briefs/drafts/quality check) |
| Client portal UI, white-label PDF | Partial (role + branding exist) |
| Copilot chat, SEO plan generator, knowledge graph | Planned |
| JS rendering, Redis queue, horizontal workers | Planned |
| GBP, reviews, map grid | Planned + **Provider** |

## 4. Database schema
The migrations are checksummed; an applied migration is never edited.

| Migration | Tables |
|---|---|
| 001 | users, api_keys, projects, websites, integrations, crawl_runs, pages, crawl_results, seo_issues, search_console_data, analytics_data, keyword_clusters, keywords, keyword_metrics, content_opportunities, content_briefs, content_drafts, recommendations, seo_changes, approvals, change_events, internal_link_opportunities, competitors, competitor_pages, experiments, alerts, reports, migration_snapshots, migration_snapshot_pages, job_runs, ai_usage, ai_cache, audit_logs |
| 002 | backlinks |
| 003 | project_members |
| 004 | seo_audits, seo_audit_checks, website_deployments, deployment_snapshots, deployment_verifications (+ risk/confidence on changes, `critical` risk) |
| 005 | organizations, organization_members, organization_invitations, usage_events, feature_flags, webhook_endpoints, webhook_deliveries, opportunities (+ `organization_id` on projects, api_keys, audit_logs; backfills the *internal* and *demo* orgs) |

## 5. API map
See [docs/api.md](../api.md). SaaS additions:
- `/api/auth/signup`, `/api/auth/accept-invite`
- `/api/orgs/**` (members, invitations, api-keys, webhooks, usage)
- `/api/plans`
- `/api/admin/**`
- `.../command-center`, `.../opportunities`, `.../next-best-action`, `.../search`, `.../automation`
- `/api/onboarding/**`

## 6. AI agent map
All AI calls go through `ai-engine`. That layer handles prompt templates, JSON validation, caching, per-project and per-tenant monthly budgets, and a mock provider in demo mode. The model receives page content and evidence, **never credentials**.

| Agent | Output | Gate |
|---|---|---|
| On-page optimizer | title/meta/H1/schema/canonical proposals | approval by risk |
| Audit fix generator ("Fix with AI") | concrete change + preview | approval + automation level ≥1 |
| Keyword/intent clustering | clusters, intents | none (analysis) |
| Content opportunity / brief / draft | briefs, drafts, quality score | approval before publish |
| Internal linking | source → target + anchor | approval |
| Local SEO | NAP/schema/local page fixes | approval |
| Competitor analysis | structure and content gaps | none |
| Reporting narrative | summary text built from recorded metrics | none |
| Autopilot (deterministic, not LLM) | approves and deploys low-risk, high-confidence items | level 3–4, daily cap |

## 7. Deployment adapter map

| Adapter | Status | Notes |
|---|---|---|
| SFTP (ssh2) | Implemented | temp + rename, checksum, byte-exact backup |
| FTPS / FTP (basic-ftp) | Implemented | FTP only if explicitly allowed |
| Local files | Implemented | demo site copy on :4001 |
| Git (branch + commit) | Implemented | review happens in the repo |
| WordPress REST (app password) | Implemented | meta via SEO plugin fields |
| Generic website API | Implemented | |
| Manual export | Implemented | always available |
| Shopify / Webflow / Wix | Planned | detected in onboarding |
| Edge / Cloudflare Worker | Planned | |

Every deploy runs these steps: backup → apply in memory → validate → upload → checksum → HTTP check → field verification → re-score. The deploy is auto-restored on a transport, checksum or HTTP failure. Live mode requires three things: a configured provider, a successful connection test, and an admin enabling it with the domain typed to confirm.

## 8. Security architecture
- **Credentials:**
  - encrypted at rest (AES-GCM, `APP_ENCRYPTION_KEY`)
  - never returned to the browser
  - never sent to AI
  - never in Git
- **Authentication:**
  - scrypt password hashes, JWT sessions, login rate limit
  - API keys are stored hashed and shown once; they can be org- or project-scoped
- **Risk policy:**
  - low/medium: editor
  - high: admin + preview confirmed
  - critical: never executable
  - autopilot never goes above low risk, except medium types explicitly allowed at level 4
- **SSRF guard** (`net-guard.ts`): blocks private/loopback/link-local targets for webhooks, detection and backlink checks.
- **Webhooks:** HMAC `t=…,v1=…`; https-only in production; auto-disabled after 20 failures.
- **Audit trail:** `audit_logs` holds org/project/actor/IP for every mutation and security event.

## 9. Multi-tenant architecture
- Isolation is enforced **in the service layer**: `actorForProject` / `visibleProjectIds` / `requireOrgPermission`. Non-members get a 404, so a project's existence is never leaked.
- Org roles map to project roles; a `project_members` row overrides the mapping.
- Platform admin (`users.role='admin'`) bypasses org checks.
- Plan limits are checked before project creation, invitations, crawls (page cap, monthly audits), AI calls (monthly budget), automation level and features.
- **Not yet:** Postgres row-level security as a second layer, and per-tenant data retention.

## 10. n8n workflow architecture
Workflows 00–14 are generated by `n8n/scripts/generate-workflows.mjs`. They call the API with a service key and never touch the database directly.
- Workflow 12 consumes signed API events.
- Workflow 14 (daily 07:00): opportunities → autopilot (runs only if the level is 3–4) → alert dispatch.

The API also emits events to org webhooks, so customers can build their own automations.

## 11. UI information architecture
- **Decide:** Command Center, Opportunities, Approvals, Deployments & Changes
- **Analyze:** SEO Audit, Overview, Performance, SEO Issues, Keywords, Pages, AI Search, Competitors
- **Improve:** Content, Internal Links, Backlinks, Local SEO, Recommendations
- **Measure:** Experiments, Change Log, Migration, Reports, Alerts
- **Workspace:** Integrations, AI Usage, Organization, Settings (incl. Automation), Platform admin

Also: onboarding at `/onboarding`, sign-up at `/signup` and `/invite/:token`, and the Ctrl/⌘K palette and `/` search on every page.

## 12. Implementation roadmap

| Phase | Scope | Status |
|---|---|---|
| 1 Foundation | orgs, roles, plans, entitlements, flags, admin, webhooks, Command Center, Opportunity Engine, search, onboarding, automation levels | **Done** |
| 2 Data providers | provider abstraction + DataForSEO (SERP, keywords, backlinks), Google Ads Keyword Planner, rank tracking with daily snapshots | Next |
| 3 Billing | Stripe checkout, customer portal, webhooks → `billing_status`, trials, dunning | |
| 4 Scale | Redis/BullMQ queue, separate workers, JS rendering (Playwright), Postgres RLS | |
| 5 AI visibility | prompt sets, engine checks via official APIs/DataForSEO LLM, citations → recommendations | |
| 6 Content | SERP-aware content editor, publishing via adapters, decay tracking | |
| 7 Agency | client portal, white-label PDF, scheduled client reports | |
| 8 Adapters | Shopify, Webflow, edge worker | |
| 9 Copilot | chat over project data, SEO plan generator, knowledge graph | |

## 13. Environment variables
See `.env.example`. SaaS additions: `PRODUCT_NAME`, `SIGNUP_ENABLED`, `SIGNUP_DEFAULT_PLAN`, `PLANS_FILE`, `WEBHOOK_ALLOW_PRIVATE_HOSTS`, `OUTBOUND_ALLOW_PRIVATE_HOSTS`.

Existing: `DATABASE_URL`, `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `SERVICE_API_KEY`, AI keys, Google OAuth, `WEBSITE_DEPLOYMENT_PROVIDER` + `SFTP_*`/`FTP_*`/`DEPLOY_*`, `N8N_EVENTS_*`, `BACKLINK_*`.

## 14–15. External APIs and provider accounts

| Need | Provider | Account |
|---|---|---|
| Ranking/traffic ground truth | Google Search Console, GA4 | Google Cloud OAuth client (free) |
| Bing data | Bing Webmaster API | free |
| AI generation | Anthropic / OpenAI | API key + monthly budget |
| SERP, keywords, backlinks, AI answers | DataForSEO | pay-as-you-go |
| Keyword volume | Google Ads API | developer token (Basic access) |
| Backlinks (alternative) | Majestic / Ahrefs API / Semrush API | paid; check resale terms |
| Traffic estimates | Similarweb | sales contract |
| Billing | Stripe | account + webhook secret |
| Email | SMTP / transactional provider | alerts and reports today; invitation email is planned |
| Hosting deploy | SFTP / FTPS credentials, WordPress app password, Git token | per customer, encrypted |

## 16. Local development
```
npm install
npm run demo            # API :4000 (PGlite, mock AI) + demo site :4001, seeded demo org
npm run dev:dashboard   # http://localhost:5173 → "Try the demo"
npm test && npm run typecheck
```

## 17. Production deployment
`docker compose up -d` brings up Postgres, the API, the dashboard (static) and n8n. Before go-live:
1. Set strong `JWT_SECRET`, `APP_ENCRYPTION_KEY` and `SERVICE_API_KEY`.
2. Use `DATABASE_URL` to Postgres; migrations run on start.
3. Terminate TLS in front of the API and dashboard.
4. Set `SIGNUP_ENABLED` as intended, and keep `*_ALLOW_PRIVATE_HOSTS=false`.
5. Import the n8n workflows and set the `N8N_EVENTS_*` secret on both sides.
6. Enable live deployment per project only after a connection test.

## 18. Testing results
28 Sep 2026: `npm test`: **18 files, 218 tests passed**. `npm run typecheck`: clean (API, packages, dashboard). Demo verification:
- deploy → verify → rollback is byte-exact
- the opportunity refresh gives 48 candidates
- the next best action has evidence-based reasons
- metrics carry data labels

## 19. Known limitations
- The crawler doesn't render JavaScript (SPA sites are under-audited).
- Jobs run in-process (no Redis), with one worker per API instance.
- No billing integration; plans are assigned by the admin or at sign-up.
- Keyword volume, SERP, ranks, backlinks and competitor traffic are unavailable until a provider is connected. The UI shows "Unavailable" instead of numbers.
- Invitations are not emailed yet: the API returns an accept link (7-day expiry) for the inviter to share.
- Isolation lives in the application layer (no Postgres RLS yet).
- Experiments are before/after (correlation), not controlled split tests.

## 20. Remaining product gaps
Rank tracking · SERP analysis · keyword database · AI visibility and citation tracking · content editor with SERP scoring · Stripe billing · client portal · white-label PDF · Shopify/Webflow/edge adapters · GBP and reviews · Copilot chat · SEO plan generator · knowledge graph · JS rendering · queue/workers · data-retention settings · product analytics.

## 21. Recommended launch MVP
Phase 1 (done) + Phase 2 (DataForSEO + rank tracking) + Phase 3 (Stripe), with JS rendering from Phase 4.

The positioning is **"the SEO platform that fixes, verifies and proves"**: an audit that ends in verified, reversible changes on the real site, priced for agencies and SMB sites on WordPress, static or FTP/SFTP hosting.

## 22. Post-MVP
In this order:
1. AI visibility tracking
2. Content editor
3. Client portal / white-label
4. Shopify/Webflow
5. Edge deploy
6. Copilot
7. Controlled split tests
8. GBP/reviews
9. Knowledge graph
