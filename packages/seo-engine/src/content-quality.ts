import { tokenize, round } from '@phoenixx/shared';

/**
 * Deterministic content quality checks run BEFORE any draft reaches the approval queue.
 * An optional AI review (content-quality prompt) can add judgement on top, but these
 * checks never depend on the AI being available.
 */
export interface QualityCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
}

export interface QualityReport {
  score: number;
  verdict: 'ready_for_review' | 'needs_revision' | 'reject';
  checks: QualityCheck[];
  metrics: {
    words: number;
    sentences: number;
    avgSentenceLength: number;
    fleschReadingEase: number;
    keywordDensity: number;
    repeatedTrigramRatio: number;
    internalLinks: number;
    headings: number;
  };
  flaggedClaims: string[];
  genericPhrases: string[];
}

// Phrases that signal filler/AI-generic writing. Configurable via opts.extraGenericPhrases.
const GENERIC = [
  "in today's fast-paced",
  "in today's digital",
  'digital landscape',
  'ever-evolving',
  'ever-changing',
  'unlock the power',
  'unleash',
  'look no further',
  'game-changer',
  'game changer',
  'cutting-edge solutions',
  'seamless experience',
  'delve into',
  'dive deep',
  'elevate your',
  'in conclusion',
  'it is important to note',
  "it's important to note",
  'navigate the complexities',
  'robust solutions',
  'tailored solutions',
  'one-stop solution',
  'second to none',
  'take your business to the next level',
  'world-class',
  'best-in-class',
  'revolutionize',
  'harness the power',
];

const CLAIM_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\b\d{1,3}(?:\.\d+)?\s?%/g, label: 'percentage statistic' },
  { re: /\b\d{2,}\+?\s+(?:clients|projects|customers|businesses|brands|years)\b/gi, label: 'count/experience claim' },
  { re: /\b(?:#1|number one|no\.\s?1|leading|top-rated|best)\s+(?:company|agency|provider|firm)\b/gi, label: 'ranking/superlative claim' },
  { re: /\bguarantee(?:d|s)?\b[^.]{0,40}\b(?:rank|ranking|first page|results|traffic|leads)\b/gi, label: 'guarantee of results' },
  { re: /\b(?:certified|award[- ]winning|iso \d+|google partner|meta partner)\b/gi, label: 'certification/award claim' },
  { re: /\baccording to (?:a |the )?(?:study|survey|report|research)\b/gi, label: 'uncited research reference' },
  { re: /\b(?:testimonial|case study)\b[^.]{0,60}\b(?:increased|grew|boosted)\b/gi, label: 'case-study result claim' },
];

function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '').replace(/^y/, '').match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups?.length ?? 1);
}

export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>|]/g, ' ');
}

export function checkContentQuality(
  input: { title: string; bodyMarkdown: string; targetKeyword: string; intent?: string; requiredCta?: string[]; allowedFacts?: string[]; metaDescription?: string },
  opts: { minWords?: number; maxKeywordDensity?: number; extraGenericPhrases?: string[] } = {},
): QualityReport {
  const text = stripMarkdown(input.bodyMarkdown);
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().split(/\s+/).length >= 3);
  const avgSentence = sentences.length ? words.length / sentences.length : words.length;
  const syl = words.reduce((s, w) => s + syllables(w), 0);
  const flesch = words.length ? round(206.835 - 1.015 * avgSentence - 84.6 * (syl / words.length), 1) : 0;

  const kw = input.targetKeyword.toLowerCase().trim();
  const kwCount = kw ? lower.split(kw).length - 1 : 0;
  const kwDensity = words.length ? round(((kwCount * kw.split(/\s+/).length) / words.length) * 100, 2) : 0;

  const toks = tokenize(text, { keepStopwords: true });
  const tri = new Map<string, number>();
  for (let i = 0; i + 2 < toks.length; i++) {
    const k = `${toks[i]} ${toks[i + 1]} ${toks[i + 2]}`;
    tri.set(k, (tri.get(k) ?? 0) + 1);
  }
  const repeated = [...tri.values()].filter((n) => n > 2).reduce((s, n) => s + n, 0);
  const repeatedRatio = toks.length ? round(repeated / toks.length, 3) : 0;

  const paragraphs = input.bodyMarkdown.split(/\n\s*\n/).map((p) => p.trim().toLowerCase()).filter((p) => p.length > 80);
  const dupParas = paragraphs.length - new Set(paragraphs).size;

  const internalLinks = (input.bodyMarkdown.match(/\]\((\/[^)]*|https?:\/\/(?:www\.)?phoenixxit\.com[^)]*)\)/gi) ?? []).length;
  const headings = (input.bodyMarkdown.match(/^#{2,3}\s+/gm) ?? []).length;
  const generic = [...GENERIC, ...(opts.extraGenericPhrases ?? [])].filter((g) => lower.includes(g));
  const facts = (input.allowedFacts ?? []).join(' ').toLowerCase();
  const flaggedClaims = CLAIM_PATTERNS.flatMap(({ re, label }) => (text.match(re) ?? []).map((m) => `${label}: "${m.trim()}"`)).filter((c) => !facts.includes(c.split('"')[1]!.toLowerCase()));
  const ctas = input.requiredCta?.length ? input.requiredCta : ['contact', 'talk to', 'get in touch', 'consultation', 'call', 'enquire', 'book'];
  const hasCta = ctas.some((c) => lower.includes(c.toLowerCase()));
  const titleTokens = new Set(tokenize(input.title));
  const bodyTokens = new Set(tokenize(text));
  const titleOverlap = titleTokens.size ? [...titleTokens].filter((t) => bodyTokens.has(t)).length / titleTokens.size : 0;
  const minWords = opts.minWords ?? 600;
  const maxDensity = opts.maxKeywordDensity ?? 2.5;

  const checks: QualityCheck[] = [
    { id: 'length', label: 'Sufficient depth', status: words.length >= minWords ? 'pass' : words.length >= minWords * 0.6 ? 'warn' : 'fail', detail: `${words.length} words (target ≥ ${minWords})` },
    { id: 'keyword_stuffing', label: 'No keyword stuffing', status: kwDensity <= maxDensity ? 'pass' : kwDensity <= maxDensity * 1.6 ? 'warn' : 'fail', detail: `"${kw}" density ${kwDensity}% (${kwCount}×)` },
    { id: 'keyword_present', label: 'Target keyword used naturally', status: kwCount >= 1 ? 'pass' : 'warn', detail: kwCount ? `Appears ${kwCount}×` : 'Exact phrase not found (variants may be fine)' },
    { id: 'readability', label: 'Readability', status: flesch >= 40 ? 'pass' : flesch >= 25 ? 'warn' : 'fail', detail: `Flesch reading ease ${flesch}; avg sentence ${round(avgSentence, 1)} words` },
    { id: 'repetition', label: 'Low repetition', status: repeatedRatio < 0.06 && dupParas === 0 ? 'pass' : repeatedRatio < 0.12 ? 'warn' : 'fail', detail: `${round(repeatedRatio * 100, 1)}% repeated trigrams; ${dupParas} duplicate paragraph(s)` },
    { id: 'unsupported_claims', label: 'No unsupported claims', status: flaggedClaims.length === 0 ? 'pass' : flaggedClaims.length <= 2 ? 'warn' : 'fail', detail: flaggedClaims.length ? flaggedClaims.slice(0, 5).join('; ') : 'None detected' },
    { id: 'generic_language', label: 'Specific, non-generic language', status: generic.length === 0 ? 'pass' : generic.length <= 2 ? 'warn' : 'fail', detail: generic.length ? `Generic phrases: ${generic.join(', ')}` : 'None detected' },
    { id: 'cta', label: 'Clear call to action', status: hasCta ? 'pass' : 'fail', detail: hasCta ? 'CTA present' : 'No CTA found' },
    { id: 'internal_links', label: 'Internal links', status: internalLinks >= 2 ? 'pass' : internalLinks === 1 ? 'warn' : 'fail', detail: `${internalLinks} internal link(s)` },
    { id: 'structure', label: 'Heading structure', status: headings >= 3 ? 'pass' : headings >= 1 ? 'warn' : 'fail', detail: `${headings} H2/H3 heading(s)` },
    { id: 'title_match', label: 'Title matches content', status: titleOverlap >= 0.6 ? 'pass' : titleOverlap >= 0.35 ? 'warn' : 'fail', detail: `${round(titleOverlap * 100, 0)}% of title terms appear in body` },
  ];
  if (input.metaDescription !== undefined) {
    const l = input.metaDescription.length;
    checks.push({ id: 'meta', label: 'Meta description length', status: l >= 70 && l <= 160 ? 'pass' : 'warn', detail: `${l} characters` });
  }
  const pts = checks.reduce((s, c) => s + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  const score = Math.round((pts / checks.length) * 100);
  const fails = checks.filter((c) => c.status === 'fail').map((c) => c.id);
  const verdict = fails.includes('unsupported_claims') || fails.includes('keyword_stuffing') || score < 50 ? (score < 35 ? 'reject' : 'needs_revision') : fails.length ? 'needs_revision' : 'ready_for_review';
  return {
    score,
    verdict,
    checks,
    metrics: { words: words.length, sentences: sentences.length, avgSentenceLength: round(avgSentence, 1), fleschReadingEase: flesch, keywordDensity: kwDensity, repeatedTrigramRatio: repeatedRatio, internalLinks, headings },
    flaggedClaims,
    genericPhrases: generic,
  };
}
