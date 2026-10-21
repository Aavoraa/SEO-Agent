import { sha256, sleep, createLogger, type Logger } from '@phoenixx/shared';
import { loadPrompt, renderTemplate } from './prompts.js';
import { schemas, jsonSchemaFor, type PromptName, type PromptOutput } from './schemas.js';
import { AIProviderError, ClaudeProvider, estimateCost, OpenAIProvider, type AIProvider } from './providers.js';
import { MockProvider } from './mock.js';

/** Persistence hooks (implemented by the API with Postgres). Keeps this package DB-agnostic. */
export interface AIStore {
  getCache(key: string): Promise<unknown | null>;
  setCache(entry: { key: string; provider: string; model: string; promptName: string; response: unknown; ttlHours: number }): Promise<void>;
  recordUsage(u: AIUsageRecord): Promise<void>;
  monthToDateCostUsd(projectId: string | null): Promise<number>;
  /** Tenant budget for the project's organization this month (null = no tenant limit). */
  tenantBudget?(projectId: string): Promise<{ spentUsd: number; limitUsd: number | null; planName: string } | null>;
}

export interface AIUsageRecord {
  projectId: string | null;
  provider: string;
  model: string;
  promptName: string;
  inputTokens: number;
  outputTokens: number;
  cached: boolean;
  estimatedCostUsd: number;
  durationMs: number;
  success: boolean;
  error?: string;
  correlationId?: string;
}

export interface AIServiceConfig {
  provider: 'claude' | 'openai' | 'mock' | 'none';
  model?: string;
  lightModel?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  maxInputChars: number;
  monthlyBudgetUsd: number;
  cacheTtlHours: number;
  maxAttempts?: number;
  priceOverride?: { input?: number; output?: number };
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export class AIDisabledError extends Error {
  constructor() {
    super('AI provider is not configured (AI_PROVIDER=none). Deterministic analysis still works; configure Claude or OpenAI for AI features.');
  }
}

export class AIBudgetError extends Error {}
export class AIValidationError extends Error {
  constructor(
    message: string,
    public raw: string,
  ) {
    super(message);
  }
}

export interface RunOptions {
  projectId?: string | null;
  correlationId?: string;
  /** Bypass cache (e.g. user explicitly asked to regenerate). */
  fresh?: boolean;
}

export interface RunResult<T> {
  data: T;
  cached: boolean;
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
}

export function createProvider(cfg: AIServiceConfig): AIProvider | null {
  switch (cfg.provider) {
    case 'claude':
      return new ClaudeProvider(cfg.anthropicApiKey, { effort: cfg.effort });
    case 'openai':
      return new OpenAIProvider(cfg.openaiApiKey);
    case 'mock':
      return new MockProvider();
    default:
      return null;
  }
}

/** Extract a JSON object from model text (tolerates stray fences). */
export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new Error('No JSON object found in model output');
  }
}

/**
 * The single entry point for all AI calls: templating, input limits, caching, budget
 * guard, retries with backoff, schema validation and usage/cost tracking.
 */
export class AIService {
  readonly provider: AIProvider | null;
  private log: Logger;
  constructor(
    private cfg: AIServiceConfig,
    private store: AIStore,
    provider?: AIProvider | null,
    logger?: Logger,
  ) {
    this.provider = provider === undefined ? createProvider(cfg) : provider;
    this.log = logger ?? createLogger({ component: 'ai' });
  }

  get enabled() {
    return !!this.provider;
  }

  get info() {
    return { provider: this.provider?.name ?? 'none', model: this.provider ? (this.cfg.model ?? this.provider.defaultModel) : null, lightModel: this.cfg.lightModel ?? null, monthlyBudgetUsd: this.cfg.monthlyBudgetUsd };
  }

  async run<P extends PromptName>(name: P, vars: Record<string, unknown>, opts: RunOptions = {}): Promise<RunResult<PromptOutput<P>>> {
    if (!this.provider) throw new AIDisabledError();
    const tpl = loadPrompt(name);
    const model = (tpl.light && this.cfg.lightModel) || this.cfg.model || this.provider.defaultModel;
    const perVar = Math.max(2000, Math.floor(this.cfg.maxInputChars / Math.max(1, Object.keys(vars).length)));
    const system = tpl.system;
    let user = renderTemplate(tpl.user, vars, perVar);
    if (user.length > this.cfg.maxInputChars) user = user.slice(0, this.cfg.maxInputChars) + '\n…[input truncated to respect AI_MAX_INPUT_CHARS]';
    const key = sha256([this.provider.name, model, name, tpl.version, system, user].join('\u0000'));
    const projectId = opts.projectId ?? null;

    if (!opts.fresh) {
      const hit = await this.store.getCache(key);
      if (hit) {
        const parsed = schemas[name].safeParse(hit);
        if (parsed.success) {
          await this.store.recordUsage({ projectId, provider: this.provider.name, model, promptName: name, inputTokens: 0, outputTokens: 0, cached: true, estimatedCostUsd: 0, durationMs: 0, success: true, correlationId: opts.correlationId });
          return { data: parsed.data as PromptOutput<P>, cached: true, model, provider: this.provider.name, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } };
        }
      }
    }

    if (this.provider.name !== 'mock') {
      const spent = await this.store.monthToDateCostUsd(null);
      if (spent >= this.cfg.monthlyBudgetUsd) throw new AIBudgetError(`Monthly AI budget of ${this.cfg.monthlyBudgetUsd} reached (estimated ${spent.toFixed(2)} spent). Raise AI_MONTHLY_BUDGET_USD to continue.`);
      // Per-organization plan budget (multi-tenant cost control).
      if (projectId && this.store.tenantBudget) {
        const t = await this.store.tenantBudget(projectId);
        if (t && t.limitUsd !== null && t.spentUsd >= t.limitUsd) throw new AIBudgetError(`This organization's AI budget for the month (${t.limitUsd} on the ${t.planName} plan) is used up (estimated ${t.spentUsd.toFixed(2)}).`);
      }
    }

    const maxAttempts = this.cfg.maxAttempts ?? 3;
    let lastErr: unknown;
    let extraInstruction = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      try {
        const res = await this.provider.complete({
          system,
          user: user + extraInstruction,
          maxOutputTokens: tpl.maxOutputTokens,
          model,
          jsonSchema: jsonSchemaFor(name),
          schemaName: name,
          ...({ vars } as object),
        });
        const cost = estimateCost(res.model, res.inputTokens, res.outputTokens, this.cfg.priceOverride);
        let parsedJson: unknown;
        try {
          parsedJson = extractJson(res.text);
        } catch (e) {
          await this.store.recordUsage({ projectId, provider: this.provider.name, model: res.model, promptName: name, inputTokens: res.inputTokens, outputTokens: res.outputTokens, cached: false, estimatedCostUsd: cost, durationMs: Date.now() - started, success: false, error: 'invalid_json', correlationId: opts.correlationId });
          throw new AIValidationError(`Model returned invalid JSON: ${(e as Error).message}`, res.text);
        }
        const valid = schemas[name].safeParse(parsedJson);
        if (!valid.success) {
          await this.store.recordUsage({ projectId, provider: this.provider.name, model: res.model, promptName: name, inputTokens: res.inputTokens, outputTokens: res.outputTokens, cached: false, estimatedCostUsd: cost, durationMs: Date.now() - started, success: false, error: 'schema_validation', correlationId: opts.correlationId });
          throw new AIValidationError(`AI output failed schema validation: ${valid.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, res.text);
        }
        await this.store.recordUsage({ projectId, provider: this.provider.name, model: res.model, promptName: name, inputTokens: res.inputTokens, outputTokens: res.outputTokens, cached: false, estimatedCostUsd: cost, durationMs: Date.now() - started, success: true, correlationId: opts.correlationId });
        await this.store.setCache({ key, provider: this.provider.name, model: res.model, promptName: name, response: valid.data, ttlHours: this.cfg.cacheTtlHours });
        return { data: valid.data as PromptOutput<P>, cached: false, model: res.model, provider: this.provider.name, usage: { inputTokens: res.inputTokens, outputTokens: res.outputTokens, estimatedCostUsd: cost } };
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof AIValidationError || (e instanceof AIProviderError && e.retryable);
        if (e instanceof AIProviderError && !retryable) {
          await this.store.recordUsage({ projectId, provider: this.provider.name, model, promptName: name, inputTokens: 0, outputTokens: 0, cached: false, estimatedCostUsd: 0, durationMs: Date.now() - started, success: false, error: `${e.kind}: ${e.message}`.slice(0, 500), correlationId: opts.correlationId });
        }
        this.log.warn('ai.attempt_failed', { prompt: name, attempt, error: (e as Error).message, retryable, correlationId: opts.correlationId });
        if (!retryable || attempt === maxAttempts) break;
        if (e instanceof AIValidationError) extraInstruction = `\n\nIMPORTANT: your previous answer was rejected (${e.message.slice(0, 300)}). Return ONLY valid JSON matching the schema.`;
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
    throw lastErr;
  }
}
