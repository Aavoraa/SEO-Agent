import { describe, expect, it } from 'vitest';
import { AIService, AIValidationError, extractJson, jsonSchemaFor, listPrompts, loadPrompt, renderTemplate, schemas, estimateCost, type AIProvider, type AIStore, type AIUsageRecord } from '../src/index.js';

function memoryStore() {
  const cache = new Map<string, unknown>();
  const usage: AIUsageRecord[] = [];
  const store: AIStore = {
    getCache: async (k) => cache.get(k) ?? null,
    setCache: async (e) => void cache.set(e.key, e.response),
    recordUsage: async (u) => void usage.push(u),
    monthToDateCostUsd: async () => usage.reduce((s, u) => s + u.estimatedCostUsd, 0),
  };
  return { store, usage, cache };
}

const cfg = { provider: 'mock' as const, maxInputChars: 60000, monthlyBudgetUsd: 10, cacheTtlHours: 24 };

describe('prompt templates', () => {
  it('every prompt has a schema and loads with principles included', () => {
    const names = listPrompts();
    expect(names.length).toBeGreaterThanOrEqual(12);
    for (const n of names) {
      expect(schemas).toHaveProperty(n);
      const t = loadPrompt(n);
      expect(t.system).toMatch(/Never fabricate/);
      expect(t.user.length).toBeGreaterThan(20);
    }
  });
  it('renders and truncates variables', () => {
    const out = renderTemplate('A {{x}} B {{y}} C {{missing}}', { x: { a: 1 }, y: 'z'.repeat(50) }, 10);
    expect(out).toContain('"a": 1');
    expect(out).toContain('[truncated');
    expect(out).toContain('(none)');
  });
  it('produces provider JSON schemas with additionalProperties=false', () => {
    const s = jsonSchemaFor('title-optimization') as any;
    expect(s.type).toBe('object');
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toContain('recommended');
  });
});

describe('AIService', () => {
  it('validates output, caches, and records usage (mock provider)', async () => {
    const { store, usage } = memoryStore();
    const ai = new AIService(cfg, store);
    const r1 = await ai.run('title-optimization', { currentTitle: 'Automation | Phoenixx IT', url: 'u', profile: {}, h1: '', content: '', queries: [] });
    expect(r1.cached).toBe(false);
    expect(r1.data.recommended).toContain('Phoenixx IT');
    const r2 = await ai.run('title-optimization', { currentTitle: 'Automation | Phoenixx IT', url: 'u', profile: {}, h1: '', content: '', queries: [] });
    expect(r2.cached).toBe(true);
    expect(usage.map((u) => u.cached)).toEqual([false, true]);
  });

  it('retries once on invalid output then succeeds; rejects persistent schema violations', async () => {
    let calls = 0;
    const flaky: AIProvider = {
      name: 'claude',
      defaultModel: 'claude-opus-5',
      complete: async () => {
        calls++;
        const text = calls === 1 ? 'not json' : JSON.stringify({ recommended: 'T', alternatives: [], reason: 'r', expectedPurpose: 'p', primaryKeyword: 'k' });
        return { text, model: 'claude-opus-5', inputTokens: 100, outputTokens: 50, stopReason: 'end_turn' };
      },
    };
    const { store, usage } = memoryStore();
    const ai = new AIService({ ...cfg, provider: 'claude' }, store, flaky);
    const r = await ai.run('title-optimization', {});
    expect(r.data.recommended).toBe('T');
    expect(calls).toBe(2);
    expect(usage.filter((u) => !u.success)).toHaveLength(1);
    expect(r.usage.estimatedCostUsd).toBeCloseTo(estimateCost('claude-opus-5', 100, 50));

    const bad: AIProvider = { ...flaky, complete: async () => ({ text: JSON.stringify({ recommended: 5 }), model: 'claude-opus-5', inputTokens: 1, outputTokens: 1, stopReason: 'end_turn' }) };
    const ai2 = new AIService({ ...cfg, provider: 'claude', maxAttempts: 2 }, memoryStore().store, bad);
    await expect(ai2.run('title-optimization', {})).rejects.toBeInstanceOf(AIValidationError);
  });

  it('enforces the monthly budget for paid providers', async () => {
    const { store } = memoryStore();
    store.monthToDateCostUsd = async () => 999;
    const paid: AIProvider = { name: 'openai', defaultModel: 'gpt-5', complete: async () => ({ text: '{}', model: 'gpt-5', inputTokens: 1, outputTokens: 1, stopReason: 'stop' }) };
    const ai = new AIService({ ...cfg, provider: 'openai' }, store, paid);
    await expect(ai.run('title-optimization', {})).rejects.toThrow(/budget/);
  });

  it('is disabled cleanly when no provider is configured', async () => {
    const ai = new AIService({ ...cfg, provider: 'none' }, memoryStore().store);
    expect(ai.enabled).toBe(false);
    await expect(ai.run('seo-audit', {})).rejects.toThrow(/not configured/);
  });

  it('mock outputs satisfy every schema', async () => {
    const ai = new AIService(cfg, memoryStore().store);
    for (const n of listPrompts()) await expect(ai.run(n as any, { queries: [], clusters: [], suggestions: [], matrix: [], brief: {}, page: {} })).resolves.toBeTruthy();
  });

  it('extracts JSON from fenced output', () => expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 }));
});
