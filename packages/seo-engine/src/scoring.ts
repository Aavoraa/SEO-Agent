import { round, type Priority, type ScoreFactor, type ScoredPriority, type Severity } from '@phoenixx/shared';

/**
 * Transparent priority scoring. Every factor is a 0–5 judgement with a written note;
 * the output shows the reasoning rather than pretending to scientific precision.
 */
export interface PriorityInput {
  /** Expected SEO/business impact if fixed (0–5). */
  impact?: number;
  /** Implementation effort (0 = trivial, 5 = major project). Lower effort raises priority. */
  effort?: number;
  /** Search demand evidence: impressions for the page/query. */
  impressions?: number;
  clicks?: number;
  position?: number | null;
  ctr?: number | null;
  siteAvgCtr?: number | null;
  /** 0–5: how central the page/topic is to Phoenixx IT's services. */
  businessRelevance?: number;
  severity?: Severity;
  /** 0–1 */
  confidence?: number;
  notes?: string[];
}

const SEV_VALUE: Record<Severity, number> = { critical: 5, high: 4, medium: 2.5, low: 1, info: 0 };

function trafficOpportunity(i: PriorityInput): { value: number; note: string } {
  const imp = i.impressions ?? 0;
  if (!imp) return { value: 0, note: 'No Search Console demand data for this item' };
  // Log scale: 10 → 1, 100 → 2, 1k → 3, 10k → 4, 100k+ → 5
  let v = Math.min(5, Math.max(0, Math.log10(imp)));
  const notes = [`${imp.toLocaleString('en-IN')} impressions`];
  if (i.position != null) {
    notes.push(`avg position ${round(i.position, 1)}`);
    if (i.position >= 4 && i.position <= 20) v = Math.min(5, v + 1); // striking distance
    if (i.position > 50) v = Math.max(0, v - 1);
  }
  if (i.ctr != null && i.siteAvgCtr != null && i.ctr < i.siteAvgCtr) notes.push(`CTR ${round(i.ctr * 100, 1)}% below site average ${round(i.siteAvgCtr * 100, 1)}%`);
  return { value: round(v, 1), note: notes.join(', ') };
}

export function scorePriority(i: PriorityInput): ScoredPriority {
  const t = trafficOpportunity(i);
  const factors: ScoreFactor[] = [
    { name: 'Impact', value: i.impact ?? 2.5, weight: 0.25, note: 'Expected effect on visibility/conversions if done' },
    { name: 'Technical severity', value: i.severity ? SEV_VALUE[i.severity] : 0, weight: 0.2, note: i.severity ? `Issue severity: ${i.severity}` : 'Not a technical defect' },
    { name: 'Traffic opportunity', value: t.value, weight: 0.2, note: t.note },
    { name: 'Business relevance', value: i.businessRelevance ?? 2.5, weight: 0.2, note: 'Relevance to Phoenixx IT services/locations' },
    { name: 'Ease (inverse effort)', value: 5 - (i.effort ?? 2.5), weight: 0.1, note: `Effort estimate ${i.effort ?? 2.5}/5` },
    { name: 'Confidence', value: (i.confidence ?? 0.6) * 5, weight: 0.05, note: 'How sure we are this is right' },
  ];
  const score = round((factors.reduce((s, f) => s + f.value * f.weight, 0) / 5) * 100, 0);
  const priority: Priority = i.severity === 'critical' ? 'critical' : score >= 62 ? 'high' : score >= 42 ? 'medium' : 'low';
  const reasons = [...(i.notes ?? [])];
  if (t.value > 0) reasons.push(t.note);
  if (i.severity && SEV_VALUE[i.severity] >= 4) reasons.push(`${i.severity.toUpperCase()} technical severity`);
  if ((i.businessRelevance ?? 0) >= 4) reasons.push('Directly tied to a core service or target location');
  if ((i.effort ?? 2.5) <= 1) reasons.push('Quick fix');
  return { priority, score, factors, reasons };
}

/** Relative opportunity score (0–100) for a query, based only on observed Search Console data. */
export function queryOpportunity(q: { impressions: number; clicks: number; position: number; ctr: number }, siteAvgCtr: number, businessRelevance: number): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let s = Math.min(40, Math.log10(Math.max(1, q.impressions)) * 10);
  if (q.position >= 4 && q.position <= 20) {
    s += 25;
    reasons.push(`Striking distance: avg position ${round(q.position, 1)}`);
  } else if (q.position < 4) {
    s += 5;
    reasons.push(`Already ranking top 3 (pos ${round(q.position, 1)})`);
  } else {
    reasons.push(`Low visibility: pos ${round(q.position, 1)}`);
  }
  if (q.impressions >= 50 && q.ctr < siteAvgCtr) {
    s += 15;
    reasons.push(`CTR ${round(q.ctr * 100, 1)}% below site avg ${round(siteAvgCtr * 100, 1)}%`);
  }
  s += businessRelevance * 4;
  if (businessRelevance >= 4) reasons.push('High business relevance');
  reasons.unshift(`${q.impressions} impressions, ${q.clicks} clicks`);
  return { score: Math.min(100, round(s, 0)), reasons };
}
