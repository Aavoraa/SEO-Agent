import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { applyHtmlToPage } from '@phoenixx/crawler';
import { applyHtmlChange, candidateFilesForPath, DeployPathError, FtpFileStore, guardPath, LocalFileStore, sha256Hex, SftpFileStore, type FileStore } from '@phoenixx/integrations';
import { AppError, decryptSecret, encryptSecret, redact, riskPolicy, type CrawlOutput, type RiskLevel } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { audit, getProject, latestCrawl, latestCrawledPages, primaryWebsite, type Actor, SYSTEM_ACTOR } from './common.js';
import { raiseAlert, dispatchPending } from './alerts.js';
import { emitEvent } from './events.js';
import { demoSiteOrigin } from '../demo/site.js';
import { compareFields, fetchPageFields, fieldsFromHtml, verifyLivePage, type FieldCheck, type PageFields } from './verification.js';

/**
 * Website deployment pipeline for approved changes.
 *
 *   validate → connect → locate file → BACKUP → apply in memory → validate edit → upload (temp + rename)
 *   → checksum → HTTP check → re-crawl page & compare expected/actual → status → re-score audit → notify
 *
 * - Transport/checksum/HTTP failures restore the backup automatically (we know the exact original).
 * - A field mismatch after a successful upload is flagged VERIFICATION_FAILED with rollback available
 *   (it can be a cache; a human decides).
 * - Demo projects deploy to a local copy of the site; the real website is never touched in demo mode.
 * - Live deployment requires a configured provider AND an admin switching it on per project.
 * - Credentials come from env or encrypted project settings, are never logged, returned or sent to AI.
 */

export const FILE_PROVIDERS = ['ftp', 'sftp', 'local'] as const;
/** Change types the file pipeline can apply (`other` = og:image). */
export const FILE_DEPLOYABLE = ['title', 'meta_description', 'h1', 'canonical', 'schema', 'other'];
const HTML_CHANGE_TYPE = (t: string) => (t === 'other' ? 'og_image' : t);

type Provider = 'manual' | 'git' | 'wordpress' | 'api' | 'ftp' | 'sftp' | 'local';

interface ConnectionConfig {
  provider?: Provider;
  host?: string;
  port?: number;
  username?: string;
  remoteRoot?: string;
  secure?: 'true' | 'implicit' | 'false';
  tlsServername?: string;
  rejectUnauthorized?: boolean;
  hostFingerprint?: string;
  allowInsecure?: boolean;
  verifyBaseUrl?: string;
}
interface ConnectionSecret {
  password?: string;
  privateKey?: string;
  passphrase?: string;
}

export interface ResolvedDeployment {
  provider: Provider;
  mode: 'demo' | 'live';
  fileBased: boolean;
  configured: boolean;
  missing: string[];
  description: string;
  liveEnabled: boolean;
  verifyBaseUrl: string;
  siteUrl: string;
  source: 'demo' | 'project' | 'env';
  open: () => FileStore;
}

async function connectionRow(ctx: AppContext, projectId: string) {
  return ctx.db.one<{ config: ConnectionConfig; secret_encrypted: string | null; status: string; last_sync_at: string | null; last_error: string | null }>(`SELECT config, secret_encrypted, status, last_sync_at, last_error FROM integrations WHERE project_id = $1 AND provider = 'website_deploy'`, [projectId]);
}

export async function resolveDeployment(ctx: AppContext, projectId: string): Promise<ResolvedDeployment> {
  const project = await getProject(ctx, projectId);
  const site = await primaryWebsite(ctx, projectId);
  const exts = ctx.cfg.DEPLOY_ALLOWED_EXTENSIONS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (project.is_demo) {
    const dir = path.resolve(ctx.cfg.DEMO_SITE_DIR);
    const ok = existsSync(path.join(dir, 'index.html'));
    return {
      provider: 'local',
      mode: 'demo',
      fileBased: true,
      configured: ok,
      missing: ok ? [] : ['Demo site copy not found – restart with `npm run demo`'],
      description: 'DEMO – a local copy of the site served by the API. The real website is never touched in demo mode.',
      liveEnabled: true,
      verifyBaseUrl: `${demoSiteOrigin(ctx)}/`,
      siteUrl: site.base_url,
      source: 'demo',
      open: () => new LocalFileStore(dir, exts),
    };
  }
  const row = await connectionRow(ctx, projectId);
  const conn: ConnectionConfig = row?.config ?? {};
  let secret: ConnectionSecret = {};
  if (row?.secret_encrypted) {
    try {
      secret = JSON.parse(decryptSecret(row.secret_encrypted, ctx.encryptionKey));
    } catch {
      secret = {};
    }
  }
  const provider: Provider = conn.provider ?? ctx.cfg.WEBSITE_DEPLOYMENT_PROVIDER ?? ctx.cfg.WEBSITE_ADAPTER;
  const source: ResolvedDeployment['source'] = conn.provider ? 'project' : 'env';
  const liveEnabled = (project.settings as { deployment?: { liveEnabled?: boolean } }).deployment?.liveEnabled === true;
  const verifyBaseUrl = conn.verifyBaseUrl ?? ctx.cfg.DEPLOY_VERIFY_BASE_URL ?? site.base_url;
  const base = { provider, mode: 'live' as const, liveEnabled, verifyBaseUrl, siteUrl: site.base_url, source };
  const remoteRoot = conn.remoteRoot ?? ctx.cfg.DEPLOY_REMOTE_ROOT;
  const noStore = () => {
    throw new AppError(`Provider ${provider} does not deploy files`, 400, 'not_file_provider');
  };
  if (provider === 'ftp') {
    const host = conn.host ?? ctx.cfg.FTP_HOST;
    const user = conn.username ?? ctx.cfg.FTP_USERNAME;
    const password = secret.password ?? ctx.cfg.FTP_PASSWORD;
    const secureRaw = conn.secure ?? ctx.cfg.FTP_SECURE;
    const secure = secureRaw === 'implicit' ? 'implicit' : secureRaw === 'true';
    const allowInsecure = conn.allowInsecure ?? ctx.cfg.FTP_ALLOW_INSECURE;
    const missing = [!host && 'FTP host', !user && 'FTP username', !password && 'FTP password', !secure && !allowInsecure && 'FTPS (plain FTP is refused unless FTP_ALLOW_INSECURE=true)'].filter(Boolean) as string[];
    return {
      ...base,
      fileBased: true,
      configured: !missing.length,
      missing,
      description: `${secure ? 'FTPS' : 'FTP (unencrypted)'} ${user ?? '?'}@${host ?? '?'}:${conn.port ?? ctx.cfg.FTP_PORT} root ${remoteRoot}`,
      open: () => new FtpFileStore({ host: host!, port: conn.port ?? ctx.cfg.FTP_PORT, user: user!, password: password!, root: remoteRoot, secure, allowInsecure, rejectUnauthorized: conn.rejectUnauthorized ?? ctx.cfg.FTP_TLS_REJECT_UNAUTHORIZED, tlsServername: conn.tlsServername ?? ctx.cfg.FTP_TLS_SERVERNAME, allowedExtensions: exts }),
    };
  }
  if (provider === 'sftp') {
    const host = conn.host ?? ctx.cfg.SFTP_HOST;
    const user = conn.username ?? ctx.cfg.SFTP_USERNAME;
    const password = secret.password ?? ctx.cfg.SFTP_PASSWORD;
    const privateKey = secret.privateKey ?? (ctx.cfg.SFTP_PRIVATE_KEY_FILE && existsSync(ctx.cfg.SFTP_PRIVATE_KEY_FILE) ? readFileSync(ctx.cfg.SFTP_PRIVATE_KEY_FILE, 'utf8') : undefined);
    const fingerprint = conn.hostFingerprint ?? ctx.cfg.SFTP_HOST_FINGERPRINT;
    const missing = [!host && 'SFTP host', !user && 'SFTP username', !password && !privateKey && 'SFTP password or private key', !fingerprint && !ctx.cfg.SFTP_ALLOW_UNKNOWN_HOST && 'SFTP host fingerprint'].filter(Boolean) as string[];
    return {
      ...base,
      fileBased: true,
      configured: !missing.length,
      missing,
      description: `SFTP ${user ?? '?'}@${host ?? '?'}:${conn.port ?? ctx.cfg.SFTP_PORT} root ${remoteRoot}`,
      open: () => new SftpFileStore({ host: host!, port: conn.port ?? ctx.cfg.SFTP_PORT, user: user!, password, privateKey, passphrase: secret.passphrase ?? ctx.cfg.SFTP_PASSPHRASE, root: remoteRoot, hostFingerprint: fingerprint, allowUnknownHost: ctx.cfg.SFTP_ALLOW_UNKNOWN_HOST, allowedExtensions: exts }),
    };
  }
  if (provider === 'local') {
    // Local roots are set by the server operator only (env), never from the browser.
    const root = ctx.cfg.LOCAL_DEPLOY_ROOT;
    const missing = root && existsSync(root) ? [] : ['LOCAL_DEPLOY_ROOT (an existing directory)'];
    return { ...base, fileBased: true, configured: !missing.length, missing, description: `Local directory ${root ?? '?'}`, open: () => new LocalFileStore(root!, exts) };
  }
  return { ...base, fileBased: false, configured: true, missing: [], description: provider === 'manual' ? 'Manual export – approved changes become instructions for your developer' : `${provider} adapter`, open: noStore };
}

/* ───────────────────────── Connection settings (UI) ───────────────────────── */

export async function deploymentStatus(ctx: AppContext, projectId: string) {
  const r = await resolveDeployment(ctx, projectId);
  const project = await getProject(ctx, projectId);
  const row = await connectionRow(ctx, projectId);
  const dep = (project.settings as { deployment?: Record<string, unknown> }).deployment ?? {};
  let hasPassword = false;
  let hasPrivateKey = false;
  if (row?.secret_encrypted) {
    try {
      const s = JSON.parse(decryptSecret(row.secret_encrypted, ctx.encryptionKey)) as ConnectionSecret;
      hasPassword = !!s.password;
      hasPrivateKey = !!s.privateKey;
    } catch {
      /* unreadable secret (key rotated) → treated as absent */
    }
  }
  return {
    provider: r.provider,
    mode: r.mode,
    fileBased: r.fileBased,
    configured: r.configured,
    connected: r.mode === 'demo' ? r.configured : row?.status === 'connected',
    missing: r.missing,
    description: r.description,
    source: r.source,
    verifyBaseUrl: r.verifyBaseUrl,
    liveEnabled: r.liveEnabled,
    liveEnabledBy: dep.liveEnabledBy ?? null,
    liveEnabledAt: dep.liveEnabledAt ?? null,
    lastTest: row ? { status: row.status, at: row.last_sync_at, error: row.last_error } : null,
    connection: { ...(row?.config ?? {}), hasPassword, hasPrivateKey },
    envProvider: ctx.cfg.WEBSITE_DEPLOYMENT_PROVIDER ?? ctx.cfg.WEBSITE_ADAPTER,
    deployableChangeTypes: r.fileBased ? FILE_DEPLOYABLE : [],
  };
}

export async function saveConnection(ctx: AppContext, projectId: string, actor: Actor, input: ConnectionConfig & ConnectionSecret & { clearSecret?: boolean }) {
  const project = await getProject(ctx, projectId);
  if (project.is_demo) throw new AppError('Demo projects always deploy to the local demo copy', 400, 'demo');
  const { password, privateKey, passphrase, clearSecret, ...config } = input;
  const existing = await connectionRow(ctx, projectId);
  let secret: ConnectionSecret = {};
  if (existing?.secret_encrypted && !clearSecret) {
    try {
      secret = JSON.parse(decryptSecret(existing.secret_encrypted, ctx.encryptionKey));
    } catch {
      secret = {};
    }
  }
  if (password) secret.password = password;
  if (privateKey) secret.privateKey = privateKey;
  if (passphrase) secret.passphrase = passphrase;
  const enc = Object.keys(secret).length ? encryptSecret(JSON.stringify(secret), ctx.encryptionKey) : null;
  await ctx.db.query(
    `INSERT INTO integrations(project_id, provider, status, config, secret_encrypted) VALUES ($1,'website_deploy','disconnected',$2,$3)
     ON CONFLICT (project_id, provider) DO UPDATE SET config = EXCLUDED.config, secret_encrypted = EXCLUDED.secret_encrypted, status = 'disconnected', last_error = NULL`,
    [projectId, config, enc],
  );
  // Any connection change switches live deployment off until an admin re-enables it after a new test.
  await setLive(ctx, projectId, actor, false, 'Connection settings changed');
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: 'deployment.connection_saved', details: redact({ ...config, password: password ? '***' : undefined, privateKey: privateKey ? '***' : undefined }) });
  return deploymentStatus(ctx, projectId);
}

/** Read-only connection test: connect, find the homepage file, compare it with the live homepage. No writes. */
export async function testConnection(ctx: AppContext, projectId: string, actor: Actor) {
  const r = await resolveDeployment(ctx, projectId);
  if (!r.fileBased) return { ok: true, provider: r.provider, message: `${r.provider} adapter: nothing to test here.`, steps: [] };
  if (!r.configured) return { ok: false, provider: r.provider, message: `NOT CONNECTED – missing: ${r.missing.join(', ')}`, steps: [] };
  const steps: { step: string; ok: boolean; detail: string }[] = [];
  let store: FileStore | null = null;
  let fingerprint: string | null = null;
  try {
    store = r.open();
    await store.connect();
    steps.push({ step: 'Connect', ok: true, detail: store.describe() });
    const home = (await store.exists('index.html')) ? 'index.html' : (await store.exists('index.htm')) ? 'index.htm' : null;
    steps.push({ step: 'Find homepage file', ok: !!home, detail: home ?? 'No index.html in the configured root – check the remote root directory' });
    if (home) {
      const remote = await store.read(home);
      const live = await fetchPageFields(ctx, r.verifyBaseUrl, r.siteUrl, r.siteUrl);
      const rf = fieldsFromHtml(remote, r.siteUrl, r.siteUrl);
      const same = !!live.fields && live.fields.title === rf.title && live.fields.h1 === rf.h1;
      steps.push({ step: 'Matches the live homepage', ok: same, detail: same ? `Title "${rf.title}" matches ${r.verifyBaseUrl}` : `Remote title "${rf.title}" vs live "${live.fields?.title ?? live.error}" – wrong root directory?` });
    }
    if (store instanceof SftpFileStore) fingerprint = store.seenFingerprint;
  } catch (e) {
    if (store instanceof SftpFileStore) fingerprint = store.seenFingerprint;
    steps.push({ step: 'Connect', ok: false, detail: (e as Error).message });
  } finally {
    await store?.close().catch(() => undefined);
  }
  const ok = steps.length > 0 && steps.every((s) => s.ok);
  if (r.mode === 'live') await ctx.db.query(`UPDATE integrations SET status = $2, last_sync_at = now(), last_error = $3 WHERE project_id = $1 AND provider = 'website_deploy'`, [projectId, ok ? 'connected' : 'error', ok ? null : steps.find((s) => !s.ok)?.detail ?? null]);
  if (r.mode === 'live' && r.source === 'env') {
    await ctx.db.query(`INSERT INTO integrations(project_id, provider, status, config, last_sync_at, last_error) VALUES ($1,'website_deploy',$2,'{}',now(),$3) ON CONFLICT (project_id, provider) DO NOTHING`, [projectId, ok ? 'connected' : 'error', ok ? null : steps.find((s) => !s.ok)?.detail ?? null]);
  }
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: 'deployment.connection_test', details: { ok, provider: r.provider } });
  return { ok, provider: r.provider, message: ok ? 'Connection works (read-only test, nothing was changed).' : 'Connection test failed.', steps, fingerprint };
}

export async function setLive(ctx: AppContext, projectId: string, actor: Actor, enabled: boolean, note?: string, confirmDomain?: string) {
  const project = await getProject(ctx, projectId);
  const site = await primaryWebsite(ctx, projectId);
  if (enabled) {
    if (project.is_demo) throw new AppError('Demo projects cannot deploy live', 400, 'demo');
    if (actor.role !== 'admin') throw new AppError('Only an admin can enable live deployment', 403, 'forbidden');
    const host = new URL(site.base_url).hostname.replace(/^www\./, '');
    if ((confirmDomain ?? '').trim().toLowerCase().replace(/^www\./, '') !== host) throw new AppError(`Type the domain (${host}) to confirm live deployment`, 400, 'confirmation_required');
    const r = await resolveDeployment(ctx, projectId);
    if (!r.configured) throw new AppError(`Deployment is not configured: ${r.missing.join(', ')}`, 409, 'not_configured');
    if (r.fileBased) {
      const row = await connectionRow(ctx, projectId);
      if (row?.status !== 'connected') throw new AppError('Run a successful connection test before enabling live deployment', 409, 'test_required');
    }
  }
  const dep = { ...((project.settings as { deployment?: Record<string, unknown> }).deployment ?? {}), liveEnabled: enabled, liveEnabledBy: enabled ? actor.label : null, liveEnabledAt: enabled ? new Date().toISOString() : null };
  await ctx.db.query(`UPDATE projects SET settings = jsonb_set(settings, '{deployment}', $2::jsonb), updated_at = now() WHERE id = $1`, [projectId, dep]);
  await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: enabled ? 'deployment.live_enabled' : 'deployment.live_disabled', details: { note } });
  return { liveEnabled: enabled };
}

/* ───────────────────────── Pipeline ───────────────────────── */

interface Step {
  step: string;
  status: 'done' | 'failed' | 'skipped';
  message: string;
  at: string;
}

async function transition(ctx: AppContext, changeId: string, to: string, actor: string, note: string, details: Record<string, unknown> = {}) {
  const cur = await ctx.db.one<{ status: string }>('SELECT status FROM seo_changes WHERE id = $1', [changeId]);
  await ctx.db.query('UPDATE seo_changes SET status = $2, updated_at = now() WHERE id = $1', [changeId, to]);
  await ctx.db.query('INSERT INTO change_events(change_id, from_status, to_status, actor, note, details) VALUES ($1,$2,$3,$4,$5,$6)', [changeId, cur?.status ?? null, to, actor, note, details]);
}

function pageTarget(pageUrl: string, r: ResolvedDeployment) {
  const u = new URL(pageUrl);
  const fetchUrl = new URL(u.pathname.replace(/^\//, '') + u.search, r.verifyBaseUrl.endsWith('/') ? r.verifyBaseUrl : r.verifyBaseUrl + '/').toString();
  return { pathname: u.pathname, fetchUrl };
}

async function locateFile(store: FileStore, pathname: string, allowed: string[]) {
  for (const c of candidateFilesForPath(pathname)) {
    try {
      guardPath(c, allowed);
    } catch {
      continue;
    }
    if (await store.exists(c)) return c;
  }
  return null;
}

class Tracker {
  steps: Step[] = [];
  constructor(
    private ctx: AppContext,
    private deploymentId: string,
  ) {}
  async add(step: string, status: Step['status'], message: string) {
    this.steps.push({ step, status, message, at: new Date().toISOString() });
    await this.ctx.db.query('UPDATE website_deployments SET steps = $2 WHERE id = $1', [this.deploymentId, this.steps]);
  }
}

async function finishDeployment(ctx: AppContext, id: string, fields: { status: string; verification_status?: string; error_message?: string | null; rollback_available?: boolean; restored_automatically?: boolean; target?: string }) {
  const keys = Object.keys(fields);
  await ctx.db.query(`UPDATE website_deployments SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, deployment_completed_at = now() WHERE id = $1`, [id, ...keys.map((k) => (fields as Record<string, unknown>)[k])]);
}

export interface PreviewResult {
  provider: string;
  mode: string;
  file: string | null;
  current: string | null;
  proposed: string | null;
  fileDiff: { before: string; after: string; line: number }[];
  checks: FieldCheck[];
  ok: boolean;
  message: string;
}

/** Dry run: load the real file, apply the change in memory and show exactly what would change. Writes nothing. */
export async function previewChange(ctx: AppContext, projectId: string, input: { changeType: string; pageUrl: string; newValue: string | null; oldValue?: string | null }): Promise<PreviewResult> {
  const r = await resolveDeployment(ctx, projectId);
  const base = { provider: r.provider, mode: r.mode, current: input.oldValue ?? null, proposed: input.newValue };
  if (!r.fileBased || !r.configured) return { ...base, file: null, fileDiff: [], checks: [], ok: false, message: r.fileBased ? `NOT CONNECTED – ${r.missing.join(', ')}` : 'Value preview only – the configured provider does not expose files.' };
  if (!FILE_DEPLOYABLE.includes(input.changeType) || !input.newValue) return { ...base, file: null, fileDiff: [], checks: [], ok: false, message: 'This change type is implemented manually (exported instructions), so there is no file preview.' };
  const store = r.open();
  try {
    await store.connect();
    const allowed = ctx.cfg.DEPLOY_ALLOWED_EXTENSIONS.split(',').map((e) => e.trim());
    const file = await locateFile(store, new URL(input.pageUrl).pathname, allowed);
    if (!file) return { ...base, file: null, fileDiff: [], checks: [], ok: false, message: `No file found for ${new URL(input.pageUrl).pathname}` };
    const before = await store.read(file);
    const after = applyHtmlChange(before, HTML_CHANGE_TYPE(input.changeType), input.newValue);
    if (after === null) return { ...base, file, fileDiff: [], checks: [], ok: false, message: `Could not safely locate the ${input.changeType} element in ${file}` };
    const fb = fieldsFromHtml(before, input.pageUrl, r.siteUrl);
    const fa = fieldsFromHtml(after, input.pageUrl, r.siteUrl);
    const checks = compareFields(input.changeType, input.newValue, fb, fa, r.siteUrl);
    return { ...base, current: currentValueOf(fb, input.changeType) ?? base.current, file, fileDiff: lineDiff(before, after), checks, ok: checks.every((c) => c.passed), message: checks.every((c) => c.passed) ? `Only the ${input.changeType.replace('_', ' ')} changes in ${file}.` : 'The edit would change other parts of the page – it will not be deployed.' };
  } finally {
    await store.close().catch(() => undefined);
  }
}

function currentValueOf(f: PageFields, changeType: string): string | null {
  const map: Record<string, keyof PageFields> = { title: 'title', meta_description: 'metaDescription', h1: 'h1', canonical: 'canonical', other: 'ogImage' };
  const k = map[changeType];
  return k ? ((f[k] as string | null) ?? null) : null;
}

/** Changed lines only (the edits are single elements, so this stays small). */
export function lineDiff(before: string, after: string): { before: string; after: string; line: number }[] {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const out: { before: string; after: string; line: number }[] = [];
  for (let i = 0; i <= Math.max(endA - start, endB - start) && out.length < 60; i++) out.push({ line: start + i + 1, before: (a[start + i] ?? '').slice(0, 2000), after: (b[start + i] ?? '').slice(0, 2000) });
  return out;
}

const RUNNING_STATES = ['running'];

// Backups are stored base64-encoded so they restore byte for byte (a leading BOM or unusual
// encoding would otherwise be normalised away by text decoding in the database driver).
const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const dec = (s: string | null) => (s === null ? null : Buffer.from(s, 'base64').toString('utf8'));

export async function deployChange(ctx: AppContext, projectId: string, changeId: string, actor: Actor = SYSTEM_ACTOR, opts: { wait?: boolean } = {}) {
  const ch = await ctx.db.one<any>('SELECT c.*, r.risk AS rec_risk FROM seo_changes c LEFT JOIN recommendations r ON r.id = c.recommendation_id WHERE c.id = $1 AND c.project_id = $2', [changeId, projectId]);
  if (!ch) throw new AppError('Change not found', 404, 'not_found');
  if (ch.approval_status !== 'approved') throw new AppError('Only approved changes can be deployed', 409, 'not_approved');
  if (!['approved', 'failed', 'verification_failed'].includes(ch.status)) throw new AppError(`Change is ${ch.status}`, 409, 'invalid_state');
  const risk = (ch.risk ?? ch.rec_risk ?? 'medium') as RiskLevel;
  if (!riskPolicy(risk).executable) throw new AppError('Critical changes are never executed by the platform', 403, 'forbidden');
  if (!ch.page_url) throw new AppError('Change has no page URL', 400, 'bad_request');
  const r = await resolveDeployment(ctx, projectId);
  if (!r.fileBased) throw new AppError('The configured provider is not file-based; use Implement (adapter/export) instead', 400, 'not_file_provider');
  if (!FILE_DEPLOYABLE.includes(ch.change_type) || !ch.new_value) throw new AppError(`${ch.change_type} changes are implemented manually (exported instructions), not deployed automatically`, 400, 'not_deployable');
  if (!r.configured) throw new AppError(`Website connection NOT CONNECTED – missing: ${r.missing.join(', ')}`, 409, 'not_configured');
  if (r.mode === 'live' && !r.liveEnabled) throw new AppError('Live deployment is switched off for this project. An admin must enable it in Settings → Deployment after a successful connection test.', 409, 'live_disabled');
  const busy = await ctx.db.one<{ id: string }>(`SELECT id FROM website_deployments WHERE project_id = $1 AND status = ANY($2::text[]) AND deployment_started_at > now() - interval '15 minutes'`, [projectId, RUNNING_STATES]);
  if (busy) throw new AppError(`Another deployment is running (${busy.id})`, 409, 'deployment_running', { deploymentId: busy.id });

  const dep = await ctx.db.one<{ id: string }>(`INSERT INTO website_deployments(project_id, change_id, action, provider, mode, status, created_by, verification_status) VALUES ($1,$2,'deploy',$3,$4,'running',$5,'pending') RETURNING id`, [projectId, changeId, r.provider, r.mode, actor.label]);
  await transition(ctx, changeId, 'deploying', actor.label, `Deployment ${dep!.id.slice(0, 8)} started (${r.mode})`, { deploymentId: dep!.id });
  await emitEvent(ctx, projectId, 'deployment.started', { deploymentId: dep!.id, changeId, mode: r.mode, provider: r.provider });
  const { orgOfProject, recordUsage } = await import('./tenancy.js');
  await recordUsage(ctx, (await orgOfProject(ctx, projectId)).id, projectId, 'deployments', 1, { mode: r.mode });
  const run = runDeployment(ctx, projectId, ch, r, dep!.id, actor).catch(async (e) => {
    ctx.log.error('deployment.crashed', { deploymentId: dep!.id, error: (e as Error).message });
    await finishDeployment(ctx, dep!.id, { status: 'failed', error_message: (e as Error).message, verification_status: 'skipped' });
    await transition(ctx, changeId, 'failed', 'system', `Deployment crashed: ${(e as Error).message}`);
    return { deploymentId: dep!.id, status: 'failed' };
  });
  if (opts.wait) return run;
  return { deploymentId: dep!.id, status: 'running' };
}

async function runDeployment(ctx: AppContext, projectId: string, ch: any, r: ResolvedDeployment, deploymentId: string, actor: Actor) {
  const t = new Tracker(ctx, deploymentId);
  const allowed = ctx.cfg.DEPLOY_ALLOWED_EXTENSIONS.split(',').map((e) => e.trim());
  const { pathname, fetchUrl } = pageTarget(ch.page_url, r);
  const fail = async (step: string, message: string, extra: { restore?: () => Promise<boolean> } = {}) => {
    await t.add(step, 'failed', message);
    let restored = false;
    if (extra.restore) {
      restored = await extra.restore().catch(() => false);
      await t.add('Restore backup', restored ? 'done' : 'failed', restored ? 'Original file restored and checksum confirmed' : 'Automatic restore FAILED – restore the backup manually from the deployment record');
    }
    await finishDeployment(ctx, deploymentId, { status: restored ? 'restored' : 'failed', error_message: message, verification_status: 'skipped', restored_automatically: restored, rollback_available: !restored });
    await transition(ctx, ch.id, 'failed', actor.label, `Deployment failed at "${step}": ${message}${restored ? ' (original restored)' : ''}`, { deploymentId });
    await raiseAlert(ctx, projectId, { severity: restored ? 'medium' : 'critical', type: 'deployment_failed', title: `Deployment failed: ${ch.change_type} on ${pathname}`, message: `${step}: ${message}. ${restored ? 'The original file was restored automatically.' : 'The site may be in an inconsistent state – check the deployment record.'}`, evidence: { deploymentId, changeId: ch.id }, fingerprint: `deploy:${deploymentId}` });
    await dispatchPending(ctx, projectId).catch(() => undefined);
    await emitEvent(ctx, projectId, 'deployment.failed', { deploymentId, changeId: ch.id, step, message, restored });
    return { deploymentId, status: restored ? 'restored' : 'failed', error: message };
  };

  await t.add('Validate change', 'done', `${ch.change_type} on ${pathname} · risk ${ch.risk ?? 'n/a'} · ${r.mode.toUpperCase()}`);
  let store: FileStore;
  try {
    store = r.open();
    await store.connect();
    await t.add('Connect', 'done', store.describe());
  } catch (e) {
    return fail('Connect', (e as Error).message);
  }
  try {
    const file = await locateFile(store, pathname, allowed);
    if (!file) return await fail('Locate target', `No deployable file for ${pathname} (tried ${candidateFilesForPath(pathname).join(', ')})`);
    await t.add('Locate target', 'done', file);
    await ctx.db.query('UPDATE website_deployments SET target = $2 WHERE id = $1', [deploymentId, file]);

    // Live page state before the change: every field except the target must still match afterwards.
    const liveBefore = await fetchPageFields(ctx, fetchUrl, ch.page_url, r.siteUrl);
    const original = await store.read(file);
    const originalSum = sha256Hex(original);
    const fileBefore = fieldsFromHtml(original, ch.page_url, r.siteUrl);
    const snap = await ctx.db.one<{ id: string }>(
      `INSERT INTO deployment_snapshots(deployment_id, change_id, project_id, kind, target, original_content, original_checksum, metadata) VALUES ($1,$2,$3,'file',$4,$5,$6,$7) RETURNING id`,
      [deploymentId, ch.id, projectId, file, enc(original), originalSum, { fileBefore, liveBefore: liveBefore.fields, liveStatusBefore: liveBefore.status, fetchUrl, encoding: 'base64', originalBytes: Buffer.byteLength(original) }],
    );
    await t.add('Create backup', 'done', `${file} · ${Buffer.byteLength(original)} bytes · sha256 ${originalSum.slice(0, 12)}…`);

    const currentValue = currentValueOf(fileBefore, ch.change_type);
    if (ch.old_value && currentValue !== null && ch.change_type !== 'schema' && currentValue.replace(/\s+/g, ' ').trim() !== String(ch.old_value).replace(/\s+/g, ' ').trim()) {
      return await fail('Validate current state', `The page changed since the recommendation (expected "${ch.old_value}", found "${currentValue}"). Re-run the audit and approve a fresh proposal.`);
    }
    const updated = applyHtmlChange(original, HTML_CHANGE_TYPE(ch.change_type), ch.new_value);
    if (updated === null) return await fail('Apply change', `Could not safely locate the ${ch.change_type} element in ${file}`);
    const fileAfter = fieldsFromHtml(updated, ch.page_url, r.siteUrl);
    const editChecks = compareFields(ch.change_type, ch.new_value, fileBefore, fileAfter, r.siteUrl);
    if (!editChecks.every((c) => c.passed)) return await fail('Validate edit', `The edit would also change: ${editChecks.filter((c) => !c.passed).map((c) => c.field).join(', ')}`);
    const newSum = sha256Hex(updated);
    await ctx.db.query('UPDATE deployment_snapshots SET new_content = $2, new_checksum = $3, metadata = metadata || $4 WHERE id = $1', [snap!.id, enc(updated), newSum, { fileAfter, newBytes: Buffer.byteLength(updated) }]);
    await t.add('Apply change', 'done', `${lineDiff(original, updated).length} line(s) changed in memory; all other SEO fields unchanged`);

    const restore = async () => {
      await store.write(file, original);
      return sha256Hex(await store.read(file)) === originalSum;
    };
    try {
      await store.write(file, updated);
    } catch (e) {
      return await fail('Upload', (e as Error).message, { restore });
    }
    const remoteSum = sha256Hex(await store.read(file));
    if (remoteSum !== newSum) return await fail('Checksum', `Remote checksum ${remoteSum.slice(0, 12)}… does not match the uploaded file`, { restore });
    await t.add('Deploy', 'done', `Uploaded ${file}; checksum verified`);
    await ctx.db.query('UPDATE seo_changes SET deployed_at = now(), implemented_at = now(), implemented_by = $2, adapter = $3, adapter_ref = $4 WHERE id = $1', [ch.id, actor.label, r.provider, `deployment:${deploymentId}`]);
    await finishDeployment(ctx, deploymentId, { status: 'deployed', rollback_available: true });
    await transition(ctx, ch.id, 'deployed', actor.label, `Deployed ${file} (${r.mode})`, { deploymentId });

    const v = await verifyLivePage(ctx, { fetchUrl, pageUrl: ch.page_url, siteUrl: r.siteUrl, changeType: ch.change_type, expectedValue: ch.new_value, before: liveBefore.fields });
    await ctx.db.query('INSERT INTO deployment_verifications(deployment_id, change_id, url, http_status, passed, checks, error) VALUES ($1,$2,$3,$4,$5,$6,$7)', [deploymentId, ch.id, fetchUrl, v.httpStatus, v.passed, v.checks, v.error]);
    if (v.httpStatus === null || v.httpStatus >= 500 || v.httpStatus === 404) {
      // The page is broken after our upload: put the original back immediately.
      return await fail('HTTP check', `Page returned ${v.httpStatus ?? 'no response'} after deployment`, { restore });
    }
    await t.add('HTTP check', 'done', `HTTP ${v.httpStatus}`);
    for (const c of v.checks.filter((c) => c.kind !== 'http')) await t.add(`Verify ${c.field}`, c.passed ? 'done' : 'failed', c.passed ? String(c.actual ?? '—').slice(0, 160) : `expected "${String(c.expected).slice(0, 120)}", got "${String(c.actual).slice(0, 120)}"`);
    const verification = { checkedAt: new Date().toISOString(), live: v.passed, observed: v.after ? currentValueOf(v.after, ch.change_type) : null, checks: v.checks, attempts: v.attempts };
    await ctx.db.query('UPDATE seo_changes SET verification = $2 WHERE id = $1', [ch.id, verification]);
    if (!v.passed) {
      await finishDeployment(ctx, deploymentId, { status: 'verification_failed', verification_status: 'failed', error_message: v.error, rollback_available: true });
      await transition(ctx, ch.id, 'verification_failed', 'system', `Live page does not match: ${v.error}`, { deploymentId });
      await raiseAlert(ctx, projectId, { severity: 'high', type: 'deployment_verification_failed', title: `Deployed change not verified on ${pathname}`, message: `${v.error}. The file was uploaded, but the live page does not show the expected result (cache or another rule may interfere). Review and roll back if needed.`, evidence: { deploymentId, changeId: ch.id }, fingerprint: `deploy-verify:${deploymentId}` });
      await dispatchPending(ctx, projectId).catch(() => undefined);
      await emitEvent(ctx, projectId, 'deployment.completed', { deploymentId, changeId: ch.id, status: 'verification_failed' });
      await emitEvent(ctx, projectId, 'verification.completed', { deploymentId, changeId: ch.id, passed: false, error: v.error });
      return { deploymentId, status: 'verification_failed', error: v.error };
    }
    await finishDeployment(ctx, deploymentId, { status: 'verified', verification_status: 'passed', rollback_available: true });
    const { completeVerification } = await import('./changes.js');
    await completeVerification(ctx, projectId, ch.id, actor.label, verification, 'deployed');
    await t.add('Verified', 'done', 'Live page matches the approved change');
    const reaudit = await refreshAuditAfterDeploy(ctx, projectId, ch.page_url, v.html, actor.label).catch((e) => ({ error: (e as Error).message }));
    await t.add('Update SEO score', 'error' in reaudit ? 'failed' : 'done', 'error' in reaudit ? reaudit.error : `Audit re-scored: ${reaudit.auditScore}/100`);
    await emitEvent(ctx, projectId, 'deployment.completed', { deploymentId, changeId: ch.id, status: 'verified', auditScore: 'auditScore' in reaudit ? reaudit.auditScore : null });
    await emitEvent(ctx, projectId, 'verification.completed', { deploymentId, changeId: ch.id, passed: true });
    await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: 'deployment.verified', entityType: 'seo_change', entityId: ch.id, details: { deploymentId, file, mode: r.mode } });
    return { deploymentId, status: 'verified', auditScore: 'auditScore' in reaudit ? reaudit.auditScore : null };
  } finally {
    await store.close().catch(() => undefined);
  }
}

/**
 * Re-score after a deployment without re-crawling the whole site: the latest crawl with the deployed
 * page replaced by its fresh HTML, analysed and stored like any crawl (issues resolve, audit recorded).
 */
export async function refreshAuditAfterDeploy(ctx: AppContext, projectId: string, pageUrl: string, html: string | null, by: string) {
  if (!html) throw new Error('No page HTML to re-score');
  const site = await primaryWebsite(ctx, projectId);
  const crawl = await latestCrawl(ctx, site.id);
  if (!crawl) throw new Error('No crawl to update – run an audit');
  const { pages } = await latestCrawledPages(ctx, projectId);
  const idx = pages.findIndex((p) => p.url === pageUrl || p.finalUrl === pageUrl);
  if (idx < 0) throw new Error('Page not in the latest crawl – run a full audit');
  pages[idx] = applyHtmlToPage({ ...pages[idx]! }, html, site.base_url);
  const now = new Date().toISOString();
  const out: CrawlOutput = { startedAt: now, finishedAt: now, baseUrl: site.base_url, pages, site: crawl.site_checks, externalLinkStatus: {}, stats: { pagesCrawled: pages.length, pagesFailed: 0, durationMs: 0, truncated: false } };
  const { runCrawl } = await import('./crawl.js');
  return runCrawl(ctx, projectId, { trigger: 'post-deployment', aiSummary: false, createdBy: by }, out);
}

/* ───────────────────────── Rollback ───────────────────────── */

/**
 * Restores the previous version of a deployed change. If the file is exactly what we deployed, the
 * backup is restored byte for byte; if someone edited it since, only our element is reverted so their
 * later edits survive. Then the page is re-crawled and verified against the old value.
 */
export async function rollbackDeployment(ctx: AppContext, projectId: string, changeId: string, actor: Actor, reason?: string) {
  if (actor.role !== 'admin') throw new AppError('Only admins can roll back changes', 403, 'forbidden');
  const ch = await ctx.db.one<any>('SELECT * FROM seo_changes WHERE id = $1 AND project_id = $2', [changeId, projectId]);
  if (!ch) throw new AppError('Change not found', 404, 'not_found');
  const snap = await ctx.db.one<any>(`SELECT s.*, d.mode, d.provider FROM deployment_snapshots s JOIN website_deployments d ON d.id = s.deployment_id WHERE s.change_id = $1 AND d.action = 'deploy' AND d.status IN ('deployed','verified','verification_failed') ORDER BY s.created_at DESC LIMIT 1`, [changeId]);
  if (!snap) throw new AppError('No deployment backup for this change', 409, 'no_snapshot');
  const r = await resolveDeployment(ctx, projectId);
  if (!r.fileBased || !r.configured) throw new AppError(`Website connection NOT CONNECTED – ${r.missing.join(', ')}`, 409, 'not_configured');
  if (r.mode === 'live' && !r.liveEnabled) throw new AppError('Live deployment is switched off for this project', 409, 'live_disabled');
  const dep = await ctx.db.one<{ id: string }>(`INSERT INTO website_deployments(project_id, change_id, action, provider, mode, status, created_by, target, verification_status) VALUES ($1,$2,'rollback',$3,$4,'running',$5,$6,'pending') RETURNING id`, [projectId, changeId, r.provider, r.mode, actor.label, snap.target]);
  const t = new Tracker(ctx, dep!.id);
  const store = r.open();
  const { fetchUrl } = pageTarget(ch.page_url, r);
  try {
    await store.connect();
    await t.add('Connect', 'done', store.describe());
    const current = await store.read(snap.target);
    const currentSum = sha256Hex(current);
    let restored: string;
    let how: string;
    if (currentSum === snap.new_checksum) {
      restored = dec(snap.original_content)!;
      if (sha256Hex(restored) !== snap.original_checksum) throw new AppError('Backup is corrupt (checksum mismatch) – restore manually', 500, 'backup_corrupt');
      how = 'File unchanged since deployment – full backup restored';
    } else if (currentSum === snap.original_checksum) {
      restored = current;
      how = 'File already matches the backup';
    } else {
      // Only a REAL previous value (read from the backed-up file) can be re-applied element-wise.
      const previous = snap.metadata?.fileBefore ? currentValueOf(snap.metadata.fileBefore as PageFields, ch.change_type) : null;
      const reverted = previous ? applyHtmlChange(current, HTML_CHANGE_TYPE(ch.change_type), previous) : null;
      if (reverted === null) throw new AppError('The file was edited after deployment and the previous value cannot be re-applied safely – restore manually from the backup', 409, 'manual_restore_required');
      restored = reverted;
      how = 'File edited since deployment – only this change was reverted';
    }
    await ctx.db.query(`INSERT INTO deployment_snapshots(deployment_id, change_id, project_id, kind, target, original_content, original_checksum, new_content, new_checksum, metadata) VALUES ($1,$2,$3,'file',$4,$5,$6,$7,$8,$9)`, [dep!.id, changeId, projectId, snap.target, enc(current), currentSum, enc(restored), sha256Hex(restored), { rollbackOf: snap.deployment_id, encoding: 'base64', originalBytes: Buffer.byteLength(current), newBytes: Buffer.byteLength(restored) }]);
    await t.add('Backup current version', 'done', `sha256 ${currentSum.slice(0, 12)}…`);
    await store.write(snap.target, restored);
    if (sha256Hex(await store.read(snap.target)) !== sha256Hex(restored)) throw new Error('Checksum mismatch after restore');
    await t.add('Restore previous version', 'done', how);
    // The page must look exactly like it did before the deployment (every recorded SEO field).
    const before = (snap.metadata?.liveBefore ?? snap.metadata?.fileBefore ?? null) as PageFields | null;
    const v = await verifyLivePage(ctx, { fetchUrl, pageUrl: ch.page_url, siteUrl: r.siteUrl, changeType: 'rollback', expectedValue: null, before });
    await ctx.db.query('INSERT INTO deployment_verifications(deployment_id, change_id, url, http_status, passed, checks, error) VALUES ($1,$2,$3,$4,$5,$6,$7)', [dep!.id, changeId, fetchUrl, v.httpStatus, v.passed, v.checks, v.error]);
    await t.add('Verify previous version', v.passed ? 'done' : 'failed', v.passed ? `HTTP ${v.httpStatus}; previous value is live` : v.error ?? 'mismatch');
    await finishDeployment(ctx, dep!.id, { status: v.passed ? 'verified' : 'verification_failed', verification_status: v.passed ? 'passed' : 'failed', error_message: v.passed ? null : v.error });
    await ctx.db.query('UPDATE website_deployments SET rollback_available = false WHERE change_id = $1 AND action = $2', [changeId, 'deploy']);
    await ctx.db.query('UPDATE seo_changes SET rolled_back_at = now() WHERE id = $1', [changeId]);
    // The change is undone: its recommendation goes back to review (proposal kept) so it can be fixed again.
    await ctx.db.query("UPDATE recommendations SET status = 'recommended', updated_at = now() WHERE id = $1", [ch.recommendation_id]);
    await transition(ctx, changeId, 'rolled_back', actor.label, reason ?? how, { deploymentId: dep!.id, verified: v.passed });
    await ctx.db.query(`UPDATE experiments SET status = 'cancelled', conclusion = 'Change rolled back', updated_at = now() WHERE change_id = $1 AND status = 'running'`, [changeId]);
    const reaudit = await refreshAuditAfterDeploy(ctx, projectId, ch.page_url, v.html, actor.label).catch(() => null);
    await t.add('Update SEO score', reaudit ? 'done' : 'skipped', reaudit ? `Audit re-scored: ${reaudit.auditScore}/100` : 'Re-score skipped');
    await audit(ctx, { projectId, actorType: actor.type, actorId: actor.id, actorLabel: actor.label, action: 'change.rollback', entityType: 'seo_change', entityId: changeId, details: { reason, deploymentId: dep!.id, how } });
    await emitEvent(ctx, projectId, 'rollback.completed', { changeId, deploymentId: dep!.id, verified: v.passed });
    return { ok: true, deploymentId: dep!.id, verified: v.passed, message: how };
  } catch (e) {
    await t.add('Rollback', 'failed', (e as Error).message);
    await finishDeployment(ctx, dep!.id, { status: 'failed', error_message: (e as Error).message, verification_status: 'skipped' });
    if (e instanceof AppError) throw e;
    throw new AppError(`Rollback failed: ${(e as Error).message}`, 502, 'rollback_failed');
  } finally {
    await store.close().catch(() => undefined);
  }
}

export async function listDeployments(ctx: AppContext, projectId: string, changeId?: string) {
  return ctx.db.query(
    `SELECT d.*, c.page_url, c.change_type FROM website_deployments d JOIN seo_changes c ON c.id = d.change_id WHERE d.project_id = $1 AND ($2::uuid IS NULL OR d.change_id = $2) ORDER BY d.created_at DESC LIMIT 200`,
    [projectId, changeId ?? null],
  );
}

export async function getDeployment(ctx: AppContext, projectId: string, id: string) {
  const d = await ctx.db.one<any>('SELECT d.*, c.page_url, c.change_type, c.old_value, c.new_value FROM website_deployments d JOIN seo_changes c ON c.id = d.change_id WHERE d.id = $1 AND d.project_id = $2', [id, projectId]);
  if (!d) throw new AppError('Deployment not found', 404, 'not_found');
  const verifications = await ctx.db.query('SELECT id, url, http_status, passed, checks, error, created_at FROM deployment_verifications WHERE deployment_id = $1 ORDER BY created_at', [id]);
  // Backups are listed with checksums/sizes; full file contents stay server-side.
  const snapshots = await ctx.db.query(`SELECT id, kind, target, original_checksum, new_checksum, (metadata->>'originalBytes')::int AS original_bytes, (metadata->>'newBytes')::int AS new_bytes, created_at FROM deployment_snapshots WHERE deployment_id = $1`, [id]);
  const diff = await ctx.db.one<any>('SELECT original_content, new_content FROM deployment_snapshots WHERE deployment_id = $1 ORDER BY created_at LIMIT 1', [id]);
  return { ...d, verifications, snapshots, fileDiff: diff?.original_content && diff?.new_content ? lineDiff(dec(diff.original_content)!, dec(diff.new_content)!) : [] };
}

export { DeployPathError };

/**
 * Scheduled re-verification: deployments flagged VERIFICATION_FAILED in the last 48 h are checked
 * again (CDN/page caches often catch up). Passing ones become VERIFIED; the rest stay flagged.
 */
export async function reverifyDeployments(ctx: AppContext, projectId: string) {
  const rows = await ctx.db.query<any>(
    `SELECT d.id AS deployment_id, c.id AS change_id, c.page_url, c.change_type, c.new_value, s.metadata
     FROM website_deployments d JOIN seo_changes c ON c.id = d.change_id JOIN deployment_snapshots s ON s.deployment_id = d.id
     WHERE d.project_id = $1 AND d.action = 'deploy' AND d.status = 'verification_failed' AND c.status = 'verification_failed' AND d.created_at > now() - interval '48 hours'`,
    [projectId],
  );
  if (!rows.length) return { checked: 0, verified: 0, stillFailing: 0 };
  const r = await resolveDeployment(ctx, projectId);
  let verified = 0;
  for (const row of rows) {
    const { fetchUrl } = pageTarget(row.page_url, r);
    const v = await verifyLivePage(ctx, { fetchUrl, pageUrl: row.page_url, siteUrl: r.siteUrl, changeType: row.change_type, expectedValue: row.new_value, before: row.metadata?.liveBefore ?? null }, { retries: 0 });
    await ctx.db.query('INSERT INTO deployment_verifications(deployment_id, change_id, url, http_status, passed, checks, error) VALUES ($1,$2,$3,$4,$5,$6,$7)', [row.deployment_id, row.change_id, fetchUrl, v.httpStatus, v.passed, v.checks, v.error]);
    if (!v.passed) continue;
    verified++;
    await ctx.db.query(`UPDATE website_deployments SET status = 'verified', verification_status = 'passed', error_message = NULL WHERE id = $1`, [row.deployment_id]);
    const { completeVerification } = await import('./changes.js');
    await completeVerification(ctx, projectId, row.change_id, 'system', { checkedAt: new Date().toISOString(), live: true, checks: v.checks, note: 'Verified on re-check' }, 'verification_failed');
    await refreshAuditAfterDeploy(ctx, projectId, row.page_url, v.html, 'system').catch(() => undefined);
    await emitEvent(ctx, projectId, 'verification.completed', { deploymentId: row.deployment_id, changeId: row.change_id, passed: true, recheck: true });
  }
  return { checked: rows.length, verified, stillFailing: rows.length - verified };
}
