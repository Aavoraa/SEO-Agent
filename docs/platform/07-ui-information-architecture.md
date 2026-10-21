# 7 · UI information architecture

## 7.1 Design stance

Minimal, technical, data-rich but calm. Each screen answers, top to bottom:

1. **What happened?** – one headline number or change, with its data label (Verified / Estimated / Modeled / Demo).
2. **Why?** – the evidence that produced it.
3. **How important?** – priority badge + score with reasons on hover.
4. **What should I do?** – the recommendation, one primary action.
5. **Can Phoenixx automate it?** – "Approve & implement", "Needs admin", or "Manual – export instructions".

Progressive disclosure: summary cards → table → row expansion → raw data/export. No screen shows a number
without a source; missing providers render a single **Integration required** card linking to Integrations.
No generic AI-dashboard visuals (gradients, sparkles, chat bubbles as decoration).

## 7.2 Navigation (sidebar groups)

Sidebar entries today are flat; they are grouped as modules arrive. ✓ = built.

```
Home            Overview ✓ · Search Performance ✓ · Alerts ✓
Act             Recommendations ✓ · Approval Center ✓ · Change Log ✓ · Experiments ✓
Technical       Site Audit (Issues ✓) · Pages ✓ · Core Web Vitals (P2) · Indexation (P2) · Schema (in Issues/Pages ✓)
Keywords        Keywords ✓ · Rank Tracking (P3) · SERP (P3)
Content         Content ✓ (gaps, briefs, drafts) · Internal Links ✓ · Calendar (P4)
Links           Backlinks ✓ · Audit (P4) · Link Gap (P4) · Opportunities (P4)
Competitors     Competitors ✓ · Keyword/Backlink/AI gaps (P3–P5)
AI Search       Visibility · Prompts · Citations · Sentiment (P5) · AI Readiness (Phase 1 ✓)
Local           Local SEO ✓ · Profile/Reviews/Map grid (P6)
Protect         Migration Monitor ✓
Reports         Reports ✓ · White-label (P10)
Platform        Integrations (Phase 1 ✓) · AI Usage ✓ · Settings ✓ (project, members, rules, users, API keys)
```

Project switcher (top bar) lists only projects the user is a member of; the demo project is visually
distinct and every demo screen carries the **DEMO – sample data** banner.

## 7.3 Screen templates

| Template | Used by | Layout |
|---|---|---|
| Module overview | Overview, Backlinks, Local, AI Search | headline KPIs (≤5) → "needs attention" list → detail tables |
| Worklist | Issues, Recommendations, Approvals | filter bar → sortable table → expandable evidence → action bar |
| Entity detail | Page, Keyword, Change | header facts → timeline → related recommendations |
| Comparison | Migration, Competitors, gaps | two-column diff with severity, export |
| Setup | Integrations, Settings | status list, one action per row |

## 7.4 Shared components

`Stat`, `Card`, `DataTable` (sort, expand, CSV), `Tabs`, `FilterBar`, `PriorityBadge`, `RiskBadge`,
`StatusPill`, `JobButton` (run + progress), `EmptyState`, `ErrorBox`, **`DataLabel`** and
**`IntegrationRequired`** (Phase 1). New primitives follow shadcn/ui conventions (Radix-based,
accessible, Tailwind tokens) as they are introduced; existing ones are migrated when their screen is rebuilt.
