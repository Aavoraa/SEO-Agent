import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HIGH_RISK_TYPES, type AppConfig } from '@phoenixx/shared';
import { candidateFilesForPath, replaceJsonLd, setCanonical, setH1, setMetaName, setMetaProperty, setTitle } from './html-edit.js';

const exec = promisify(execFile);

export interface ChangeRequest {
  changeId: string;
  pageUrl: string;
  changeType: string;
  oldValue: string | null;
  newValue: string;
  reason?: string;
  approvedBy?: string;
}

export interface AdapterResult {
  ok: boolean;
  /** true = change is live/committed; false = exported for a human to deploy. */
  applied: boolean;
  ref: string | null;
  details: Record<string, unknown>;
  message: string;
}

/**
 * All website changes go through an adapter AFTER approval. Every adapter must be able to
 * reverse what it did (rollback) using the stored before/after values.
 */
export interface WebsiteAdapter {
  readonly name: 'manual' | 'git' | 'wordpress' | 'api';
  supports(changeType: string): boolean;
  apply(change: ChangeRequest): Promise<AdapterResult>;
  rollback(change: ChangeRequest, ref: string | null): Promise<AdapterResult>;
}

/* ───────────── Manual export (always available, zero risk) ───────────── */

export class ManualExportAdapter implements WebsiteAdapter {
  readonly name = 'manual' as const;
  constructor(private exportDir: string) {}
  supports() {
    return true;
  }
  private write(change: ChangeRequest, kind: 'apply' | 'rollback'): AdapterResult {
    const dir = path.resolve(this.exportDir, change.changeId);
    mkdirSync(dir, { recursive: true });
    const from = kind === 'apply' ? change.oldValue : change.newValue;
    const to = kind === 'apply' ? change.newValue : change.oldValue;
    const record = { changeId: change.changeId, action: kind, page: change.pageUrl, changeType: change.changeType, from, to, reason: change.reason, approvedBy: change.approvedBy, exportedAt: new Date().toISOString() };
    writeFileSync(path.join(dir, `${kind}.json`), JSON.stringify(record, null, 2));
    const csvEsc = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    writeFileSync(path.join(dir, `${kind}.csv`), 'change_id,page,change_type,from,to\n' + [change.changeId, change.pageUrl, change.changeType, from, to].map(csvEsc).join(',') + '\n');
    writeFileSync(
      path.join(dir, `${kind}.md`),
      [
        `# SEO change ${change.changeId} – ${kind === 'apply' ? 'implementation' : 'rollback'} instructions`,
        '',
        `**Page:** ${change.pageUrl}`,
        `**Change type:** ${change.changeType}`,
        change.reason ? `**Reason:** ${change.reason}` : '',
        change.approvedBy ? `**Approved by:** ${change.approvedBy}` : '',
        HIGH_RISK_TYPES.includes(change.changeType as never) ? '\n> ⚠️ HIGH-RISK change (URL / indexing). Deploy carefully and re-crawl immediately after.\n' : '',
        '## Current value',
        '```',
        from ?? '(none)',
        '```',
        '## New value',
        '```',
        to ?? '(none)',
        '```',
        '',
        'After deploying, run **Verify** on this change in the dashboard (or wait for the scheduled verification workflow).',
      ]
        .filter((l) => l !== '')
        .join('\n'),
    );
    return { ok: true, applied: false, ref: dir, details: { files: [`${kind}.json`, `${kind}.csv`, `${kind}.md`] }, message: `Exported ${kind} instructions to ${dir}. A developer must deploy the change.` };
  }
  async apply(change: ChangeRequest) {
    return this.write(change, 'apply');
  }
  async rollback(change: ChangeRequest) {
    return this.write(change, 'rollback');
  }
}

/* ───────────── Git adapter (static HTML repositories – fits the current phoenixxit.com) ───────────── */

export function applyHtmlChange(html: string, changeType: string, value: string): string | null {
  switch (changeType) {
    case 'title':
      return setTitle(html, value);
    case 'meta_description':
      return setMetaName(html, 'description', value);
    case 'h1':
      return setH1(html, value);
    case 'canonical':
      return setCanonical(html, value);
    case 'schema': {
      const types = [...value.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!).filter((t) => !['PostalAddress', 'GeoCoordinates', 'ContactPoint', 'ListItem', 'Question', 'Answer', 'Place', 'City', 'State', 'Country', 'ImageObject', 'Person'].includes(t));
      return replaceJsonLd(html, value, types);
    }
    case 'og_image':
      return setMetaProperty(html, 'og:image', value);
    default:
      return null;
  }
}

export class GitAdapter implements WebsiteAdapter {
  readonly name = 'git' as const;
  constructor(
    private repoPath: string,
    private opts: { branchPrefix: string; push?: boolean; remote?: string; authorName?: string; authorEmail?: string } = { branchPrefix: 'seo-agent/' },
  ) {}
  supports(changeType: string) {
    return ['title', 'meta_description', 'h1', 'canonical', 'schema', 'og_image'].includes(changeType);
  }
  private git(...args: string[]) {
    return exec('git', ['-C', this.repoPath, ...args], { maxBuffer: 10 * 1024 * 1024 });
  }
  private resolveFile(pageUrl: string): string | null {
    const pathname = new URL(pageUrl).pathname;
    for (const c of candidateFilesForPath(pathname)) if (existsSync(path.join(this.repoPath, c))) return c;
    return null;
  }
  private async commitChange(change: ChangeRequest, value: string, label: string): Promise<AdapterResult> {
    if (!existsSync(path.join(this.repoPath, '.git'))) return { ok: false, applied: false, ref: null, details: {}, message: `WEBSITE_REPO_PATH (${this.repoPath}) is not a git repository.` };
    const file = this.resolveFile(change.pageUrl);
    if (!file) return { ok: false, applied: false, ref: null, details: {}, message: `No file in the repository matches ${change.pageUrl}.` };
    const { stdout: status } = await this.git('status', '--porcelain');
    if (status.trim()) return { ok: false, applied: false, ref: null, details: { status }, message: 'Website repository has uncommitted changes – refusing to modify it.' };
    const abs = path.join(this.repoPath, file);
    const before = readFileSync(abs, 'utf8');
    const after = applyHtmlChange(before, change.changeType, value);
    if (after === null) return { ok: false, applied: false, ref: null, details: { file }, message: `Could not safely apply a ${change.changeType} change to ${file}.` };
    if (after === before) return { ok: true, applied: true, ref: null, details: { file }, message: 'File already contains this value – nothing to commit.' };
    const { stdout: current } = await this.git('rev-parse', '--abbrev-ref', 'HEAD');
    const branch = `${this.opts.branchPrefix}${change.changeId.slice(0, 8)}-${label}`;
    await this.git('checkout', '-B', branch);
    writeFileSync(abs, after);
    await this.git('add', file);
    const author = [`-c`, `user.name=${this.opts.authorName ?? 'Phoenixx SEO Agent'}`, `-c`, `user.email=${this.opts.authorEmail ?? 'seo-agent@phoenixxit.com'}`];
    await exec('git', ['-C', this.repoPath, ...author, 'commit', '-m', `seo(${change.changeType}): ${label} ${new URL(change.pageUrl).pathname}\n\nChange-Id: ${change.changeId}\nApproved-By: ${change.approvedBy ?? 'unknown'}\nReason: ${change.reason ?? ''}`]);
    const { stdout: sha } = await this.git('rev-parse', 'HEAD');
    if (this.opts.push) await this.git('push', this.opts.remote ?? 'origin', branch);
    await this.git('checkout', current.trim());
    return { ok: true, applied: false, ref: `${branch}@${sha.trim()}`, details: { file, branch, commit: sha.trim(), pushed: !!this.opts.push }, message: `Committed to branch ${branch}${this.opts.push ? ' and pushed' : ''}. Merge and deploy to publish, then verify.` };
  }
  apply(change: ChangeRequest) {
    return this.commitChange(change, change.newValue, 'apply');
  }
  rollback(change: ChangeRequest) {
    if (change.oldValue === null) return Promise.resolve({ ok: false, applied: false, ref: null, details: {}, message: 'No previous value stored – rollback must be done manually.' } as AdapterResult);
    return this.commitChange(change, change.oldValue, 'rollback');
  }
}

/* ───────────── WordPress (for a future WP-based redesign) ───────────── */

export class WordPressAdapter implements WebsiteAdapter {
  readonly name = 'wordpress' as const;
  constructor(private cfg: { url: string; user: string; appPassword: string; metaDescriptionKey?: string }) {}
  supports(t: string) {
    return t === 'title' || (t === 'meta_description' && !!this.cfg.metaDescriptionKey);
  }
  private auth() {
    return 'Basic ' + Buffer.from(`${this.cfg.user}:${this.cfg.appPassword}`).toString('base64');
  }
  private async findPost(pageUrl: string): Promise<{ id: number; type: 'pages' | 'posts' } | null> {
    const slug = new URL(pageUrl).pathname.split('/').filter(Boolean).pop() ?? '';
    for (const type of ['pages', 'posts'] as const) {
      const r = await fetch(`${this.cfg.url.replace(/\/$/, '')}/wp-json/wp/v2/${type}?slug=${encodeURIComponent(slug)}&_fields=id`, { headers: { authorization: this.auth() } });
      const j = (await r.json()) as { id: number }[];
      if (Array.isArray(j) && j[0]) return { id: j[0].id, type };
    }
    return null;
  }
  private async update(change: ChangeRequest, value: string): Promise<AdapterResult> {
    const post = await this.findPost(change.pageUrl);
    if (!post) return { ok: false, applied: false, ref: null, details: {}, message: `WordPress post/page not found for ${change.pageUrl}` };
    // SEO-plugin title fields vary; we update the post title only for 'title' – configure plugin fields explicitly if needed.
    const body = change.changeType === 'title' ? { title: value } : { meta: { [this.cfg.metaDescriptionKey!]: value } };
    const r = await fetch(`${this.cfg.url.replace(/\/$/, '')}/wp-json/wp/v2/${post.type}/${post.id}`, { method: 'POST', headers: { authorization: this.auth(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return { ok: false, applied: false, ref: null, details: { status: r.status }, message: `WordPress update failed: ${r.status}` };
    return { ok: true, applied: true, ref: `${post.type}/${post.id}`, details: body, message: `Updated WordPress ${post.type} ${post.id}` };
  }
  apply(change: ChangeRequest) {
    return this.update(change, change.newValue);
  }
  rollback(change: ChangeRequest) {
    return this.update(change, change.oldValue ?? '');
  }
}

/* ───────────── Generic API adapter (custom CMS / headless) ───────────── */

export class ApiAdapter implements WebsiteAdapter {
  readonly name = 'api' as const;
  constructor(private cfg: { url: string; token?: string }) {}
  supports() {
    return true;
  }
  private async send(action: 'apply' | 'rollback', change: ChangeRequest): Promise<AdapterResult> {
    const r = await fetch(this.cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}) }, body: JSON.stringify({ action, ...change }) });
    const text = await r.text();
    return { ok: r.ok, applied: r.ok, ref: r.headers.get('x-change-ref'), details: { status: r.status, body: text.slice(0, 1000) }, message: r.ok ? `Website API accepted ${action}` : `Website API responded ${r.status}` };
  }
  apply(change: ChangeRequest) {
    return this.send('apply', change);
  }
  rollback(change: ChangeRequest) {
    return this.send('rollback', change);
  }
}

export function adapterFromConfig(cfg: AppConfig): WebsiteAdapter {
  // WEBSITE_DEPLOYMENT_PROVIDER wins; file providers (ftp/sftp/local) use the deployment pipeline and
  // fall back to manual export here for change types that can't be deployed as files.
  const p = cfg.WEBSITE_DEPLOYMENT_PROVIDER;
  const kind = p && ['manual', 'git', 'wordpress', 'api'].includes(p) ? p : p ? 'manual' : cfg.WEBSITE_ADAPTER;
  switch (kind) {
    case 'git':
      if (!cfg.WEBSITE_REPO_PATH) throw new Error('WEBSITE_ADAPTER=git requires WEBSITE_REPO_PATH');
      return new GitAdapter(cfg.WEBSITE_REPO_PATH, { branchPrefix: cfg.WEBSITE_GIT_BRANCH_PREFIX });
    case 'wordpress':
      if (!cfg.WORDPRESS_URL || !cfg.WORDPRESS_USER || !cfg.WORDPRESS_APP_PASSWORD) throw new Error('WEBSITE_ADAPTER=wordpress requires WORDPRESS_URL, WORDPRESS_USER and WORDPRESS_APP_PASSWORD');
      return new WordPressAdapter({ url: cfg.WORDPRESS_URL, user: cfg.WORDPRESS_USER, appPassword: cfg.WORDPRESS_APP_PASSWORD });
    case 'api':
      if (!cfg.WEBSITE_API_URL) throw new Error('WEBSITE_ADAPTER=api requires WEBSITE_API_URL');
      return new ApiAdapter({ url: cfg.WEBSITE_API_URL, token: cfg.WEBSITE_API_TOKEN });
    default:
      return new ManualExportAdapter(cfg.EXPORT_DIR);
  }
}
