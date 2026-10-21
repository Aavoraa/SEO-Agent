# 2 · Feature matrix

Legend: **Built** = working end to end with tests · **Partial** = working core, gaps listed ·
**Planned** = not built (phase given). *Data* shows where numbers come from and the label they carry:
V = verified first-party, E = estimated third-party, M = modeled by us, U = unavailable until the
integration is configured ("Integration required"), D = demo.

| # | Module | Status | Phase | Data | What exists / what's missing |
|---|---|---|---|---|---|
| 1 | Overview | Built | – | V, M | Health trend, GSC/GA4 KPIs, setup checklist, approvals/alerts counts |
| 2 | Search Performance | Built | 2 | V | GSC clicks/impressions/CTR/position by page, query, country, device; GA4 sessions/conversions |
| 3 | Keyword Research | Partial | 3 | V, M, U | Discovery from GSC + expansion hypotheses. Volume, difficulty, CPC, trends: **Integration required** (keyword data provider) |
| 4 | Keyword Intelligence | Partial | 3 | V, M | Intent, types, clustering, cannibalisation, 7/28/90-day comparison, anomalies, keyword→page mapping. Missing: traffic potential from provider data |
| 5 | Rank Tracking | Planned | 3 | E, U | Today only GSC average position (V). Daily device/location tracking needs a SERP API adapter |
| 6 | SERP Intelligence | Planned | 3 | E, U | SERP features, SERP competitors – SERP API adapter |
| 7 | Technical SEO | Built | 1–2 | V | Crawler + 40 rules: status, HTTPS, redirects/chains/loops, canonical, robots, sitemap, noindex, hreflang, duplicates, headings, orphans, broken links, images/ALT, page size, JSON-LD, encoding, soft-404. Missing: JS rendering (Playwright), image byte size |
| 8 | On-Page SEO | Built | – | V, M | Title/meta/H1 rules, AI on-page optimisation with approval |
| 9 | Core Web Vitals | Planned | 2 | V, U | PageSpeed Insights / CrUX adapter (free API key) |
| 10 | Indexation | Partial | 2 | V | Indexability from crawl. URL Inspection API not integrated |
| 11 | Schema | Built | – | V, M | Validation, Organization/LocalBusiness/Service/FAQ generators |
| 12 | Content Strategy | Partial | 4 | V, M | Opportunities by cluster/intent. Missing: calendar |
| 13 | Content Gap | Built | 4 | V, M | GSC demand without a page + competitor structure gaps |
| 14 | Content Briefs | Built | 4 | M | AI briefs with approval. Missing fields vs brief spec: SERP features, entities (P3/P4) |
| 15 | AI Content | Built | 4 | M | Drafts from approved briefs, quality check, approval |
| 16 | Content Optimization | Partial | 4 | M | On-page optimisation + quality score. Missing: live editor scoring |
| 17 | Content Refresh | Partial | 4 | V, M | "refresh"/"declining" opportunities. Missing: decay model |
| 18 | Internal Linking | Built | 4 | V, M | Graph, orphans, weak pages, TF-IDF suggestions, AI anchors, approval |
| 19 | Backlink Intelligence | Partial | 4 | V, E, U | CSV import (GSC Links export) or DataForSEO; live checks; new/lost; anchors; follow/nofollow |
| 20 | Backlink Audit | Planned | 4 | M | Suspicious-link heuristics; never auto-disavow |
| 21 | Link Gap | Planned | 4 | E, U | Needs backlink provider |
| 22 | Link Opportunities | Partial | 4 | V | Broken-target 301 recovery built. Mention reclamation, PR opportunities planned |
| 23 | Competitor Intelligence | Partial | 3 | V | User-configured competitors, structure crawl. Auto-discovery needs SERP data |
| 24 | Competitor Keyword Gap | Planned | 3 | E, U | Provider |
| 25 | Competitor Content Gap | Built | 3 | V, M | Structure-only comparison (no content copied) |
| 26 | Competitor Backlink Gap | Planned | 4 | E, U | Provider |
| 27 | Competitor Traffic Intelligence | Planned | 11 | E, U | Provider; always labelled Estimated |
| 28 | Competitor Monitoring | Partial | 3 | V | Monthly crawl. Missing: new-page and ranking-change alerts |
| 29 | Local SEO | Built | 6 | V, M | Service × location matrix, NAP on site, LocalBusiness schema |
| 30 | Google Business Profile | Planned | 6 | V, U | GBP API needs Google approval |
| 31 | Map Rankings | Planned | 6 | E, U | Local SERP grid provider |
| 32 | Reviews | Planned | 6 | V, U | GBP reviews API |
| 33 | Citations | Planned | 6 | E, U | Directory checks (read-only; never auto-submit) |
| 34 | Market Intelligence | Planned | 11 | E, U | Provider; labelled Estimated |
| 35 | AI Search Visibility | Planned | 5 | V, M, U | Prompt runs through official model APIs; Google AI Overviews/AI Mode only via a SERP provider that returns them |
| 36 | AI Prompt Research | Planned | 5 | M | Prompts derived from GSC queries + services |
| 37 | AI Prompt Tracking | Planned | 5 | V | Scheduled prompt runs, stored answers |
| 38 | AI Citation Tracking | Planned | 5 | V | Citations/URLs parsed from answers where the API returns them |
| 39 | AI Brand Sentiment | Planned | 5 | M | Classifier over stored answers |
| 40 | AI Competitor Intelligence | Planned | 5 | V, M | Share of voice across tracked prompts |
| 41 | AI Readiness | Partial | 1/5 | V | AI-crawler access in robots.txt, llms.txt presence, schema, content structure (Phase 1) |
| 42 | Social Monitoring | Planned | 11 | U | Platform APIs |
| 43 | Digital PR | Planned | 11 | M | Opportunity tracking + pitch drafts (human sends) |
| 44 | Brand Monitoring | Planned | 11 | U | Mentions provider |
| 45 | SEO Experiments | Built | 9 | V | 28-day CTR/clicks experiments on approved changes |
| 46 | Migration Monitor | Built | 9 | V | Baseline/comparison snapshots, redirect map, regressions. Missing: backlinks + rankings in snapshot (P9) |
| 47 | Recommendations | Built | 7 | M | Transparent priority scoring, evidence, risk, confidence |
| 48 | Approval Center | Partial | 7 | – | Approve, reject, edit, rollback built. Schedule + preview planned (P8) |
| 49 | Automation | Built | 7 | – | 11 n8n workflows via job API, error handler |
| 50 | Reports | Built | 10 | V, M | Weekly + initial (HTML/Markdown, email), CSV exports. PDF planned |
| 51 | White-label Reports | Planned | 10 | – | Per-project branding |
| 52 | Alerts | Built | – | V | Uptime, traffic, ranking loss, migration, lost backlinks; Email/Slack/Teams/Telegram |
| 53 | AI Usage | Built | – | V | Tokens, cost, cache hits, budget |
| 54 | Integrations | Built (Phase 1) | 1 | – | Catalog of every provider: configured / **Integration required**, what it powers |
| 55 | Administration | Built (Phase 1) | 1 | – | Users, API keys (optionally project-scoped), project members, audit log |

## Agents (see doc 6)

| Agent | Status | Backing job(s) |
|---|---|---|
| Technical SEO | Built | `crawl` |
| Keyword | Built | `keywords` |
| Content | Built | `content-opportunities`, briefs, drafts |
| Internal Link | Built | `internal-links` |
| Backlink | Built | `backlinks-sync`, `backlinks-verify` |
| Local SEO | Built | `local-seo` |
| Competitor | Partial | `competitor-analyze` |
| Migration | Built | `migration-snapshot`, `migration-compare` |
| Reporting | Built | `weekly-report`, `initial-report` |
| Alert | Built | `alerts-evaluate`, `alerts-dispatch` |
| Schema | Partial | rules inside `crawl`; standalone agent P7 |
| SERP, Core Web Vitals, AI Visibility, AI Citation, AI Brand, Opportunity | Planned | P2–P7 |
