# 9 · Competitive matrix (as of September 2026)

Competitor data comes from vendor pages and documentation researched on 28 Sep 2026. Where a claim is backed
only by a third-party review it is marked (3P). "Unconfirmed" means we could not verify it. Market note: Adobe
completed its acquisition of Semrush on 28 Apr 2026; Semrush AI-search data is being combined with Adobe LLM
Optimizer. Sources are listed at the end.

**Status column (our platform):** Implemented · Partial · Planned · **Provider** (needs a licensed data provider;
the adapter interface exists or is planned, and nothing is shown until it is connected).

## 9.1 Capability matrix

| Capability | Semrush | Ahrefs | SE Ranking | Moz Pro | Surfer | seoClarity | **Our platform** | Status |
|---|---|---|---|---|---|---|---|---|
| Site audit / crawler | Yes (JS on higher tiers) | Yes (JS option) | Yes (JS optional) | Yes | Partial (page-level) | Yes (enterprise) | Crawler: 56 rules, 10-category scorecard, desktop/mobile, security headers, AI-crawler access. No JS rendering yet | Implemented (JS rendering planned) |
| Audit → fix → deploy → verify | Partial (WordPress articles; Adobe LLMO edge) | Yes: Patches (JS snippet / Cloudflare Worker), rollback | Partial (WordPress articles) | No | Partial (CMS publishing) | Yes: ClarityAutomate at the edge; rollback Unconfirmed | Server-side HTML changes via SFTP/FTPS/Git/WordPress/API with backup, checksum, field-by-field verification, automatic restore and rollback | **Implemented, differentiator** |
| Keyword research database | Yes | Yes | Yes | Yes | Partial | Yes | GSC-based discovery, intent, clustering, cannibalisation; volume/CPC/difficulty only via provider | Partial + **Provider** |
| Rank tracking (local/mobile) | Yes | Yes | Yes | Yes | Partial | Yes | GSC average position today; daily device/location tracking via SERP provider | Planned + **Provider** |
| SERP analysis | Yes | Yes | Yes | Yes | Yes | Yes | – | Planned + **Provider** |
| Content editor / optimisation | Yes | Yes | Yes | Partial | Yes | Yes | AI briefs, drafts, quality check, on-page fixes with approval | Partial |
| Content audit / decay | Unconfirmed | Yes | Unconfirmed | No | Partial | Partial | Declining-query detection + refresh opportunities (GSC) | Partial |
| Backlink index | Yes | Yes | Yes | Yes | No | Partial (Majestic, 3P) | Own live verification of imported/provider links; no own index | **Provider** (+ Implemented verification) |
| Link building outreach | Yes | Partial | Unconfirmed | Partial | No | Unconfirmed | Broken-link recovery (301s) implemented; outreach drafts planned (never auto-sent) | Partial |
| Local SEO / GBP / reviews | Yes | Partial | Partial | Partial (Moz Local) | No | Partial | On-site local matrix, NAP, LocalBusiness schema; GBP/reviews/grid planned | Partial + **Provider** |
| AI visibility tracking | Yes (6–9 engines) | Yes (Brand Radar) | Yes (5 engines) | Partial (beta) | Yes | Yes (9 engines) | AI readiness (crawler access, structure); prompt tracking planned via official APIs / DataForSEO LLM APIs | Partial + **Provider** |
| AI citation analysis | Yes | Yes | Yes | Partial | Partial | Yes | Planned (citation → content recommendation → deploy → re-measure) | Planned |
| Competitor traffic estimates | Yes | Partial | Partial | Unconfirmed | No | Partial | Labelled "Estimated" only when a provider is connected | **Provider** |
| Reporting / white-label | Yes | Partial | Yes (3P) | Partial | Partial | Yes | PDF/HTML/MD reports, share links, org branding (white-label plan feature) | Partial |
| API access | Yes (units) | Yes (from Lite) | Yes | Yes | Partial | Yes | REST API, org/project-scoped keys, signed webhooks (12 events) | Implemented |
| SEO A/B testing | Partial (SplitSignal) | No | No | No | No | Yes | Before/after experiments (correlation, labelled); controlled split tests planned | Partial |
| Agency / client portal | Yes | No | Yes (3P) | No | No | Partial | Organizations, 8 roles incl. client, invitations, per-org plans | Partial (client portal UI planned) |

## 9.2 Who deploys SEO changes today, and how

| Platform | Mechanism | Verification | Rollback |
|---|---|---|---|
| Ahrefs Patches | JS snippet (only JS-executing bots see changes) or Cloudflare Worker | Site Audit recrawl detects the patch | Yes |
| seoClarity ClarityAutomate | "Single line of code" / edge; details not public | Split-test measurement | Unconfirmed |
| Adobe LLM Optimizer | CDN edge; serves AI agents only; also AEM | "View live", routing checks | Yes |
| Search Atlas OTTO | JS pixel or plugin; **deploys on its own by default** | Vendor-claimed change logs | Yes |
| Frase Content Guard | CMS API republish (WordPress, Webflow, Sanity, Wix) after approval | GSC monitoring | Unconfirmed |
| **Our platform** | **Changes the real HTML at the source**: SFTP/FTPS/local files, Git branch, WordPress/API. Every visitor, search bot and AI crawler sees the same page | Re-fetches the live page and compares every SEO field against the expected state; verification failures are flagged and re-checked | **Byte-exact backup restore** (or an element-level revert if the file changed since), then verified |

**What this shows:**
- Nobody in the set above deploys through Git, SFTP or files.
- None of them combines checking the live HTML after a deploy with an audit re-score and outcome measurement that feeds back into prioritisation. SearchPilot and seoClarity measure outcomes only inside A/B tests.
- JS injection has a known gap: bots that don't run JavaScript miss the change (Ahrefs' own documentation says so).

**Honest limits of our approach:**
- It needs write access (credentials, or a CMS app password).
- It doesn't yet support Shopify, Webflow or edge deployment.

## 9.3 Where we stand

| | |
|---|---|
| **Parity** | Technical audit depth for server-rendered sites; audit history and comparison; PDF reports; API and webhooks; multi-user roles; internal-link analysis; GSC/GA4 performance. |
| **Differentiation** | Closed loop: opportunity → explanation from recorded evidence → AI fix → preview → approval policy by risk → deployment at the source → field-level live verification → re-score → rollback → decisions feed the priority memory. A documented, deterministic priority formula. Data labels (Verified / Estimated / Modeled / Unavailable / Demo) on every number. Automation levels 0–4 that never auto-approve high-risk changes. |
| **Stronger (by design, not by claim)** | Deployment and verification are the most complete of the tools compared: source-level changes, backups, checksums, automatic restore and rollback verification. AI output always shows the evidence it was given. |
| **Depend on third-party data** | Keyword volume, CPC and difficulty; SERP and rank tracking; backlink index and link gap; competitor traffic; AI answer and citation tracking; map-grid rankings. |

**Recommended providers:**
- **DataForSEO** (pay-as-you-go, resale-friendly): SERP including AI Overviews, keyword data, Labs, backlinks, and the AI Optimization/LLM APIs.
- **Google Ads API**: Keyword Planner, which needs Basic access.
- **Majestic OpenApps**: backlinks.
- **Similarweb API**: traffic, estimated, sold through sales.
- **GSC and Bing Webmaster**: first-party ground truth.

SerpApi is in active litigation with Google (the case is still open as of Aug 2026), so assess the risk before using it.

## 9.4 "One step ahead": the action layer per capability

| Market capability | Our next layer |
|---|---|
| Audit | + explanation from evidence + priority score + fix generation + preview + risk-based approval + deploy + field-level verify + re-score |
| Keyword research | + intent + business value + page mapping + "optimize this page" opportunity + execution |
| Content optimisation | + approval + publishing through the connected adapter + post-publication measurement |
| Backlink analysis | + live verification + broken-target recovery via approved 301s (outreach drafts planned, never auto-sent) |
| AI visibility | + readiness fixes you can deploy today; citation → recommendation → deploy → re-measure (Phase 5) |

## Sources

- Adobe/Semrush: news.adobe.com/news/2026/04/adobe-completes-semrush-acquisition
- Ahrefs Patches: ahrefs.com/patches; help.ahrefs.com/en/articles/9775727-how-patches-work-in-site-audit
- seoClarity: seoclarity.net/seo-automation/ (plus page-optimizer and seo-split-testing-tool)
- Adobe LLM Optimizer: experienceleague.adobe.com/en/docs/llm-optimizer/using/resources/optimize-at-edge/overview
- Search Atlas OTTO: searchatlas.com/otto-pixel/
- Frase: frase.io/pricing
- Semrush: semrush.com/kb/1626-ai-visibility-features; semrush.com/kb/1145-splitsignal
- SE Ranking: seranking.com/ai-visibility-tracker.html; seranking.com/api-pricing.html
- Surfer: surferseo.com/pricing/
- Moz (3P): thenextweb.com/news/moz-pro-ai-visibility-chatgpt-gemini-tracking
- DataForSEO: dataforseo.com/pricing; dataforseo.com/apis/ai-optimization-api
- Majestic: majestic.com/plans-pricing
- Google Ads API: developers.google.com/google-ads/api/docs/api-policy/access-levels
- SerpApi litigation: theregister.com/2026/02/21/serpapi_google_scraping_lawsuit/
