import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface CompletionRequest {
  system: string;
  user: string;
  maxOutputTokens: number;
  model: string;
  /** JSON schema for structured output. */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    public kind: 'rate_limit' | 'server' | 'auth' | 'bad_request' | 'refusal' | 'truncated' | 'network' | 'unknown' = 'unknown',
  ) {
    super(message);
  }
}

/** Provider-agnostic interface: the rest of the application never imports a vendor SDK. */
export interface AIProvider {
  readonly name: 'claude' | 'openai' | 'mock';
  readonly defaultModel: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

/* ───────────────────────── Claude ───────────────────────── */

export class ClaudeProvider implements AIProvider {
  readonly name = 'claude' as const;
  readonly defaultModel = 'claude-opus-5';
  private client: Anthropic;
  constructor(
    apiKey?: string,
    private opts: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; serverFallbacks?: boolean } = {},
  ) {
    // Credentials come from ANTHROPIC_API_KEY (or an `ant auth login` profile) when apiKey is not passed.
    this.client = new Anthropic(apiKey ? { apiKey, maxRetries: 2 } : { maxRetries: 2 });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    // Server-side refusal fallbacks are supported on Opus 5 / Fable-tier models; other models reject the parameter.
    const useFallbacks = this.opts.serverFallbacks !== false && /^claude-(opus-5|fable-5)/.test(req.model);
    try {
      const params = {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: 'user' as const, content: req.user }],
        output_config: {
          format: { type: 'json_schema' as const, schema: req.jsonSchema },
          ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        },
      };
      const msg = useFallbacks
        ? await this.client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
        : await this.client.messages.create(params);
      if (msg.stop_reason === 'refusal') throw new AIProviderError('The model declined this request (refusal).', false, 'refusal');
      if (msg.stop_reason === 'max_tokens') throw new AIProviderError('Output truncated at max_tokens.', true, 'truncated');
      const text = (msg.content as { type: string; text?: string }[])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return { text, model: msg.model, inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens, stopReason: msg.stop_reason };
    } catch (e) {
      if (e instanceof AIProviderError) throw e;
      if (e instanceof Anthropic.RateLimitError) throw new AIProviderError(e.message, true, 'rate_limit');
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new AIProviderError(e.message, false, 'auth');
      if (e instanceof Anthropic.BadRequestError) throw new AIProviderError(e.message, false, 'bad_request');
      if (e instanceof Anthropic.InternalServerError) throw new AIProviderError(e.message, true, 'server');
      if (e instanceof Anthropic.APIConnectionError) throw new AIProviderError(e.message, true, 'network');
      if (e instanceof Anthropic.APIError) throw new AIProviderError(e.message, (e.status ?? 0) >= 500, 'unknown');
      throw e;
    }
  }
}

/* ───────────────────────── OpenAI ───────────────────────── */

export class OpenAIProvider implements AIProvider {
  readonly name = 'openai' as const;
  readonly defaultModel = 'gpt-5';
  private client: OpenAI;
  constructor(apiKey?: string) {
    this.client = new OpenAI(apiKey ? { apiKey, maxRetries: 2 } : { maxRetries: 2 });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    try {
      const res = await this.client.chat.completions.create({
        model: req.model,
        max_completion_tokens: req.maxOutputTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        // strict=false: our schemas are validated with zod afterwards; strict mode rejects some valid shapes.
        response_format: { type: 'json_schema', json_schema: { name: req.schemaName.replace(/[^a-zA-Z0-9_-]/g, '_'), schema: req.jsonSchema, strict: false } },
      });
      const choice = res.choices[0];
      if (choice?.finish_reason === 'length') throw new AIProviderError('Output truncated at max tokens.', true, 'truncated');
      if (choice?.message.refusal) throw new AIProviderError(`The model declined: ${choice.message.refusal}`, false, 'refusal');
      return { text: choice?.message.content ?? '', model: res.model, inputTokens: res.usage?.prompt_tokens ?? 0, outputTokens: res.usage?.completion_tokens ?? 0, stopReason: choice?.finish_reason ?? null };
    } catch (e) {
      if (e instanceof AIProviderError) throw e;
      if (e instanceof OpenAI.RateLimitError) throw new AIProviderError(e.message, true, 'rate_limit');
      if (e instanceof OpenAI.AuthenticationError || e instanceof OpenAI.PermissionDeniedError) throw new AIProviderError(e.message, false, 'auth');
      if (e instanceof OpenAI.BadRequestError) throw new AIProviderError(e.message, false, 'bad_request');
      if (e instanceof OpenAI.InternalServerError) throw new AIProviderError(e.message, true, 'server');
      if (e instanceof OpenAI.APIConnectionError) throw new AIProviderError(e.message, true, 'network');
      if (e instanceof OpenAI.APIError) throw new AIProviderError(e.message, (e.status ?? 0) >= 500, 'unknown');
      throw e;
    }
  }
}

/* ───────────────────────── Pricing (estimates) ───────────────────────── */

/** USD per 1M tokens. Used only for ESTIMATED cost tracking; override via AI_PRICE_INPUT/OUTPUT_PER_MTOK. */
export const PRICING: Record<string, { input: number; output: number }> = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  mock: { input: 0, output: 0 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number, override?: { input?: number; output?: number }): number {
  const key = Object.keys(PRICING).find((k) => model === k || model.startsWith(k + '-')) ?? model;
  const p = PRICING[key] ?? { input: override?.input ?? 5, output: override?.output ?? 25 };
  const input = override?.input ?? p.input;
  const output = override?.output ?? p.output;
  return (inputTokens / 1e6) * input + (outputTokens / 1e6) * output;
}
