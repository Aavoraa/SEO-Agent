import type { AIProvider, CompletionRequest, CompletionResult } from './providers.js';

/**
 * Deterministic MOCK provider for demo mode and tests. It never calls a network API and
 * every output is prefixed/marked so it cannot be mistaken for real AI analysis.
 * It builds schema-valid responses from the request variables.
 */
const TAG = '[DEMO – mock AI]';

type Vars = Record<string, any>;

const parse = (v: unknown): any => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

function titleCase(s: string) {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

const builders: Record<string, (v: Vars) => unknown> = {
  'seo-audit': (v) => ({
    summary: `${TAG} The site has ${String(v.issues ?? '').split('\n').filter(Boolean).length} issue groups. Fix headings, structured data and encoding first; they are quick and low risk.`,
    topPriorities: [
      { what: 'Add a single descriptive H1 to every service page', why: 'Service pages currently start with an H2', evidence: 'missing_h1 on service pages', risk: 'low', effort: 'low', expectedPurpose: 'Clarify page topic' },
      { what: 'Replace invalid homepage JSON-LD', why: 'The Organization block fails to parse', evidence: 'invalid_structured_data on /', risk: 'low', effort: 'low', expectedPurpose: 'Make entity data readable' },
    ],
    quickWins: ['Fix garbled characters on service pages', 'Use an absolute og:image URL'],
    watchouts: ['Keep every existing URL or 301-redirect it during the redesign'],
  }),
  'keyword-intent': (v) => ({
    items: (parse(v.queries) as any[] ?? []).map((q) => ({
      keyword: q.keyword,
      intent: q.intent ?? 'commercial',
      keywordType: q.keywordType ?? 'secondary',
      confidence: Math.min(0.9, (q.confidence ?? 0.5) + 0.1),
      userProblem: `${TAG} Searcher wants help with "${q.keyword}"`,
      expectedContent: 'Service overview with process and FAQs',
      recommendedPageType: q.intent === 'informational' ? 'blog_article' : 'service_page',
      recommendedCta: 'Talk to Phoenixx IT',
    })),
  }),
  'keyword-clustering': (v) => ({
    clusters: (parse(v.clusters) as any[] ?? []).map((c) => ({ key: c.key, name: c.name, strategy: c.strategy, targetPageUrl: c.targetPageUrl ?? null, rationale: `${TAG} ${c.rationale ?? ''}`, mergeWithKey: null })),
  }),
  'content-gap': (v) => ({
    items: (parse(v.clusters) as any[] ?? []).slice(0, 5).map((c) => ({
      type: c.intent === 'informational' ? 'informational' : 'weak_coverage',
      title: `${TAG} ${titleCase(c.name ?? c.keywords?.[0] ?? 'Topic')}`,
      targetKeyword: c.keywords?.[0] ?? c.name,
      evidence: `${c.totalImpressions ?? 0} impressions across ${c.keywords?.length ?? 0} queries`,
      rationale: 'Queries show demand but no page fully serves the intent.',
      suggestedUrl: null,
      priority: (c.totalImpressions ?? 0) > 500 ? 'high' : 'medium',
    })),
  }),
  'title-optimization': (v) => {
    const cur = String(v.currentTitle ?? '');
    const topic = cur.split('|')[0]!.trim() || 'IT Services';
    return { recommended: `${topic} | Phoenixx IT`.slice(0, 70), alternatives: [`${topic} – Coimbatore | Phoenixx IT`, `${topic} Services | Phoenixx IT`], reason: `${TAG} Leads with the page topic seen in top queries.`, expectedPurpose: 'Improve relevance and CTR for existing impressions', primaryKeyword: topic.toLowerCase() };
  },
  'meta-description': (v) => ({
    recommended: `${String(v.title ?? 'Phoenixx IT').split('|')[0]!.trim()} from Phoenixx IT in Coimbatore. See how we work, what's included and talk to our team today.`.slice(0, 158),
    alternatives: ['Talk to Phoenixx IT about your project – services, process and next steps.'],
    reason: `${TAG} Summarises the page and ends with a CTA.`,
    expectedPurpose: 'Improve snippet relevance and click-through',
  }),
  'onpage-optimization': (v) => {
    const page = parse(v.page) ?? {};
    const topic = String(page.title ?? '').split('|')[0]!.trim() || 'Our Services';
    return {
      recommendations: [
        { field: 'h1', current: page.h1s?.[0] ?? null, recommended: topic, reason: `${TAG} Page has no H1; use the page topic.`, expectedPurpose: 'Clarify page topic', risk: 'low' },
        { field: 'internal_link', current: null, recommended: 'Link to related services (e.g. Digital Marketing ↔ Performance Marketing)', reason: 'Service pages do not cross-link', expectedPurpose: 'Topical connections and crawl paths', risk: 'low' },
        { field: 'faq', current: null, recommended: 'Add 4–6 FAQs answering process, timeline and engagement questions', reason: 'Questions appear in Search Console', expectedPurpose: 'Cover informational sub-intents', risk: 'low' },
      ],
      faqs: [{ question: `How does Phoenixx IT approach ${topic.toLowerCase()}?`, answer: '', answerNeedsInput: true }],
    };
  },
  'internal-linking': (v) => ({
    items: (parse(v.suggestions) as any[] ?? []).map((s) => ({ sourceUrl: s.sourceUrl, targetUrl: s.targetUrl, keep: true, anchorText: s.anchorText, placement: 'Section describing related services', reason: `${TAG} ${s.reason}` })),
  }),
  'content-brief': (v) => {
    const kw = String(v.keyword ?? 'it services');
    return {
      targetKeyword: kw,
      searchIntent: String(v.intent ?? 'commercial'),
      targetAudience: 'Business owners and marketing managers in Coimbatore evaluating a technology partner',
      suggestedTitle: `${titleCase(kw)} | Phoenixx IT`,
      h1: titleCase(kw),
      metaDescription: `${titleCase(kw)} explained by Phoenixx IT, Coimbatore – what it involves, how to choose a partner and next steps.`,
      outline: [
        { h2: `What ${kw} involves`, h3s: ['Scope', 'Deliverables'], notes: `${TAG} Explain plainly.` },
        { h2: 'How the process works', h3s: ['Discovery', 'Build', 'Launch & support'], notes: 'Use Phoenixx IT process only if confirmed.' },
        { h2: 'How to choose a partner', h3s: ['Questions to ask'], notes: 'Neutral, practical criteria.' },
      ],
      entities: ['requirements', 'timeline', 'budget factors', 'maintenance'],
      faqs: [{ question: `How long does ${kw} take?`, answerGuidance: 'Needs input from Phoenixx IT' }],
      internalLinks: [{ url: '/website-design-development', anchor: 'website design and development', reason: 'Related service' }],
      cta: 'Talk to Phoenixx IT',
      schemaRecommendations: ['Article', 'BreadcrumbList'],
      factsNeededFromBusiness: ['Typical project timeline', 'Engagement models offered'],
      wordCountRange: '1,000–1,500',
      avoid: ['Invented statistics', 'Guarantees', 'Client names without permission'],
    };
  },
  'content-draft': (v) => {
    const b = parse(v.brief) ?? {};
    const kw = b.targetKeyword ?? 'IT services';
    const sections = (b.outline ?? []).map((o: any) => `## ${o.h2}\n\n${o.h3s?.map((h: string) => `### ${h}\n\n[NEEDS INPUT: details about ${h.toLowerCase()} from Phoenixx IT]\n`).join('\n') ?? ''}`).join('\n');
    return {
      title: b.suggestedTitle ?? kw,
      slug: String(kw).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      metaDescription: b.metaDescription ?? '',
      bodyMarkdown: `> ${TAG} This is placeholder demo content, not a real draft.\n\n# ${b.h1 ?? kw}\n\nIf you are researching ${kw}, this page explains what is involved and how Phoenixx IT in Coimbatore can help.\n\n${sections}\n\nSee also our [website design and development](/website-design-development) and [digital marketing](/digital-marketing) services.\n\n**Ready to discuss your project? [Talk to Phoenixx IT](/#contact).**`,
      placeholders: (b.factsNeededFromBusiness ?? []).map(String),
    };
  },
  'content-quality': () => ({ verdict: 'needs_revision', intentAlignment: 3, issues: [{ type: 'placeholder', quote: '[NEEDS INPUT', explanation: `${TAG} Draft contains placeholders requiring business input.`, fix: 'Fill placeholders with verified facts' }], unsupportedClaims: [], summary: `${TAG} Structure is fine; facts must be supplied.` }),
  'local-seo': (v) => ({
    actions: (parse(v.matrix) as any[] ?? []).filter((c) => c.action !== 'no_action').slice(0, 6).map((c) => ({ service: c.serviceName, location: c.locationName, action: c.action === 'create_location_page' ? 'create_location_page' : c.action === 'monitor' ? 'monitor' : c.action === 'add_location_section' ? 'add_location_section' : 'optimize_existing_page', targetUrl: c.coveringPage ?? null, rationale: `${TAG} ${c.rationale}`, evidence: `${c.impressions} impressions`, priority: c.impressions > 300 ? 'high' : 'medium' })),
    napNotes: ['Keep the Vadavalli address and +91 93427 21163 identical across the site and Google Business Profile.'],
    summary: `${TAG} Strengthen existing service pages for Coimbatore before creating new pages.`,
  }),
  'recommendation-explain': (v) => ({
    whyItMatters: `${TAG} ${String(v.rationale ?? 'This check reflects a common SEO best practice.')}`,
    observed: String(v.evidence ?? '').split(/\r?\n/).filter((l) => l.trim()).slice(0, 5),
    inferred: ['Fixing this is likely to make the affected pages clearer to search engines and visitors.'],
    expectedImpact: 'May improve how these pages are understood and shown in search. No ranking change is guaranteed.',
    caveats: ['Mock AI output (demo mode) – the observed facts are copied from the evidence, the rest is canned text.'],
  }),
  'weekly-report': (v) => ({ headline: `${TAG} Weekly SEO summary for ${v.period ?? 'this week'}`, summary: 'Demo summary generated from sample data. Real reports summarise actual Search Console and crawl data.', wins: ['Sample win'], concerns: ['Sample concern'], nextActions: ['Review pending approvals'] }),
};

export class MockProvider implements AIProvider {
  readonly name = 'mock' as const;
  readonly defaultModel = 'mock';
  async complete(req: CompletionRequest & { vars?: Vars }): Promise<CompletionResult> {
    const build = builders[req.schemaName];
    if (!build) throw new Error(`Mock provider has no builder for ${req.schemaName}`);
    const text = JSON.stringify(build(req.vars ?? {}));
    return { text, model: 'mock', inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4), stopReason: 'end_turn' };
  }
}
