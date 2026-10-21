import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

/**
 * Remote file access for static websites (e.g. GoDaddy cPanel hosting). The deployment pipeline
 * only ever reads, overwrites (via temp file + rename) and checksums files that pass `guardPath`;
 * there is no delete, chmod or directory operation exposed to callers.
 */
export interface FileStore {
  readonly kind: 'local' | 'ftp' | 'sftp';
  /** Human description without secrets, e.g. "ftps://user@host:21/public_html". */
  describe(): string;
  connect(): Promise<void>;
  exists(rel: string): Promise<boolean>;
  read(rel: string): Promise<string>;
  /** Replace a file's content (write to a temp file, then rename over the original). */
  write(rel: string, content: string): Promise<void>;
  close(): Promise<void>;
}

export class DeployPathError extends Error {}

export const DEFAULT_ALLOWED_EXTENSIONS = ['.html', '.htm'];
const DENIED_SEGMENTS = new Set(['cgi-bin', '.well-known', '.git', '.ssh', 'wp-admin', 'wp-includes', 'node_modules', 'vendor', '.htpasswd', '.htaccess']);
export const MAX_DEPLOY_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Validates a path relative to the configured web root: no traversal, no absolute paths, no hidden
 * or system directories, only allow-listed extensions (HTML by default – never PHP, JS, .htaccess).
 */
export function guardPath(rel: string, allowedExtensions: string[] = DEFAULT_ALLOWED_EXTENSIONS): string {
  if (typeof rel !== 'string' || !rel || rel.length > 300) throw new DeployPathError('Invalid path');
  if (/[\0\\]/.test(rel) || rel.startsWith('/') || /^[a-z]:/i.test(rel)) throw new DeployPathError(`Path must be relative to the web root: ${rel}`);
  const norm = path.posix.normalize(rel);
  if (norm.startsWith('..') || norm.split('/').some((s) => s === '..' || s === '')) throw new DeployPathError(`Path traversal is not allowed: ${rel}`);
  for (const seg of norm.split('/')) {
    if (DENIED_SEGMENTS.has(seg.toLowerCase()) || (seg.startsWith('.') && seg.length > 1)) throw new DeployPathError(`Protected location: ${rel}`);
  }
  const ext = path.posix.extname(norm).toLowerCase();
  if (!allowedExtensions.includes(ext)) throw new DeployPathError(`File type ${ext || '(none)'} is not allowed for deployment (allowed: ${allowedExtensions.join(', ')})`);
  return norm;
}

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const tempName = (rel: string) => `${rel}.seo-agent-${Date.now().toString(36)}.tmp`;
const joinRemote = (root: string, rel: string) => path.posix.join(root || '/', rel);

function assertSize(content: string) {
  if (Buffer.byteLength(content, 'utf8') > MAX_DEPLOY_FILE_BYTES) throw new DeployPathError('File exceeds the 5 MB deployment limit');
}

/* ───────────── Local directory (demo site, tests, a mounted checkout) ───────────── */

export class LocalFileStore implements FileStore {
  readonly kind = 'local' as const;
  constructor(
    private root: string,
    private allowed: string[] = DEFAULT_ALLOWED_EXTENSIONS,
  ) {}
  describe() {
    return `file://${path.resolve(this.root)}`;
  }
  private abs(rel: string) {
    const safe = guardPath(rel, this.allowed);
    const rootReal = realpathSync(path.resolve(this.root));
    const abs = path.resolve(rootReal, safe);
    if (!abs.startsWith(rootReal + path.sep)) throw new DeployPathError('Resolved outside the web root');
    if (existsSync(abs) && realpathSync(abs) !== abs) throw new DeployPathError('Symbolic links are not followed');
    return abs;
  }
  async connect() {
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) throw new Error(`Web root ${this.root} does not exist`);
  }
  async exists(rel: string) {
    return existsSync(this.abs(rel));
  }
  async read(rel: string) {
    return readFileSync(this.abs(rel), 'utf8');
  }
  async write(rel: string, content: string) {
    assertSize(content);
    const abs = this.abs(rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.seo-agent-${Date.now().toString(36)}.tmp`;
    writeFileSync(tmp, content, 'utf8');
    try {
      renameSync(tmp, abs);
    } catch (e) {
      if (existsSync(tmp)) unlinkSync(tmp);
      throw e;
    }
  }
  async close() {}
}

/* ───────────── FTP / FTPS (GoDaddy cPanel supports explicit FTPS) ───────────── */

export interface FtpConfig {
  host: string;
  port?: number;
  user: string;
  password: string;
  root: string;
  /** true = explicit FTPS (AUTH TLS, recommended), 'implicit' = FTPS on 990, false = plain FTP (only with allowInsecure). */
  secure: boolean | 'implicit';
  allowInsecure?: boolean;
  rejectUnauthorized?: boolean;
  /** Certificate name when it differs from host (shared hosting often uses the provider's certificate). */
  tlsServername?: string;
  timeoutMs?: number;
  allowedExtensions?: string[];
}

export class FtpFileStore implements FileStore {
  readonly kind = 'ftp' as const;
  private client: import('basic-ftp').Client | null = null;
  constructor(private cfg: FtpConfig) {
    if (!cfg.secure && !cfg.allowInsecure) throw new Error('Plain FTP sends the password unencrypted. Use FTPS (FTP_SECURE=true) or SFTP, or set FTP_ALLOW_INSECURE=true to accept the risk.');
  }
  describe() {
    return `${this.cfg.secure ? 'ftps' : 'ftp'}://${this.cfg.user}@${this.cfg.host}:${this.cfg.port ?? 21}${this.cfg.root}`;
  }
  private rel(rel: string) {
    return joinRemote(this.cfg.root, guardPath(rel, this.cfg.allowedExtensions));
  }
  private get c() {
    if (!this.client) throw new Error('FTP not connected');
    return this.client;
  }
  async connect() {
    const { Client } = await import('basic-ftp');
    this.client = new Client(this.cfg.timeoutMs ?? 30_000);
    await this.client.access({
      host: this.cfg.host,
      port: this.cfg.port ?? 21,
      user: this.cfg.user,
      password: this.cfg.password,
      secure: this.cfg.secure,
      secureOptions: this.cfg.secure ? { rejectUnauthorized: this.cfg.rejectUnauthorized ?? true, servername: this.cfg.tlsServername ?? this.cfg.host } : undefined,
    });
  }
  async exists(rel: string) {
    try {
      await this.c.size(this.rel(rel));
      return true;
    } catch {
      return false;
    }
  }
  async read(rel: string) {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
    });
    await this.c.downloadTo(sink, this.rel(rel));
    return Buffer.concat(chunks).toString('utf8');
  }
  async write(rel: string, content: string) {
    assertSize(content);
    const target = this.rel(rel);
    const tmp = tempName(target);
    await this.c.uploadFrom(Readable.from([Buffer.from(content, 'utf8')]), tmp);
    try {
      await this.c.rename(tmp, target);
    } catch {
      // Some servers refuse to rename over an existing file: upload directly, then remove our temp file.
      await this.c.uploadFrom(Readable.from([Buffer.from(content, 'utf8')]), target);
      await this.c.remove(tmp).catch(() => undefined);
    }
  }
  async close() {
    this.client?.close();
    this.client = null;
  }
}

/* ───────────── SFTP (SSH) ───────────── */

export interface SftpConfig {
  host: string;
  port?: number;
  user: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  root: string;
  /** Expected host key fingerprint "SHA256:…" (from `ssh-keygen -lf` or the first connection). */
  hostFingerprint?: string;
  allowUnknownHost?: boolean;
  timeoutMs?: number;
  allowedExtensions?: string[];
}

export function sshFingerprint(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

export class SftpFileStore implements FileStore {
  readonly kind = 'sftp' as const;
  private client: any = null;
  /** Fingerprint presented by the server on the last connection (shown in "Test connection"). */
  seenFingerprint: string | null = null;
  constructor(private cfg: SftpConfig) {
    if (!cfg.hostFingerprint && !cfg.allowUnknownHost) throw new Error('SFTP_HOST_FINGERPRINT is required so the server identity can be verified (run "Test connection" to see it, or set SFTP_ALLOW_UNKNOWN_HOST=true for a first test).');
    if (!cfg.password && !cfg.privateKey) throw new Error('SFTP needs a password or a private key');
  }
  describe() {
    return `sftp://${this.cfg.user}@${this.cfg.host}:${this.cfg.port ?? 22}${this.cfg.root}`;
  }
  private rel(rel: string) {
    return joinRemote(this.cfg.root, guardPath(rel, this.cfg.allowedExtensions));
  }
  async connect() {
    const { default: SftpClient } = await import('ssh2-sftp-client');
    this.client = new SftpClient('phoenixx-seo-agent');
    await this.client.connect({
      host: this.cfg.host,
      port: this.cfg.port ?? 22,
      username: this.cfg.user,
      password: this.cfg.password,
      privateKey: this.cfg.privateKey,
      passphrase: this.cfg.passphrase,
      readyTimeout: this.cfg.timeoutMs ?? 30_000,
      hostVerifier: (key: Buffer) => {
        this.seenFingerprint = sshFingerprint(key);
        return this.cfg.hostFingerprint ? this.seenFingerprint === this.cfg.hostFingerprint : !!this.cfg.allowUnknownHost;
      },
    });
  }
  async exists(rel: string) {
    return (await this.client.exists(this.rel(rel))) === '-';
  }
  async read(rel: string) {
    const buf: Buffer = await this.client.get(this.rel(rel));
    return buf.toString('utf8');
  }
  async write(rel: string, content: string) {
    assertSize(content);
    const target = this.rel(rel);
    const tmp = tempName(target);
    await this.client.put(Buffer.from(content, 'utf8'), tmp);
    try {
      await this.client.posixRename(tmp, target);
    } catch {
      await this.client.put(Buffer.from(content, 'utf8'), target);
      await this.client.delete(tmp).catch(() => undefined);
    }
  }
  async close() {
    await this.client?.end().catch(() => undefined);
    this.client = null;
  }
}

