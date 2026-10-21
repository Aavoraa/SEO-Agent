import { riskForType, type RiskLevel, type BusinessProfile, type CrawledPage, type RecommendationType } from '@phoenixx/shared';
import { localBusinessSchema, organizationSchema, serviceSchema, websiteSchema, validateJsonLd } from './schema.js';
import type { DetectedIssue } from './rules/types.js';
import { pathOf } from './rules/types.js';

/**
 * Turns detected issues into concrete recommendation drafts. Where a fix is fully
 * determined by facts (e.g. valid JSON-LD from the business profile), the proposed
 * value is generated here. Where wording is needed (titles, descriptions), the AI
 * on-page optimizer fills the proposal later. Nothing here is applied automatically.
 */
export interface RecommendationDraft {
  type: RecommendationType;
  title: string;
  what: string;
  why: string;
  currentValue: string | null;
  proposedValue: string | null;
  expectedPurpose: string;
  risk: RiskLevel;
  impact: number;
  effort: number;
  confidence: number;
  needsAiCopy: boolean;
}

const RULE_MAP: Record<string, { type: RecommendationType; impact: number; effort: number; purpose: string }> = {
  missing_title: { type: 'title', impact: 4, effort: 1, purpose: 'Give search engines and users a clear, clickable headline.' },
  title_length: { type: 'title', impact: 2, effort: 1, purpose: 'Avoid truncation and communicate relevance in results.' },
  duplicate_title: { type: 'title', impact: 3, effort: 1, purpose: 'Differentiate pages so each can rank for its own topic.' },
  missing_meta_description: { type: 'meta_description', impact: 2.5, effort: 1, purpose: 'Control the search snippet to improve click-through.' },
  meta_description_length: { type: 'meta_description', impact: 1.5, effort: 1, purpose: 'Keep the snippet complete and persuasive.' },
  duplicate_meta_description: { type: 'meta_description', impact: 1.5, effort: 1, purpose: 'Unique snippets per page.' },
  missing_h1: { type: 'h1', impact: 3, effort: 1, purpose: 'State the page topic clearly for users and search engines.' },
  multiple_h1: { type: 'h1', impact: 1, effort: 1, purpose: 'One unambiguous main heading.' },
  thin_content: { type: 'content', impact: 4, effort: 4, purpose: 'Satisfy search intent with genuinely useful detail.' },
  encoding_errors: { type: 'content', impact: 2.5, effort: 1, purpose: 'Remove visibly broken characters that hurt trust.' },
  images_missing_alt: { type: 'alt_text', impact: 1.5, effort: 1, purpose: 'Accessibility and image understanding.' },
  invalid_structured_data: { type: 'schema', impact: 3, effort: 1, purpose: 'Make the business entity data readable by Google again.' },
  schema_missing_properties: { type: 'schema', impact: 2, effort: 1, purpose: 'Complete structured data so it is eligible and accurate.' },
  homepage_missing_org_schema: { type: 'schema', impact: 3, effort: 1, purpose: 'Connect the site to the Phoenixx IT business entity.' },
  service_page_missing_schema: { type: 'schema', impact: 1.5, effort: 1, purpose: 'Describe the service, provider and area served.' },
  local_business_schema_missing: { type: 'schema', impact: 3, effort: 1, purpose: 'Reinforce the Coimbatore office location for local search.' },
  missing_social_meta: { type: 'other', impact: 1, effort: 1, purpose: 'Correct link previews on WhatsApp/LinkedIn/Facebook.' },
  duplicate_meta_tags: { type: 'technical', impact: 1, effort: 1, purpose: 'Remove ambiguous duplicate head tags.' },
  canonical_issue: { type: 'canonical', impact: 4, effort: 1, purpose: 'Ensure the intended URL is indexed.' },
  missing_canonical: { type: 'canonical', impact: 1.5, effort: 1, purpose: 'Protect against duplicate URL variants.' },
  noindex: { type: 'noindex', impact: 5, effort: 1, purpose: 'Allow an important page to appear in search.' },
  http_error: { type: 'redirect', impact: 4, effort: 2, purpose: 'Recover lost link equity and user journeys.' },
  broken_internal_link: { type: 'internal_link', impact: 3, effort: 1, purpose: 'Fix dead ends for users and crawlers.' },
  internal_link_to_redirect: { type: 'internal_link', impact: 1, effort: 1, purpose: 'Link directly to final URLs.' },
  orphan_page: { type: 'internal_link', impact: 3, effort: 1, purpose: 'Make the page discoverable and pass internal equity.' },
  no_contextual_outlinks: { type: 'internal_link', impact: 2, effort: 1, purpose: 'Connect related services contextually.' },
  robots_disallow_all: { type: 'robots', impact: 5, effort: 1, purpose: 'Restore crawling of the site.' },
  robots_blocks_sitemap_url: { type: 'robots', impact: 3, effort: 1, purpose: 'Resolve conflicting crawl signals.' },
  ai_search_crawlers_blocked: { type: 'robots', impact: 3, effort: 1, purpose: 'Let AI search products fetch, show and cite the site.' },
  sitemap_bad_url: { type: 'sitemap', impact: 2, effort: 1, purpose: 'Keep the sitemap clean and trusted.' },
  indexable_not_in_sitemap: { type: 'sitemap', impact: 1, effort: 1, purpose: 'Help discovery of indexable pages.' },
  sitemap_missing: { type: 'sitemap', impact: 3, effort: 1, purpose: 'Help search engines discover every page.' },
  redirect_chain: { type: 'redirect', impact: 2, effort: 1, purpose: 'Collapse redirect hops.' },
  slow_response: { type: 'technical', impact: 3, effort: 3, purpose: 'Faster pages for users and crawlers.' },
  unverified_claims: { type: 'content', impact: 2, effort: 2, purpose: 'Protect credibility; every claim must be verifiable.' },
  nap_inconsistent: { type: 'content', impact: 2, effort: 1, purpose: 'Consistent business contact details.' },
  location_not_in_service_titles: { type: 'title', impact: 2, effort: 1, purpose: 'Align the title with local search behaviour.' },
};

/** Fix type, impact (0–5) and effort (0–5) for a rule, if the engine knows how to fix it. */
export function ruleFixMeta(ruleId: string): { type: RecommendationType; impact: number; effort: number; purpose: string } | null {
  return RULE_MAP[ruleId] ?? null;
}

export function draftFromIssue(issue: DetectedIssue, page: CrawledPage | undefined, profile: BusinessProfile): RecommendationDraft | null {
  const m = RULE_MAP[issue.ruleId];
  if (!m) return null;
  const base: RecommendationDraft = {
    type: m.type,
    title: issue.title,
    what: issue.recommendation,
    why: issue.description || issue.title,
    currentValue: null,
    proposedValue: null,
    expectedPurpose: m.purpose,
    risk: riskForType(m.type),
    impact: m.impact,
    effort: m.effort,
    confidence: 0.8,
    needsAiCopy: false,
  };
  const path = page ? pathOf(page.finalUrl) : '/';
  const svc = profile.services.find((s) => s.path === path);
  switch (issue.ruleId) {
    case 'missing_title':
    case 'title_length':
    case 'duplicate_title':
    case 'location_not_in_service_titles':
      return { ...base, currentValue: page?.title ?? null, needsAiCopy: true };
    case 'missing_meta_description':
    case 'meta_description_length':
    case 'duplicate_meta_description':
      return { ...base, currentValue: page?.metaDescription ?? null, needsAiCopy: true };
    case 'missing_h1': {
      // Deterministic starting point: the title's topic segment; AI may refine.
      const proposal = page?.title?.split('|')[0]?.trim() ?? page?.h2s[0] ?? null;
      return { ...base, currentValue: page?.h2s[0] ? `(no H1; first heading is H2 "${page.h2s[0]}")` : '(no H1)', proposedValue: proposal, needsAiCopy: !proposal, confidence: 0.7 };
    }
    case 'invalid_structured_data':
    case 'homepage_missing_org_schema': {
      if (path !== '/') return { ...base, currentValue: String(issue.evidence.snippet ?? ''), needsAiCopy: false, confidence: 0.6 };
      const blocks = [organizationSchema(profile), websiteSchema(profile)];
      const lb = localBusinessSchema(profile);
      if (lb) blocks.push(lb);
      const proposed = blocks.map((b) => `<script type="application/ld+json">\n${JSON.stringify(b, null, 2)}\n</script>`).join('\n');
      const valid = blocks.every((b) => validateJsonLd(b).valid);
      return { ...base, type: 'schema', currentValue: String(issue.evidence.snippet ?? '(none)'), proposedValue: proposed, confidence: valid ? 0.9 : 0.5, what: 'Replace the homepage JSON-LD with valid Organization, WebSite and ProfessionalService blocks built from the verified business profile.' };
    }
    case 'local_business_schema_missing': {
      const lb = localBusinessSchema(profile);
      return lb ? { ...base, type: 'schema', proposedValue: `<script type="application/ld+json">\n${JSON.stringify(lb, null, 2)}\n</script>`, currentValue: '(none)' } : null;
    }
    case 'service_page_missing_schema': {
      if (!svc || !page) return null;
      const s = serviceSchema(profile, { name: svc.name, url: page.finalUrl, description: page.metaDescription ?? undefined });
      return { ...base, proposedValue: `<script type="application/ld+json">\n${JSON.stringify(s, null, 2)}\n</script>`, currentValue: '(none)' };
    }
    case 'missing_social_meta':
      if (page?.signals.relativeOgImage) {
        const abs = new URL(page.openGraph['og:image']!, page.finalUrl).toString();
        return { ...base, currentValue: `<meta property="og:image" content="${page.openGraph['og:image']}">`, proposedValue: `<meta property="og:image" content="${abs}">`, confidence: 0.95 };
      }
      return { ...base, needsAiCopy: true };
    case 'images_missing_alt':
      return { ...base, currentValue: ((issue.evidence.images as string[]) ?? []).slice(0, 10).join('\n'), needsAiCopy: true };
    case 'encoding_errors':
      return { ...base, what: 'Re-save the page source as UTF-8 and replace garbled sequences (â€” → —, â€™ → ’).', currentValue: `${issue.evidence.count} garbled sequence(s)` };
    default:
      return base;
  }
}
