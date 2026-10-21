import { z } from 'zod';

/** Output schemas per prompt. AI output is ALWAYS validated against these before it is stored. */
const risk = z.enum(['low', 'medium', 'high']);
const intent = z.enum(['informational', 'commercial', 'transactional', 'navigational', 'local']);

export const schemas = {
  'seo-audit': z.object({
    summary: z.string(),
    topPriorities: z.array(z.object({ what: z.string(), why: z.string(), evidence: z.string(), risk, effort: risk, expectedPurpose: z.string() })),
    quickWins: z.array(z.string()),
    watchouts: z.array(z.string()),
  }),
  'keyword-intent': z.object({
    items: z.array(
      z.object({
        keyword: z.string(),
        intent,
        keywordType: z.enum(['primary', 'secondary', 'long_tail', 'local', 'question', 'commercial']),
        confidence: z.number(),
        userProblem: z.string(),
        expectedContent: z.string(),
        recommendedPageType: z.string(),
        recommendedCta: z.string(),
      }),
    ),
  }),
  'keyword-clustering': z.object({
    clusters: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        strategy: z.enum(['single_page', 'separate_pages', 'faq', 'blog', 'existing_page']),
        targetPageUrl: z.string().nullable(),
        rationale: z.string(),
        mergeWithKey: z.string().nullable(),
      }),
    ),
  }),
  'content-gap': z.object({
    items: z.array(
      z.object({
        type: z.enum(['missing_service_page', 'missing_location_page', 'informational', 'faq', 'comparison', 'supporting_article', 'refresh', 'weak_coverage']),
        title: z.string(),
        targetKeyword: z.string(),
        evidence: z.string(),
        rationale: z.string(),
        suggestedUrl: z.string().nullable(),
        priority: z.enum(['high', 'medium', 'low']),
      }),
    ),
  }),
  'title-optimization': z.object({ recommended: z.string(), alternatives: z.array(z.string()), reason: z.string(), expectedPurpose: z.string(), primaryKeyword: z.string() }),
  'meta-description': z.object({ recommended: z.string(), alternatives: z.array(z.string()), reason: z.string(), expectedPurpose: z.string() }),
  'onpage-optimization': z.object({
    recommendations: z.array(
      z.object({
        field: z.enum(['title', 'meta_description', 'h1', 'headings', 'content', 'faq', 'internal_link', 'alt_text', 'schema', 'cta']),
        current: z.string().nullable(),
        recommended: z.string(),
        reason: z.string(),
        expectedPurpose: z.string(),
        risk,
      }),
    ),
    faqs: z.array(z.object({ question: z.string(), answer: z.string(), answerNeedsInput: z.boolean() })),
  }),
  'internal-linking': z.object({
    items: z.array(z.object({ sourceUrl: z.string(), targetUrl: z.string(), keep: z.boolean(), anchorText: z.string(), placement: z.string(), reason: z.string() })),
  }),
  'content-brief': z.object({
    targetKeyword: z.string(),
    searchIntent: z.string(),
    targetAudience: z.string(),
    suggestedTitle: z.string(),
    h1: z.string(),
    metaDescription: z.string(),
    outline: z.array(z.object({ h2: z.string(), h3s: z.array(z.string()), notes: z.string() })),
    entities: z.array(z.string()),
    faqs: z.array(z.object({ question: z.string(), answerGuidance: z.string() })),
    internalLinks: z.array(z.object({ url: z.string(), anchor: z.string(), reason: z.string() })),
    cta: z.string(),
    schemaRecommendations: z.array(z.string()),
    factsNeededFromBusiness: z.array(z.string()),
    wordCountRange: z.string(),
    avoid: z.array(z.string()),
  }),
  'content-draft': z.object({ title: z.string(), slug: z.string(), metaDescription: z.string(), bodyMarkdown: z.string(), placeholders: z.array(z.string()) }),
  'content-quality': z.object({
    verdict: z.enum(['ready_for_review', 'needs_revision', 'reject']),
    intentAlignment: z.number(),
    issues: z.array(z.object({ type: z.string(), quote: z.string(), explanation: z.string(), fix: z.string() })),
    unsupportedClaims: z.array(z.string()),
    summary: z.string(),
  }),
  'local-seo': z.object({
    actions: z.array(
      z.object({
        service: z.string(),
        location: z.string(),
        action: z.enum(['optimize_existing_page', 'add_location_section', 'create_location_page', 'google_business_profile', 'monitor']),
        targetUrl: z.string().nullable(),
        rationale: z.string(),
        evidence: z.string(),
        priority: z.enum(['high', 'medium', 'low']),
      }),
    ),
    napNotes: z.array(z.string()),
    summary: z.string(),
  }),
  'weekly-report': z.object({ headline: z.string(), summary: z.string(), wins: z.array(z.string()), concerns: z.array(z.string()), nextActions: z.array(z.string()) }),
  'recommendation-explain': z.object({ whyItMatters: z.string(), observed: z.array(z.string()), inferred: z.array(z.string()), expectedImpact: z.string(), caveats: z.array(z.string()) }),
} as const;

export type PromptName = keyof typeof schemas;
export type PromptOutput<P extends PromptName> = z.infer<(typeof schemas)[P]>;

/**
 * JSON Schema for provider-side structured output. Constraint keywords that providers
 * may reject are stripped; zod re-validates everything after the call anyway.
 */
export function jsonSchemaFor(name: PromptName): Record<string, unknown> {
  const raw = z.toJSONSchema(schemas[name], { target: 'draft-7' }) as Record<string, unknown>;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== 'object') return node;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (['$schema', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'pattern', 'format', 'minItems', 'maxItems'].includes(k)) continue;
      o[k] = clean(v);
    }
    if (o.type === 'object') {
      o.additionalProperties = false;
      if (o.properties && !o.required) o.required = Object.keys(o.properties as object);
    }
    return o;
  };
  return clean(raw) as Record<string, unknown>;
}
