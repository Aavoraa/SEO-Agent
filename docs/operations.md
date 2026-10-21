# Operations guide

## Daily / weekly rhythm (n8n, Asia/Kolkata)
| When | Workflow | What happens |
|---|---|---|
| Daily 06:30 | 01 Daily SEO Monitor | GSC + GA4 sync, uptime, traffic-drop & ranking-loss alerts |
| Every 30 min | 05 On-Page Optimization (branch B) | implement approved changes via adapter, verify live, start experiments |
| Mon 02:00 | 02 Weekly Website Crawl | crawl, issues, recommendations, AI audit summary |
| Mon 04:00 | 06 Internal Linking Agent | link graph + suggestions |
| Mon 08:00 | 08 Weekly Report | evaluate experiments, build + email report |
| Tue 03:00 | 03 Keyword Discovery | intent, clusters, opportunities |
| Wed 03:00 | 04 Content Opportunity Agent | gap analysis, top-3 briefs → approval queue |
| Thu 03:00 | 07 Local SEO Monitor | service × location matrix |
| 1st of month | 09 Competitor Analysis | structure-only competitor crawl |
| Wed 04:00 | 10 Backlink Monitor | checks linking pages live, alerts on lost links, proposes 301s for links to broken pages |

## Approving changes safely
1. **Approvals** shows WHAT / WHY / EVIDENCE / CURRENT vs PROPOSED / RISK / EXPECTED PURPOSE.
2. Edit the proposal if needed (the edit is recorded separately in the audit trail) and approve.
3. The change is implemented by the adapter:
   - **manual** (default): `exports/<changeId>/apply.{md,json,csv}` – hand to the developer.
   - **git**: commits to `seo-agent/<id>-apply` in `WEBSITE_REPO_PATH`; your developer reviews/merges/deploys.
4. Verification runs automatically; when the new value is live the change becomes *Verified → Monitoring* and a 28-day experiment starts.
5. **Rollback** (admin): re-applies the stored previous value through the same adapter (or exports rollback instructions).

## Redesign protocol (critical)
1. Before any redesign work ships: Migration Monitor → *Capture baseline from latest crawl* (stores every URL, title, H1, canonical, indexability, inlinks and 90-day clicks/impressions).
2. When staging is available: *Crawl & snapshot* the staging URL (robots.txt is ignored for this crawl so a blocked staging site can still be audited).
3. *Compare* → fix every **critical** finding (missing URLs with traffic, lost indexability) before launch. Approve the proposed 301s (admin), export the Apache rules.
4. After launch: snapshot production again and compare with the baseline; watch the daily monitor for traffic drops.

## Backups
- PostgreSQL: `docker compose exec postgres pg_dump -U seo phoenixx_seo > backup.sql` (schedule daily).
- n8n workflows are in git (`n8n/workflows`); n8n execution data lives in the `n8n` database.

## Troubleshooting
| Symptom | Check |
|---|---|
| Job failed | Dashboard → Settings → Jobs (error + correlation id) → API logs filtered by `correlationId` |
| n8n failure alert | n8n → Executions; the alert message includes the failing node |
| GSC "403" | service-account email not added to the Search Console property |
| GA4 "403" / no data | wrong ID (must be numeric property ID) or missing Viewer access |
| AI 402 `ai_budget` | raise `AI_MONTHLY_BUDGET_USD` or wait for next month |
| Verification never passes | the change hasn't been deployed; check the adapter ref (branch / export folder) |

## Adding a rule
Add a `RuleDefinition` to the right file in `packages/seo-engine/src/rules/`, optionally map it to a recommendation in `fixes.ts`, add a test in `apps/crawler/test/crawler.test.ts` or `packages/seo-engine/test`. Thresholds are overridable per project without code changes.
