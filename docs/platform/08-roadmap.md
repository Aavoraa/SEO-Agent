# 8 · Implementation roadmap

Each phase ships working, tested features end to end (DB → API → job/workflow → UI). "Done" means: tests
green, docs updated, demo data (clearly labelled) for the new screens, and no dashboard control without a
backend behind it.

| Phase | Scope | Already in the repo | Still to build | Needs from you |
|---|---|---|---|---|
| **1 Foundation** | DB, auth, projects, crawler, dashboard shell | Postgres/PGlite + migrations, JWT/API keys/RBAC, audit, crawler, 20-screen dashboard, demo mode | **Project membership isolation**, project-scoped API keys, integrations catalog + "Integration required", data labels, AI-crawler access + site profile in crawler, baseline CLI, Phoenixx IT baseline | – |
| 2 GSC · GA4 · Technical | GSC/GA4 sync, technical audit, pages, health | all built | Core Web Vitals (PageSpeed Insights), URL Inspection API, image byte sizes, optional JS rendering | Google service account; PSI API key (free) |
| 3 Keywords · SERP · Rank · Competitors | | GSC keywords, clustering, structure competitors | Keyword data + SERP + rank-tracking adapters, competitor discovery, keyword gap | Choose provider (e.g. DataForSEO) + budget |
| 4 Content · Internal links · Backlinks | | briefs/drafts/quality, internal links, backlink monitoring | Content calendar/versions/decay, backlink audit, link gap, link/mention opportunities | – (provider from P3 reused) |
| 5 AI Search | | – | Prompt library, scheduled prompt runs per engine, mention/citation parsing, sentiment, SoV, Gemini provider | API keys for the engines to track; SERP provider for Google AI Overviews / AI Mode |
| 6 Local | | local matrix, NAP on site | GBP profile + reviews, map grid, citations | GBP API access approval; grid provider |
| 7 Agents · Automation | | 10 agents as jobs, approvals, 11 workflows | Redis queue, agent_runs/workflow_runs, opportunity agent, risk policy incl. critical + auto low-risk, WebSocket | Redis in deployment |
| 8 Implementation | | manual/git/WordPress/API adapters, verify, rollback | Scheduled changes, preview (rendered before/after), static-site adapter for phoenixxit.com repo | Access to the website repository |
| 9 Migration · Experiments | | snapshots, compare, redirect map, experiments | Backlinks + rankings in snapshots, migration_changes, launch-window workflow | Staging URL of the redesign |
| 10 Reporting · White-label · Multi-client | | weekly/initial reports | PDF, templates, branding, client workspaces, monthly/client reports | Brand assets per client |
| 11 Social · Market · PR | | – | Mentions, media monitoring, PR opportunity tracking, pitch drafts | Provider choices |

## Phoenixx IT first-project checklist

| Step | Status |
|---|---|
| Inspect site, identify stack | done – static HTML (Apache), GSAP, Font Awesome, Google Fonts, GA4 `G-7Z9VDR6JRF`; no CMS |
| Crawl all accessible pages | done – 11 URLs (all in sitemap) |
| SEO inventory, metadata, internal links, technical problems | done – `exports/baseline/` + [website-audit.md](../website-audit.md) |
| Migration baseline | done as files; loaded into the migration monitor with `migration-snapshot` once the production DB is set up |
| Connect GSC + GA4 | waiting on service-account access |
| No automatic changes to the live site | enforced – default adapter is `manual` (exports instructions) |
