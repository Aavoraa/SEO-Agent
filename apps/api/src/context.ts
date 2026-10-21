import { createDb, migrate, type Db } from '@phoenixx/database';
import { AIService, type AIStore } from '@phoenixx/ai-engine';
import { adapterFromConfig, GoogleAuth, notifiersFromConfig, type Notifier, type WebsiteAdapter } from '@phoenixx/integrations';
import { createLogger, decryptSecret, loadConfig, resolveDatabaseUrl, resolveEntitlements, type AppConfig, type Logger } from '@phoenixx/shared';

export interface AppContext {
  cfg: AppConfig;
  db: Db;
  ai: AIService;
  log: Logger;
  adapter: WebsiteAdapter;
  notifiers: Notifier[];
  /** Google auth resolved per project: env service account / env refresh token / refresh token stored via OAuth flow. */
  googleAuth(projectId: string): Promise<GoogleAuth>;
  jwtSecret: string;
  encryptionKey: string;
  close(): Promise<void>;
}

export function dbAIStore(db: Db): AIStore {
  return {
    async getCache(key) {
      const row = await db.one<{ response: unknown }>('UPDATE ai_cache SET hits = hits + 1 WHERE key = $1 AND expires_at > now() RETURNING response', [key]);
      return row?.response ?? null;
    },
    async setCache(e) {
      await db.query(
        `INSERT INTO ai_cache(key, provider, model, prompt_name, response, expires_at) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' hours')::interval)
         ON CONFLICT (key) DO UPDATE SET response = EXCLUDED.response, expires_at = EXCLUDED.expires_at`,
        [e.key, e.provider, e.model, e.promptName, e.response, String(e.ttlHours)],
      );
    },
    async recordUsage(u) {
      await db.query(
        `INSERT INTO ai_usage(project_id, provider, model, prompt_name, input_tokens, output_tokens, cached, estimated_cost_usd, duration_ms, success, error, correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [u.projectId, u.provider, u.model, u.promptName, u.inputTokens, u.outputTokens, u.cached, u.estimatedCostUsd, u.durationMs, u.success, u.error ?? null, u.correlationId ?? null],
      );
    },
    async tenantBudget(projectId) {
      const o = await db.one<{ plan_id: string; plan_overrides: never; spent: number }>(
        `SELECT o.plan_id, o.plan_overrides, (SELECT COALESCE(SUM(a.estimated_cost_usd),0) FROM ai_usage a JOIN projects p2 ON p2.id = a.project_id WHERE p2.organization_id = o.id AND a.created_at >= date_trunc('month', now()))::float AS spent
         FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = $1`,
        [projectId],
      );
      if (!o) return null;
      const e = resolveEntitlements(o.plan_id, o.plan_overrides);
      return { spentUsd: o.spent, limitUsd: e.limits.aiBudgetUsdMonthly, planName: e.planName };
    },
    async monthToDateCostUsd() {
      const r = await db.one<{ c: number }>(`SELECT COALESCE(SUM(estimated_cost_usd),0)::float AS c FROM ai_usage WHERE created_at >= date_trunc('month', now())`);
      return r?.c ?? 0;
    },
  };
}

export async function createContext(overrides: Partial<AppConfig> = {}, opts: { db?: Db; migrate?: boolean } = {}): Promise<AppContext> {
  const cfg = { ...loadConfig(), ...overrides } as AppConfig;
  const log = createLogger({ service: 'phoenixx-seo-api', demo: cfg.DEMO_MODE }, cfg.LOG_LEVEL);
  const db = opts.db ?? (await createDb(resolveDatabaseUrl(cfg)));
  if (opts.migrate !== false) {
    const res = await migrate(db);
    if (res.applied.length) log.info('db.migrated', { applied: res.applied });
  }
  // Demo mode always uses the mock AI provider unless a provider is explicitly configured for demo testing.
  const provider = cfg.DEMO_MODE && cfg.AI_PROVIDER === 'none' ? 'mock' : cfg.AI_PROVIDER;
  const ai = new AIService(
    {
      provider,
      model: cfg.AI_MODEL,
      lightModel: cfg.AI_MODEL_LIGHT,
      anthropicApiKey: cfg.ANTHROPIC_API_KEY,
      openaiApiKey: cfg.OPENAI_API_KEY,
      maxInputChars: cfg.AI_MAX_INPUT_CHARS,
      monthlyBudgetUsd: cfg.AI_MONTHLY_BUDGET_USD,
      cacheTtlHours: cfg.AI_CACHE_TTL_HOURS,
      effort: cfg.AI_EFFORT,
      priceOverride: process.env.AI_PRICE_INPUT_PER_MTOK ? { input: Number(process.env.AI_PRICE_INPUT_PER_MTOK), output: Number(process.env.AI_PRICE_OUTPUT_PER_MTOK) } : undefined,
    },
    dbAIStore(db),
    undefined,
    log.child({ component: 'ai' }),
  );
  // In non-production we derive stable dev secrets so the app works out of the box; production requires real ones (enforced by loadConfig).
  const jwtSecret = cfg.JWT_SECRET ?? 'dev-only-insecure-jwt-secret-change-me-please-32+';
  const encryptionKey = cfg.APP_ENCRYPTION_KEY ?? 'dev-only-insecure-encryption-key';
  if (!cfg.JWT_SECRET) log.warn('security.dev_secrets', { message: 'JWT_SECRET / APP_ENCRYPTION_KEY not set – using insecure development defaults. Never do this in production.' });

  let adapter: WebsiteAdapter;
  try {
    adapter = adapterFromConfig(cfg);
  } catch (e) {
    log.warn('adapter.misconfigured', { error: (e as Error).message, fallback: 'manual' });
    adapter = adapterFromConfig({ ...cfg, WEBSITE_ADAPTER: 'manual' });
  }

  return {
    cfg,
    db,
    ai,
    log,
    adapter,
    notifiers: notifiersFromConfig(cfg),
    jwtSecret,
    encryptionKey,
    async googleAuth(projectId: string) {
      if (cfg.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) return new GoogleAuth({ serviceAccountKeyFile: cfg.GOOGLE_SERVICE_ACCOUNT_KEY_FILE });
      if (cfg.GOOGLE_REFRESH_TOKEN) return new GoogleAuth({ clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET, refreshToken: cfg.GOOGLE_REFRESH_TOKEN });
      const row = await db.one<{ secret_encrypted: string | null }>(`SELECT secret_encrypted FROM integrations WHERE project_id = $1 AND provider = 'google_oauth' AND status = 'connected'`, [projectId]);
      if (row?.secret_encrypted) return new GoogleAuth({ clientId: cfg.GOOGLE_CLIENT_ID, clientSecret: cfg.GOOGLE_CLIENT_SECRET, refreshToken: decryptSecret(row.secret_encrypted, encryptionKey) });
      return new GoogleAuth({});
    },
    close: () => db.close(),
  };
}
