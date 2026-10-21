import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/* ---------- Password hashing (scrypt) ---------- */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

/* ---------- API keys ---------- */

export function generateApiKey(): string {
  return 'pxseo_' + randomBytes(24).toString('base64url');
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/* ---------- Minimal HS256 JWT ---------- */

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

export function signJwt(payload: Record<string, unknown>, secret: string, ttlSeconds = 60 * 60 * 12): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifyJwt<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload as T;
  } catch {
    return null;
  }
}

/* ---------- Symmetric encryption for stored secrets (AES-256-GCM) ---------- */

function keyFrom(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(payload: string, secret: string): string {
  const [v, ivB64, tagB64, dataB64] = payload.split(':');
  if (v !== 'v1' || !ivB64 || !tagB64 || !dataB64) throw new Error('Unsupported secret payload');
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Redact obvious secrets before anything is logged or written to audit_logs. */
export function redact<T>(value: T): T {
  const SECRET_KEYS = /(password|secret|token|api[_-]?key|authorization|refresh)/i;
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, SECRET_KEYS.test(k) ? '[REDACTED]' : walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}
