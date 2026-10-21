import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { sleep } from '@phoenixx/shared';

/**
 * Google API access without the heavyweight googleapis SDK.
 * Supports: (1) service account JSON key (recommended for servers) and
 *           (2) OAuth2 refresh token obtained through the dashboard "Connect Google" flow.
 */
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly', 'https://www.googleapis.com/auth/analytics.readonly'];

export interface GoogleCredentials {
  serviceAccountKeyFile?: string;
  serviceAccountJson?: { client_email: string; private_key: string; token_uri?: string };
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

export class GoogleAuth {
  private token: { value: string; expiresAt: number } | null = null;
  constructor(private creds: GoogleCredentials) {}

  get configured(): boolean {
    return !!(this.creds.serviceAccountKeyFile || this.creds.serviceAccountJson || (this.creds.clientId && this.creds.clientSecret && this.creds.refreshToken));
  }

  get method(): 'service_account' | 'oauth' | 'none' {
    if (this.creds.serviceAccountKeyFile || this.creds.serviceAccountJson) return 'service_account';
    if (this.creds.refreshToken) return 'oauth';
    return 'none';
  }

  async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const sa = this.creds.serviceAccountJson ?? (this.creds.serviceAccountKeyFile ? JSON.parse(readFileSync(this.creds.serviceAccountKeyFile, 'utf8')) : null);
    let body: URLSearchParams;
    if (sa) {
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: sa.client_email, scope: GOOGLE_SCOPES.join(' '), aud: sa.token_uri ?? 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })).toString('base64url');
      const signer = createSign('RSA-SHA256');
      signer.update(`${header}.${claims}`);
      const sig = signer.sign(sa.private_key).toString('base64url');
      body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${sig}` });
    } else if (this.creds.refreshToken && this.creds.clientId && this.creds.clientSecret) {
      body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.creds.refreshToken, client_id: this.creds.clientId, client_secret: this.creds.clientSecret });
    } else {
      throw new Error('Google credentials not configured. Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE, or connect Google in Settings.');
    }
    const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !json.access_token) throw new Error(`Google token error: ${json.error ?? res.status} ${json.error_description ?? ''}`.trim());
    this.token = { value: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** Authorised JSON request with retry on 429/5xx. */
  async request<T>(url: string, init: { method?: string; body?: unknown } = {}, attempts = 4): Promise<T> {
    let last: Error | null = null;
    for (let i = 0; i < attempts; i++) {
      const res = await fetch(url, {
        method: init.method ?? 'GET',
        headers: { authorization: `Bearer ${await this.accessToken()}`, 'content-type': 'application/json' },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      if (res.ok) return (await res.json()) as T;
      const text = await res.text();
      last = new Error(`Google API ${res.status}: ${text.slice(0, 500)}`);
      if (res.status !== 429 && res.status < 500) throw last;
      await sleep(1000 * 2 ** i);
    }
    throw last!;
  }
}

/* ───────────── OAuth consent flow helpers (dashboard "Connect Google") ───────────── */

export function googleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const p = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeGoogleCode(code: string, clientId: string, clientSecret: string, redirectUri: string): Promise<{ refreshToken: string; scope: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const json = (await res.json()) as { refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !json.refresh_token) throw new Error(`Google OAuth exchange failed: ${json.error ?? res.status} ${json.error_description ?? '(no refresh_token – remove the app from your Google account permissions and retry)'}`);
  return { refreshToken: json.refresh_token, scope: json.scope ?? '' };
}
