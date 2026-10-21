import { detectLocations, detectServices, DEFAULT_BUSINESS_PROFILE, type BusinessProfile, type Intent, type KeywordType } from '@phoenixx/shared';

export function normalizeKeyword(q: string): string {
  return q
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[“”"']/g, '')
    .replace(/[^\p{L}\p{N}\s&+.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const QUESTION = /^(how|what|why|when|where|which|who|is|are|can|does|do|should|will|cost of|price of)\b|\?$/;
const TRANSACTIONAL = /\b(hire|buy|price|pricing|cost|quote|quotation|package|packages|plans|rates|charges|fees|book|order|get a|near me|free consultation|contact)\b/;
const COMMERCIAL = /\b(best|top|company|companies|agency|agencies|services?|firm|provider|providers|developers?|experts?|consultants?|freelancer|vs|versus|compare|comparison|review|reviews|alternatives?|affordable|cheap)\b/;
const INFORMATIONAL = /\b(how|what|why|guide|tutorial|tips|examples?|ideas|meaning|definition|benefits|learn|course|steps|checklist|trends|vs)\b/;
const LOCAL_HINT = /\b(near me|nearby|in my area)\b/;

export interface IntentResult {
  intent: Intent;
  confidence: number;
  signals: string[];
  services: string[];
  locations: string[];
  isQuestion: boolean;
  isBranded: boolean;
}

/**
 * Rule-based first pass. Deterministic, free and explainable; the AI keyword-intent
 * prompt can refine low-confidence results in batches.
 */
export function classifyIntent(query: string, profile: BusinessProfile = DEFAULT_BUSINESS_PROFILE, brandTerms: string[] = ['phoenixx', 'phoenix it', 'phoenixxit', 'phoenixx it']): IntentResult {
  const q = normalizeKeyword(query);
  const services = detectServices(q, profile.services);
  const locations = detectLocations(q, profile.locations);
  const isQuestion = QUESTION.test(q);
  const isBranded = brandTerms.some((b) => q.includes(b));
  const signals: string[] = [];
  let intent: Intent;
  let confidence: number;
  if (isBranded) {
    intent = 'navigational';
    confidence = 0.95;
    signals.push('brand term');
  } else if ((locations.length || LOCAL_HINT.test(q)) && (services.length || COMMERCIAL.test(q))) {
    intent = 'local';
    confidence = 0.85;
    signals.push(locations.length ? `location: ${locations.join(', ')}` : 'near-me modifier', services.length ? `service: ${services.join(', ')}` : 'commercial modifier');
  } else if (TRANSACTIONAL.test(q)) {
    intent = 'transactional';
    confidence = 0.75;
    signals.push('transactional modifier');
  } else if (isQuestion || (INFORMATIONAL.test(q) && !COMMERCIAL.test(q))) {
    intent = 'informational';
    confidence = isQuestion ? 0.85 : 0.65;
    signals.push(isQuestion ? 'question form' : 'informational modifier');
  } else if (COMMERCIAL.test(q) || services.length) {
    intent = 'commercial';
    confidence = COMMERCIAL.test(q) ? 0.75 : 0.55;
    signals.push(COMMERCIAL.test(q) ? 'commercial modifier' : 'service term');
  } else {
    intent = 'informational';
    confidence = 0.4;
    signals.push('no strong modifier');
  }
  return { intent, confidence, signals, services, locations, isQuestion, isBranded };
}

export function classifyKeywordType(query: string, r: IntentResult, metrics?: { impressions: number }): KeywordType {
  const words = normalizeKeyword(query).split(' ').length;
  if (r.isQuestion) return 'question';
  if (r.intent === 'local') return 'local';
  if (words >= 5) return 'long_tail';
  if (r.intent === 'commercial' || r.intent === 'transactional') return words <= 3 && (metrics?.impressions ?? 0) > 100 ? 'primary' : 'commercial';
  return words <= 2 ? 'primary' : 'secondary';
}

export interface SearchIntentProfile {
  intent: Intent;
  userProblem: string;
  expectedContent: string;
  recommendedPageType: 'service_page' | 'location_section' | 'blog_article' | 'faq_entry' | 'comparison_article' | 'homepage' | 'contact_page' | 'case_study';
  recommendedCta: string;
}

/** Search intent engine – rule-based defaults; the AI can enrich userProblem/expectedContent. */
export function searchIntentProfile(query: string, r: IntentResult, profile: BusinessProfile = DEFAULT_BUSINESS_PROFILE): SearchIntentProfile {
  const svc = profile.services.find((s) => r.services.includes(s.id));
  const loc = profile.locations.find((l) => r.locations.includes(l.id));
  const svcName = svc?.name ?? 'IT / digital services';
  if (r.isBranded) return { intent: r.intent, userProblem: `Looking for ${profile.name} specifically`, expectedContent: 'Homepage, contact details, services overview', recommendedPageType: 'homepage', recommendedCta: 'Contact Us' };
  if (/\b(vs|versus|compare|comparison|alternatives?)\b/.test(query)) return { intent: 'commercial', userProblem: `Deciding between options for ${svcName}`, expectedContent: 'Balanced comparison with criteria, pros/cons and when each option fits', recommendedPageType: 'comparison_article', recommendedCta: 'Get a free consultation' };
  if (r.isQuestion || r.intent === 'informational') {
    const short = normalizeKeyword(query).split(' ').length <= 7 && r.isQuestion;
    return { intent: 'informational', userProblem: `Wants to understand: "${query}"`, expectedContent: short ? 'Direct 2–4 sentence answer, then detail' : 'In-depth guide with steps, examples and practical advice', recommendedPageType: short && svc ? 'faq_entry' : 'blog_article', recommendedCta: svc ? `Explore ${svc.name}` : 'Talk to Phoenixx IT' };
  }
  if (r.intent === 'local') return { intent: 'local', userProblem: `Needs a trustworthy ${svcName.toLowerCase()} provider${loc ? ` in ${loc.name}` : ' nearby'}`, expectedContent: 'Service scope, process, local presence (address/map), proof of work, FAQs, clear contact options', recommendedPageType: svc?.path ? 'service_page' : 'location_section', recommendedCta: 'Talk to Phoenixx IT' };
  if (r.intent === 'transactional') return { intent: 'transactional', userProblem: `Ready to hire/buy ${svcName.toLowerCase()} and comparing cost/terms`, expectedContent: 'Engagement models, what affects price, how to get a quote', recommendedPageType: 'service_page', recommendedCta: 'Get a free consultation' };
  return { intent: r.intent, userProblem: `Evaluating ${svcName.toLowerCase()} providers`, expectedContent: 'Service details, deliverables, process, differentiation, FAQs', recommendedPageType: 'service_page', recommendedCta: 'Talk to Phoenixx IT' };
}
