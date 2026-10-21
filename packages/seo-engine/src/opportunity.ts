import { round } from '@phoenixx/shared';

/**
 * Opportunity Engine – one documented, deterministic score for every issue and opportunity,
 * whatever produced it (crawler, Search Console, content gaps, links, deployments, alerts).
 *
 *   Priority (0–100) = 100 × ( 0.30·Impact + 0.20·BusinessValue + 0.15·Confidence
 *                              + 0.15·(1 − Effort) + 0.10·TimeSensitivity + 0.10·(1 − Risk) ) × Memory
 *
 * Every input is 0–1 and derived from data (see `factors` on each opportunity for the exact values and
 * their source). Memory ∈ [0.85, 1.10] adjusts for this project's own history with the same kind of
 * change: ≥3 decisions → 0.85 + 0.25 × acceptance rate; fewer → 1.0. It is always shown, never silent.
 * No AI judgement enters the score.
 */
export const OPPORTUNITY_WEIGHTS = { impact: 0.3, businessValue: 0.2, confidence: 0.15, ease: 0.15, timeSensitivity: 0.1, safety: 0.1 } as const;

export type OpportunityCategory = 'quick_win' | 'high_impact' | 'strategic' | 'at_risk' | 'competitive' | 'ai_search' | 'emerging';

export interface OpportunityInput {
  impact: number;
  effort: number;
  confidence: number;
  businessValue: number;
  risk: number;
  timeSensitivity: number;
  /** Past decisions on the same kind of change in this project. */
  history?: { approved: number; rejected: number };
  /** Hints for categorisation. */
  kind?: 'at_risk' | 'ai_search' | 'competitive' | 'emerging' | null;
}

export interface OpportunityFactor {
  name: string;
  value: number;
  weight: number;
  contribution: number;
  note: string;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export function memoryMultiplier(history?: { approved: number; rejected: number }): { value: number; note: string } {
  const n = (history?.approved ?? 0) + (history?.rejected ?? 0);
  if (!history || n < 3) return { value: 1, note: n ? `Only ${n} past decision(s) on this kind of change – no adjustment` : 'No history yet – no adjustment' };
  const rate = history.approved / n;
  return { value: round(0.85 + 0.25 * rate, 3), note: `You approved ${history.approved} of ${n} similar changes (${Math.round(rate * 100)}%)` };
}

export function scoreOpportunity(i: OpportunityInput): { score: number; factors: OpportunityFactor[]; category: OpportunityCategory } {
  const v = { impact: clamp01(i.impact), businessValue: clamp01(i.businessValue), confidence: clamp01(i.confidence), ease: 1 - clamp01(i.effort), timeSensitivity: clamp01(i.timeSensitivity), safety: 1 - clamp01(i.risk) };
  const notes: Record<keyof typeof v, string> = {
    impact: 'Expected effect on visibility/traffic if done',
    businessValue: 'How central the pages/topics are to the business',
    confidence: 'Strength of the evidence',
    ease: 'Inverse of implementation effort',
    timeSensitivity: 'Urgency (losses, errors, decay)',
    safety: 'Inverse of change risk',
  };
  const factors: OpportunityFactor[] = (Object.keys(OPPORTUNITY_WEIGHTS) as (keyof typeof OPPORTUNITY_WEIGHTS)[]).map((k) => ({ name: k, value: round(v[k], 3), weight: OPPORTUNITY_WEIGHTS[k], contribution: round(v[k] * OPPORTUNITY_WEIGHTS[k] * 100, 1), note: notes[k] }));
  const mem = memoryMultiplier(i.history);
  factors.push({ name: 'memory', value: mem.value, weight: 1, contribution: 0, note: mem.note });
  const base = factors.filter((f) => f.name !== 'memory').reduce((s, f) => s + f.value * f.weight, 0);
  const score = round(Math.min(100, base * 100 * mem.value), 1);
  return { score, factors, category: categorize(i) };
}

export function categorize(i: OpportunityInput): OpportunityCategory {
  if (i.kind === 'at_risk' || clamp01(i.timeSensitivity) >= 0.8) return 'at_risk';
  if (i.kind === 'ai_search') return 'ai_search';
  if (i.kind === 'emerging') return 'emerging';
  if (i.kind === 'competitive') return 'competitive';
  if (i.effort <= 0.25 && i.impact >= 0.4) return 'quick_win';
  if (i.impact >= 0.7) return 'high_impact';
  return 'strategic';
}

/** Impact from Search Console demand: log-scaled impressions, boosted for striking-distance positions. */
export function demandImpact(impressions: number, position: number | null): number {
  const base = Math.min(1, Math.log10(Math.max(1, impressions)) / 4.5); // ~31k impressions → 1
  const striking = position !== null && position >= 4 && position <= 20 ? 0.15 : 0;
  return clamp01(base + striking);
}

export const CONFIDENCE_VALUE: Record<string, number> = { high: 0.9, medium: 0.7, low: 0.5 };
export const RISK_VALUE: Record<string, number> = { low: 0.1, medium: 0.4, high: 0.8, critical: 1 };
export const SEVERITY_URGENCY: Record<string, number> = { critical: 1, high: 0.6, medium: 0.35, low: 0.15, info: 0.05 };
