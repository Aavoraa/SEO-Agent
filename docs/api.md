# API reference

Base URL: `http://localhost:4000`. All `/api/**` routes except auth bootstrap require either
`Authorization: Bearer <JWT>` (users) or `x-api-key: <key>` (service/n8n). Errors:
`{ "error": { "code", "message", "details?", "correlationId" } }`. Send `x-correlation-id` to trace a call through logs and `job_runs`.

Roles: **viewer** read · **editor** + generate/approve low/medium risk · **admin** + high-risk approvals, rollback, settings, members · **service** read + jobs + generation (never approvals).

**Project isolation:** a user's role applies *per project* (`project_members`). Platform admins (`users.role = admin`) see every project and manage users/API keys. Non-members get `404` on another project's routes. API keys may be scoped to one project (`projectId`); the env `SERVICE_API_KEY` (n8n) reaches all projects.

## System & auth
| Method | Path | Notes |
|---|---|---|
| GET | `/health`, `/ready` | liveness / DB readiness |
| GET | `/api/system/status` | demo mode, needsSetup, AI provider, Google config, adapter, channels |
| POST | `/api/auth/setup` | `{email,name,password}` – first admin only |
| POST | `/api/auth/login` | `{email,password}` → `{token,user}` (rate-limited) |
| POST | `/api/auth/demo-login` | demo mode only |
| GET | `/api/auth/me` | current actor + `memberships` |
| GET/POST/PATCH | `/api/auth/users[/:id]` | platform admin; POST accepts `projects: [{projectId, role}]` |
| GET/POST/DELETE | `/api/auth/api-keys[/:id]` | platform admin; key shown once; POST accepts `projectId` (scoped key) |
| GET | `/api/projects/:pid/integrations/google/auth-url` | admin; OAuth consent URL |
| GET | `/api/integrations/google/callback` | OAuth redirect target |

## Projects & read models (`/api/projects/:pid/...`)
| GET path | Query params |
|---|---|
| `/api/projects` (only your projects), `/api/projects/:pid` (includes `myRole`) | – |
| `members` | – (project admin) |
| `integrations/catalog` | – every provider with status `connected|configured|manual|integration_required|planned` and data label |
| `ai-readiness` | – AI-crawler access, llms.txt, structure checks, detected stack (latest crawl) |
| `setup-status` | – |
| `overview` | `days` (7–180) |
| `performance` | `days` |
| `issues` | `severity,category,status,rule,page,q,from,to,limit,offset,format=csv` |
| `crawls` | – |
| `pages`, `pages/:pageId` | – |
| `keywords` | `intent,service,location,type,source,minPos,maxPos,minOpportunity,trend,q,clusterId,sort,window=7|28|90,format=csv` |
| `keyword-clusters` | – |
| `content`, `content/briefs/:id`, `content/drafts/:id` | – |
| `internal-links`, `local`, `competitors`, `competitors/comparison` | – |
| `backlinks` | – (summary, links, referring sites, broken targets) |
| `audits` | `device=desktop|mobile`, `auditId` – score, 10 categories (+trend), checks, grouped recommendations, quick wins, preview, protection, history |
| `audits/history`, `audits/compare` | `device`; `from,to` (audit ids) |
| `audits/:id/pdf` | – PDF report |
| `recommendations/:id/preview` | – dry run against the site file: file diff + expected/actual checks (writes nothing) |
| `change-requests` | – unified list: DRAFT … ROLLED_BACK with deployment/verification/rollback state |
| `deployments`, `deployments/:id` | `changeId` – steps, backups (checksums), verifications |
| `deployment` | – provider, mode (demo/live), CONNECTED / NOT CONNECTED, live switch (never secrets) |
| `recommendations`, `recommendations/:id` | `status,type,priority,source,risk,page` |
| `approvals` | pending recommendations, briefs, drafts + recent decisions |
| `changes`, `changes/:id` | `status`; `format=json|csv|md` on a single change |
| `changelog` | `page,type,from,to,user,includeTraffic` |
| `experiments`, `alerts`, `reports`, `reports/:id` (`format=json|html|md`), `migration`, `ai-usage` (`days`), `audit-logs`, `jobs`, `jobs/:id`, `rules` | – |

## Mutations
| Method | Path | Body | Role |
|---|---|---|---|
| POST | `/api/projects` | `{name, siteUrl, searchConsoleSiteUrl?, ga4PropertyId?}` | admin |
| PATCH | `/api/projects/:pid` | `{name?, settings?, businessProfile?}` | admin |
| POST | `.../members` | `{email, role}` – add an existing user | admin |
| PUT / DELETE | `.../members/:userId` | `{role}` | admin |
| PATCH | `.../issues/:id` | `{status: open|acknowledged|ignored}` | editor |
| PATCH | `.../alerts/:id` | `{status}` | editor |
| POST | `.../alerts` | `{severity,type,title,message,fingerprint,evidence?}` | editor/service |
| POST | `.../recommendations/:id/decision` | `{decision: approve|reject, comment?, editedValue?, previewConfirmed?}` | editor; high risk: admin + `previewConfirmed`; critical: never |
| POST | `.../recommendations/:id/generate` | – (AI copy for title/meta/H1) | editor/service |
| POST | `.../recommendations/:id/submit` \| `/dismiss` | – | editor |
| POST | `.../changes/:id/implement` | – (instruction-only changes are exported for a developer) | editor |
| POST | `.../changes/:id/verify` | `{manualConfirm?, note?}` – live check; `manualConfirm` (human only) for changes with no checkable value | editor |
| POST | `.../changes/:id/rollback` | `{reason?}` | admin |
| POST | `.../content/opportunities/:id/brief` | – | editor/service |
| PATCH | `.../content/opportunities/:id` | `{status}` | editor |
| POST | `.../content/briefs/:id/decision` | `{decision, comment?, brief?}` | editor |
| POST | `.../content/briefs/:id/draft` | – (requires approved brief + AI) | editor |
| POST | `.../content/drafts/:id/decision` | `{decision, comment?, title?, bodyMarkdown?}` (blocked while `[NEEDS INPUT]` remains) | editor |
| POST | `.../content/drafts/:id/quality` | – | editor |
| POST/DELETE | `.../competitors[/:id]` | `{name, baseUrl, maxPages?, notes?}` | editor |
| POST | `.../audits/:id/share` | – 7-day read-only PDF link | editor |
| POST | `.../recommendations/:id/explain` | – AI explanation from recorded evidence only (returns the evidence) | editor/service |
| POST | `.../recommendations/:id/approve-and-deploy` | `{comment?, editedValue?, previewConfirmed?}` | editor (admin + preview for high risk) |
| POST | `.../changes/:id/deploy` | `?wait=true` – backup → deploy → verify → re-score | editor/service |
| PUT | `.../deployment/connection` | `{provider, host, port, username, password?, privateKey?, remoteRoot, secure, hostFingerprint, verifyBaseUrl}` – secrets encrypted, write-only | admin |
| POST | `.../deployment/test` | – read-only connection test | admin |
| POST | `.../deployment/live` | `{enabled, confirmDomain}` | admin |
| POST | `.../backlinks/import` | `{csv, fileName?}` (Search Console Links export, SEO-tool export or URL list) | editor |
| POST | `.../jobs/:type?wait=true|false` | job input | editor/service |

## Jobs (`GET /api/jobs`)
`crawl` · `gsc-sync {days,endDate}` · `ga4-sync {days}` · `keywords {minImpressions,useAi}` · `content-opportunities {useAi}` · `internal-links {useAi}` · `local-seo {useAi}` · `onpage-optimize {pageUrl}` · `alerts-evaluate` · `alerts-dispatch` · `weekly-report {send}` · `initial-report` · `process-changes` · `experiments-evaluate` · `competitor-analyze {competitorId?}` · `backlinks-sync {limit?}` · `backlinks-verify {limit?}` · `seo-audit {device}` · `deploy-change {changeId}` · `verify-deployments` · `migration-snapshot {label, kind, sourceUrl?}` · `migration-compare {baselineId, comparisonId}` · `clarity-sync {numOfDays 1–3}` (Microsoft Clarity page insights; Clarity allows 10 calls/project/day) · `opportunities` (re-rank the Opportunity Engine) · `autopilot` (runs only at automation level 3–4; low-risk/high-confidence, daily cap)

`wait=true` returns `{jobId, correlationId, status: succeeded|failed, output|error}` (HTTP 200, or 4xx/5xx on failure so n8n retries/fails). Without `wait` → `202 {jobId, status: running}`; poll `GET .../jobs/:jobId`. A second run of the same job type while one is running returns `409`.

## Organizations, plans & platform admin (multi-tenant)
Organization roles: **owner · admin · manager · seo_specialist · content_editor · developer · viewer · client**. They map to project roles (owner/admin → admin; manager/seo_specialist/content_editor/developer → editor; viewer/client → viewer); a `project_members` row overrides the mapping. Non-members get `404`. Plan checks return `402` with `feature_not_in_plan` or `plan_limit`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/auth/signup` | `{email,name,password,organizationName}` when `SIGNUP_ENABLED`; creates an org on `SIGNUP_DEFAULT_PLAN`, caller = owner |
| POST | `/api/auth/accept-invite` | `{token, name?, password?}` |
| GET/POST | `/api/orgs` | list mine / create |
| GET/PATCH | `/api/orgs/:orgId` | PATCH `org.update`; `branding` needs the `whiteLabel` feature |
| GET | `/api/orgs/:orgId/usage` | entitlements + usage for the month |
| GET/PATCH/DELETE | `/api/orgs/:orgId/members[/:userId]` | `members.manage`; the last owner can't be removed or demoted |
| POST/DELETE | `/api/orgs/:orgId/invitations[/:id]` | returns an accept URL (token stored hashed, expires) ; counts against the user limit |
| GET/POST/DELETE | `/api/orgs/:orgId/api-keys[/:id]` | `apiAccess` feature; org-scoped keys |
| GET/POST/PATCH/DELETE | `/api/orgs/:orgId/webhooks[/:id]`, `POST .../:id/test` | `webhooks` feature; https required in production; secret shown once; HMAC `x-webhook-signature: t=…,v1=…` |
| GET | `/api/plans` | public plan catalogue |
| GET | `/api/admin/overview` | platform admin: orgs, totals, costs, failed jobs, security events, flags |
| PATCH | `/api/admin/orgs/:orgId` | `{planId?, planOverrides?, status?, billingStatus?}` |
| PUT | `/api/admin/feature-flags/:key` | `{state: disabled|internal|beta|orgs|public, orgIds?, description?}` |

Webhook events: `audit.completed · recommendation.created · approval.required · change.approved · deployment.started · deployment.completed · deployment.failed · verification.completed · rollback.completed · ranking.changed · traffic.changed · alert.created`.

## Command Center, opportunities, search, automation, onboarding
| Method | Path | Notes |
|---|---|---|
| GET | `.../command-center` | metrics (each with `source`, `updatedAt`, `dataLabel`), next best action, top opportunities, closed-loop counts |
| GET | `.../opportunities?category=&status=` | ranked list + the published formula |
| GET | `.../next-best-action` | single top opportunity with plain-language reasons |
| POST | `.../opportunities/refresh` | editor; re-collects and re-scores |
| PATCH | `.../opportunities/:id` | `{status: open|in_progress|done|dismissed|snoozed}` |
| GET | `.../search?q=` | pages, keywords, opportunities, issues, recommendations, changes, competitors, backlinks, reports |
| GET/PUT | `.../automation` | `{level 0–4, allowedMediumTypes, dailyLimit}`; admin; level capped by plan |
| POST | `/api/onboarding/detect` | `{url}` → CMS / framework / hosting / CDN / SEO plugins / analytics + ranked connection options (SSRF-guarded) |
| POST | `/api/onboarding/projects` | `{organizationId, url, name?, …}` creates the project from the detection |
| GET | `.../onboarding` | setup checklist |

Priority = 100 × (0.30·Impact + 0.20·BusinessValue + 0.15·Confidence + 0.15·(1−Effort) + 0.10·TimeSensitivity + 0.10·(1−Risk)) × Memory, with Memory = 0.85 + 0.25 × acceptance rate for that recommendation type (1.0 until 3 decisions).

## Heatmaps
First-party click and scroll maps, plus Microsoft Clarity page insights. Clarity's API has no heatmap or click-coordinate data, so its numbers are shown next to ours and never merged into them.

| Method | Path | Notes |
|---|---|---|
| GET | `/hm.js` | public tracker. `<script src="<PUBLIC_API_URL>/hm.js" data-key="hm_…" defer></script>`. No cookies, form values or IPs; honours DNT and GPC |
| POST | `/api/collect` | public beacon (`text/plain` JSON). The site key must match the project, and `Origin`/`Referer` must be one of the project's websites (403 otherwise). Max 100 clicks per beacon; rate-limited per IP |
| GET | `.../heatmaps/setup` | site key, snippet, tracking status, Clarity status |
| GET | `.../heatmaps/pages?days=&device=` | popular pages (views, clicks, average scroll, rage/dead) + the latest Clarity rows |
| GET | `.../heatmaps?path=&days=&device=` | click points (element CSS path + offset, with a page-position fallback), top elements, scroll reach (0–100% in 5% steps), totals |
| GET | `.../heatmaps/snapshot?path=` | the page with scripts, event handlers, frames and refreshes removed, plus a `<base>`. Rendered in a sandboxed iframe with scripts disabled |
| PUT/DELETE | `.../heatmaps/clarity` | admin; `{clarityProjectId, apiToken?}`. The token is stored encrypted and never returned |
| POST | `.../heatmaps/clarity/sync` | editor/service; one Data Export call (`dimension1=URL`, last 1–3 days) |

## Session recordings
Clarity-style session replays, recorded with rrweb (MIT). The hm.js snippet loads `/rr.js` only when recordings are on for the project and the session is sampled.
- **Masking:** every input is masked in the browser. `strict` mode masks all text. `data-hm-mask` masks an element's text, and `data-hm-block` leaves the element out of the recording.
- **Privacy:** there are no cookies (the session id lives in sessionStorage with a 30-minute idle timeout) and no IP addresses are stored. Bots, Do Not Track and Global Privacy Control are respected.

| Method | Path | Notes |
|---|---|---|
| GET | `/rr.js` | public; rrweb recorder served from our own origin |
| GET | `/api/collect/config?k=` | public; `{recordings: {enabled, sampleRate, masking}}` (disabled for bot user agents) |
| POST | `/api/collect/rec` | public beacon (`text/plain` JSON, ≤ 8 MB). Same site-key and origin check as `/api/collect`. Stored gzip-compressed per page view. Stats (clicks, rage/dead clicks, JS errors, pages) are kept on the session |
| GET | `.../recordings?days=&device=&rage=1&dead=1&errors=1&favorites=1&unviewed=1&page=&minDurationSec=&sort=newest\|oldest\|longest\|clicks\|pages&limit=&offset=` | session list + summary |
| GET | `.../recordings/:id` | session details, pages, previous/next ids (marks it viewed) |
| GET | `.../recordings/:id/events` | all rrweb events in time order (for the player) |
| PATCH | `.../recordings/:id` | editor; `{favorite}` |
| DELETE | `.../recordings/:id` | admin (e.g. a visitor's deletion request); audited |
| GET/PUT | `.../recordings/settings` | PUT admin; `{enabled, sampleRate 0–1, masking: balanced\|strict}` |
