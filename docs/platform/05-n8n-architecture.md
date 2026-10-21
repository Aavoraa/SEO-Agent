# 5 · n8n workflow architecture

## 5.1 Role of n8n

n8n is the **scheduler and orchestrator**, never the brain. Every step is an HTTP call to the API's job
endpoint (`POST /api/projects/:pid/jobs/:type?wait=true`). Business logic, AI calls, approvals and data
writes stay in tested TypeScript. This keeps workflows small, replaceable and testable
(`n8n/test/workflows.test.ts` replays every static job body against the real API).

## 5.2 Building blocks (generator: `n8n/scripts/generate-workflows.mjs`)

| Block | Behaviour |
|---|---|
| `schedule(name, cron)` | Cron trigger, timezone Asia/Kolkata |
| `job(name, type, {body, optional, timeoutMin})` | Calls a job with the **service key** from `$env.SEO_API_KEY`; 3 tries, 30 s apart; sends `x-correlation-id = <workflow>-<executionId>`; `optional` steps continue on failure |
| `apiGet(name, path)` | Read endpoint with the same auth/retry rules |
| `code('Log summary')` | Writes a compact job summary to the execution log |
| Error workflow | Every workflow sets `settings.errorWorkflow = 00 Error Handler`, which posts an alert to the API (→ Email/Slack/Teams/Telegram) |

Rules: no secrets in workflow JSON (tested), one workflow per business cadence, a job may appear in several
workflows, and workflows are regenerated from the script – never hand-edited in the n8n UI.

## 5.3 Workflow catalogue

| # | Workflow | Cadence | Jobs | Status |
|---|---|---|---|---|
| 00 | Error Handler | on failure | `POST …/alerts` | built |
| 01 | Daily SEO Monitor (daily performance) | daily 06:30 | `gsc-sync`, `ga4-sync`, `alerts-evaluate`, `alerts-dispatch` | built |
| 02 | Weekly Website Crawl (crawling + technical audit) | Mon 02:00 | `crawl`, `alerts-dispatch` | built |
| 03 | Keyword Opportunity Discovery (discovery + clustering) | Tue 03:00 | `gsc-sync`, `keywords` | built |
| 04 | Content Opportunity Agent | Wed 03:00 | `content-opportunities` | built |
| 05 | On-Page Optimization + Implement/Verify | webhook / every 30 min | `onpage-optimize`, `process-changes` | built |
| 06 | Internal Linking Agent | Mon 04:00 | `internal-links` | built |
| 07 | Local SEO Monitor | Thu 03:00 | `local-seo` | built |
| 08 | Weekly Report | Mon 08:00 | `experiments-evaluate`, `weekly-report` | built |
| 09 | Monthly Competitor Analysis | 1st of month | `competitor-analyze`, `content-opportunities` | built |
| 10 | Weekly Backlink Monitor | Wed 04:00 | `backlinks-sync`, `backlinks-verify`, `alerts-dispatch` | built |
| 11 | Core Web Vitals | weekly | `pagespeed` | P2 |
| 12 | Rank Tracking | daily | `rank-check`, `alerts-evaluate` | P3 |
| 13 | SERP & Competitor Monitoring | weekly | `serp-snapshot`, `competitor-discover` | P3 |
| 14 | AI Visibility / Prompt Tracking / Citations / Sentiment | daily / weekly | `ai-prompt-run`, `ai-visibility-aggregate` | P5 |
| 15 | Local rankings & reviews | weekly | `local-grid`, `reviews-sync` | P6 |
| 16 | Recommendations & Approvals digest | daily | `recommendations-digest` (notifies approvers; never approves) | P7 |
| 17 | Migration Watch (launch window) | hourly for 14 days after go-live | `migration-snapshot`, `migration-compare` (compare started by a user, then re-checked) | P9 |
| 18 | Monthly / client reports | 1st of month | `monthly-report`, `client-report` | P10 |

## 5.4 Multi-client

One n8n instance serves every project: workflows loop over `GET /api/projects?automation=enabled` (P7)
with a scoped key per client, or run per project via `$env.SEO_PROJECT_ID` (today, single project).
Per-project concurrency and retries move to the Redis queue in P7, so n8n only enqueues.
