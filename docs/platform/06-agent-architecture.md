# 6 · Agent architecture

## 6.1 What an "agent" is here

An agent is a **job** with a narrow responsibility that reads data, runs deterministic analysis, optionally
asks an AI model for a structured judgement, and writes **recommendations** – never direct website changes.

```
inputs (DB: crawl, GSC, GA4, provider data)
   → deterministic engine (rules, scoring, graph, diff)          packages/*-engine
   → optional AI step (prompt template → JSON schema → zod)      packages/ai-engine
   → recommendation(s) with evidence + priority + risk            api/services/recommendations.ts
   → approval gate (by risk)                                      Approval Center
   → implementation adapter → verification → measurement          api/services/changes.ts
```

Deterministic first, AI second: AI never produces a metric, only wording, classification or a summary of
numbers it was given. The shared `_principles.prompt` forbids fabricated data, ranking guarantees and
copying competitor content, and every AI response is schema-validated before use.

## 6.2 Decision record (every recommendation)

| Field | Column / source |
|---|---|
| Issue | `title`, `what` |
| Evidence | `evidence[]` (label/value pairs from real data) |
| Impact | priority factor `impact` (0–5) in `score_breakdown` |
| Confidence | `confidence` (low/medium/high) |
| Effort | priority factor `effort` |
| Risk | `risk` (low/medium/high; `critical` added with the P7 risk policy) |
| Business value | priority factor `businessRelevance` (home/service pages weighted) |
| Recommended action | `proposed_value` + `what` |
| Expected outcome | `expected_purpose` |
| Priority | `priority`, `priority_score`, `score_breakdown.reasons` (human-readable why) |

## 6.3 Risk policy

| Risk | Examples | Gate |
|---|---|---|
| low | ALT text, internal link suggestion, schema addition on non-key page | may be auto-implemented once the project enables "auto low-risk" (P7; off by default) |
| medium | title, meta description, H1, content edits | editor approval |
| high | redirect, canonical, robots, noindex, sitemap, new page | admin approval |
| critical | bulk redirects, domain/host changes, migration cut-over | admin approval + second approver (P7) |

## 6.4 Agent catalogue

| Agent | Job(s) | Inputs | Outputs | Status |
|---|---|---|---|---|
| Technical SEO | `crawl` | site | issues, health score, recs, AI audit summary | built |
| Keyword | `keywords` | GSC | keywords, clusters, cannibalisation, opportunities | built |
| Content | `content-opportunities` | keywords, crawl, competitors | opportunities, briefs, drafts | built |
| Internal Link | `internal-links` | crawl graph | link recs with anchors | built |
| Backlink | `backlinks-sync`, `backlinks-verify` | CSV / provider, live pages | link status, lost-link alerts, 301 recs | built |
| Local SEO | `local-seo` | GSC local queries, crawl | location recs | built |
| Competitor | `competitor-analyze` | configured competitors | structure gaps | partial |
| Migration | `migration-snapshot`, `migration-compare` | baseline vs new site | regressions, redirect map | built |
| Reporting | `weekly-report`, `initial-report` | everything | reports | built |
| Alert | `alerts-evaluate`, `alerts-dispatch` | GSC, uptime, jobs | alerts | built |
| Schema | inside `crawl` | crawl | schema recs | partial → standalone P7 |
| Core Web Vitals | `pagespeed` | PSI/CrUX | CWV issues | P2 |
| SERP | `serp-snapshot` | SERP provider | features, SERP competitors | P3 |
| AI Visibility / Citation / Brand | `ai-prompt-run` | model APIs | mentions, citations, sentiment, SoV | P5 |
| Opportunity | `opportunity-rank` | all recs | cross-agent top-10 "do this next" | P7 |

## 6.5 Contracts

- Input: `(ctx, projectId, input, correlationId)`; output: JSON summary stored in `job_runs.output`.
- Idempotent: recommendations upsert on a **fingerprint**; re-runs refresh evidence but never resurrect
  rejected items or overwrite human edits under review.
- Budgeted: AI calls go through `AIService` (monthly budget, cache, retries, usage rows per project/agent).
- Tested: each agent has engine unit tests plus an API test that runs the job against a local fixture site.
