import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Central environment configuration. Every secret comes from the environment;
 * nothing sensitive is hard-coded. Values are validated once at startup.
 */
const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Database. postgres://… for production; pglite://<dir> (or empty) for local/demo/test.
  DATABASE_URL: optionalString,
  DEMO_MODE: bool.default(false),
  DEMO_DATABASE_URL: z.string().default('pglite://./.data/demo-db'),

  // API
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  JWT_SECRET: optionalString,
  APP_ENCRYPTION_KEY: optionalString,
  SERVICE_API_KEY: optionalString,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(300),
  ADMIN_EMAIL: optionalString,
  ADMIN_PASSWORD: optionalString,

  // Target website
  SEO_SITE_URL: z.string().default('https://www.phoenixxit.com/'),
  CRAWL_MAX_PAGES: z.coerce.number().int().default(500),
  CRAWL_CONCURRENCY: z.coerce.number().int().default(3),
  CRAWL_DELAY_MS: z.coerce.number().int().default(250),
  CRAWL_TIMEOUT_MS: z.coerce.number().int().default(20000),
  CRAWL_USER_AGENT: z.string().default('PhoenixxSEOAgent/1.0 (+https://www.phoenixxit.com/)'),

  // Google
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_REFRESH_TOKEN: optionalString,
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: optionalString,
  SEARCH_CONSOLE_SITE_URL: optionalString,
  GA4_PROPERTY_ID: optionalString,

  // AI
  AI_PROVIDER: z.enum(['claude', 'openai', 'mock', 'none']).default('none'),
  AI_MODEL: optionalString,
  AI_MODEL_LIGHT: optionalString,
  AI_EFFORT: z
    .string()
    .optional()
    .transform((v) => (v && ['low', 'medium', 'high', 'xhigh', 'max'].includes(v) ? (v as 'low' | 'medium' | 'high' | 'xhigh' | 'max') : undefined)),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().default(8000),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().default(60000),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().default(50),
  AI_CACHE_TTL_HOURS: z.coerce.number().default(168),
  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,

  // Notifications
  SMTP_HOST: optionalString,
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  SMTP_FROM: optionalString,
  REPORT_EMAIL_TO: optionalString,
  SLACK_WEBHOOK_URL: optionalString,
  TEAMS_WEBHOOK_URL: optionalString,
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,

  // Website implementation adapters
  WEBSITE_ADAPTER: z.enum(['manual', 'git', 'wordpress', 'api']).default('manual'),
  WEBSITE_REPO_PATH: optionalString,
  WEBSITE_GIT_BRANCH_PREFIX: z.string().default('seo-agent/'),
  WORDPRESS_URL: optionalString,
  WORDPRESS_USER: optionalString,
  WORDPRESS_APP_PASSWORD: optionalString,
  WEBSITE_API_URL: optionalString,
  WEBSITE_API_TOKEN: optionalString,
  EXPORT_DIR: z.string().default('./exports'),

  // Website deployment (approved changes → the live site). Takes precedence over WEBSITE_ADAPTER.
  // ftp/sftp/local = file-level deployment with backup, checksum, verification and automatic restore.
  // Blank (as in .env.example) means "not set".
  WEBSITE_DEPLOYMENT_PROVIDER: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['manual', 'git', 'wordpress', 'api', 'ftp', 'sftp', 'local']).optional()),
  DEPLOY_REMOTE_ROOT: z.string().default('/public_html'),
  DEPLOY_ALLOWED_EXTENSIONS: z.string().default('.html,.htm'),
  /** Where deployed pages are fetched for verification (default: the project's site URL). */
  DEPLOY_VERIFY_BASE_URL: optionalString,
  DEPLOY_VERIFY_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  DEPLOY_VERIFY_DELAY_MS: z.coerce.number().int().min(0).default(5000),
  LOCAL_DEPLOY_ROOT: optionalString,
  FTP_HOST: optionalString,
  FTP_PORT: z.coerce.number().int().default(21),
  FTP_USERNAME: optionalString,
  FTP_PASSWORD: optionalString,
  FTP_SECURE: z.enum(['true', 'implicit', 'false']).default('true'),
  FTP_ALLOW_INSECURE: bool.default(false),
  FTP_TLS_REJECT_UNAUTHORIZED: bool.default(true),
  FTP_TLS_SERVERNAME: optionalString,
  SFTP_HOST: optionalString,
  SFTP_PORT: z.coerce.number().int().default(22),
  SFTP_USERNAME: optionalString,
  SFTP_PASSWORD: optionalString,
  SFTP_PRIVATE_KEY_FILE: optionalString,
  SFTP_PASSPHRASE: optionalString,
  SFTP_HOST_FINGERPRINT: optionalString,
  SFTP_ALLOW_UNKNOWN_HOST: bool.default(false),
  /** Demo mode deploys to this local copy of the site (never to the real website). */
  DEMO_SITE_DIR: z.string().default('./.data/demo-site'),

  // SaaS
  /** Product name shown in the UI and reports (white-label per organization overrides it). */
  PRODUCT_NAME: z.string().default('SEO Agent'),
  /** Self-service sign-up (creates a user + organization). */
  SIGNUP_ENABLED: bool.default(true),
  /** Plan for organizations created by sign-up. */
  SIGNUP_DEFAULT_PLAN: z.string().default('starter'),
  /** Optional JSON file with extra/overridden plans (see packages/shared/src/plans.ts). */
  PLANS_FILE: optionalString,
  /** Only for tests/local development: allow webhook endpoints on private/loopback hosts. */
  WEBHOOK_ALLOW_PRIVATE_HOSTS: bool.default(false),
  /** Only for tests/local development: allow onboarding detection of private/loopback hosts. */
  OUTBOUND_ALLOW_PRIVATE_HOSTS: bool.default(false),

  // n8n event webhook: the API POSTs signed events (change.approved, deployment.*) here.
  N8N_EVENTS_WEBHOOK_URL: optionalString,
  N8N_EVENTS_SECRET: optionalString,

  // Backlinks (Search Console's API has no Links report: import a CSV, or use a provider)
  BACKLINK_PROVIDER: z.enum(['none', 'dataforseo']).default('none'),
  DATAFORSEO_LOGIN: optionalString,
  DATAFORSEO_PASSWORD: optionalString,
  BACKLINK_VERIFY_LIMIT: z.coerce.number().int().min(1).default(200),
  /** Only for tests/local fixtures: allow checking linking pages on private/loopback hosts. */
  BACKLINK_ALLOW_PRIVATE_HOSTS: bool.default(false),
  /** Heatmap click/scroll events older than this are deleted. */
  HEATMAP_RETENTION_DAYS: z.coerce.number().int().min(7).max(730).default(90),
  /** Session recordings are deleted after this many days; one session stops recording beyond RECORDING_MAX_MB. */
  RECORDING_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  RECORDING_MAX_MB: z.coerce.number().min(1).max(200).default(25),
});

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;
let dotenvLoaded = false;

/**
 * Minimal .env loader for local (non-Docker) runs. Looks in the current directory and the
 * monorepo root; never overrides variables that are already set in the real environment.
 */
export function loadDotEnv(): void {
  if (dotenvLoaded || process.env.NODE_ENV === 'test') return;
  dotenvLoaded = true;
  for (const file of [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]!] !== undefined) continue;
      process.env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
    break;
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env, opts: { fresh?: boolean } = {}): AppConfig {
  if (env === process.env) loadDotEnv();
  if (cached && !opts.fresh && env === process.env) return cached;
  // On Render the API serves the dashboard from the same origin: default the public URLs to the service address.
  const hostUrl = env.RENDER_EXTERNAL_URL;
  // PaaS hosts (Render, Railway, Heroku) route traffic to $PORT.
  const defaults: Record<string, string> = { ...(hostUrl ? { FRONTEND_URL: hostUrl, PUBLIC_API_URL: hostUrl } : {}), ...(env.PORT ? { API_PORT: env.PORT } : {}) };
  const parsed = envSchema.safeParse({ ...defaults, ...env });
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    const missing = (['JWT_SECRET', 'APP_ENCRYPTION_KEY', 'SERVICE_API_KEY'] as const).filter((k) => !cfg[k]);
    if (missing.length) throw new Error(`Missing required production secrets: ${missing.join(', ')}`);
    if (cfg.JWT_SECRET && cfg.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');
  }
  if (env === process.env) cached = cfg;
  return cfg;
}

/** Which database the process should use. Demo mode never touches the production database. */
export function resolveDatabaseUrl(cfg: AppConfig): string {
  if (cfg.DEMO_MODE) return cfg.DEMO_DATABASE_URL;
  return cfg.DATABASE_URL ?? 'pglite://./.data/db';
}
