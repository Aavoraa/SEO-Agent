import { describe, expect, it } from 'vitest';
import { categorize, demandImpact, memoryMultiplier, scoreOpportunity } from '../src/index.js';

const base = { impact: 0.8, effort: 0.2, confidence: 0.9, businessValue: 1, risk: 0.1, timeSensitivity: 0.3 };

describe('opportunity scoring', () => {
  it('follows the documented weights exactly', () => {
    const s = scoreOpportunity(base);
    expect(s.score).toBeCloseTo(100 * (0.3 * 0.8 + 0.2 * 1 + 0.15 * 0.9 + 0.15 * 0.8 + 0.1 * 0.3 + 0.1 * 0.9), 1);
    expect(s.factors.find((f) => f.name === 'memory')!.value).toBe(1);
  });
  it('only adjusts for history with at least 3 decisions, and says so', () => {
    expect(memoryMultiplier({ approved: 1, rejected: 1 }).value).toBe(1);
    expect(memoryMultiplier({ approved: 0, rejected: 4 })).toMatchObject({ value: 0.85, note: expect.stringMatching(/0 of 4/) });
    expect(memoryMultiplier({ approved: 4, rejected: 0 }).value).toBe(1.1);
    expect(scoreOpportunity({ ...base, history: { approved: 0, rejected: 5 } }).score).toBeLessThan(scoreOpportunity(base).score);
  });
  it('categorises: at risk > AI search > quick win > high impact > strategic', () => {
    expect(categorize({ ...base, timeSensitivity: 0.9 })).toBe('at_risk');
    expect(categorize({ ...base, kind: 'ai_search' })).toBe('ai_search');
    expect(categorize(base)).toBe('quick_win');
    expect(categorize({ ...base, effort: 0.6 })).toBe('high_impact');
    expect(categorize({ ...base, effort: 0.6, impact: 0.4 })).toBe('strategic');
  });
  it('derives demand impact from impressions, boosting striking-distance positions', () => {
    expect(demandImpact(10_000, 7)).toBeGreaterThan(demandImpact(10_000, 35));
    expect(demandImpact(0, null)).toBe(0);
  });
});
