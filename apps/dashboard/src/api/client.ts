/**
 * Thin fetch wrapper: adds the bearer token, parses `{ error: { code, message, correlationId } }`
 * responses into ApiError, and broadcasts a logout event on 401.
 */
export const API_BASE: string = import.meta.env.VITE_API_URL ?? '';

const TOKEN_KEY = 'phoenixx.seo.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable – token lives only for this page load */
  }
}

export class ApiError extends Error {
  status: number;
  code: string;
  correlationId?: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, correlationId?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
    this.details = details;
  }
}

export const UNAUTHORIZED_EVENT = 'phoenixx:unauthorized';

type Query = Record<string, string | number | boolean | null | undefined>;

export function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
}

/** Public endpoints never get the bearer token: the API rejects ANY request carrying an expired token with 401. */
const PUBLIC_PATHS = ['/api/system/status', '/api/auth/login', '/api/auth/setup', '/api/auth/demo-login'];

async function raw(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token && !PUBLIC_PATHS.some((p) => path.startsWith(p))) headers.set('Authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, headers, body });
  } catch (e) {
    throw new ApiError(0, 'network', `Cannot reach the API (${(e as Error).message}). Is the server running?`);
  }
  if (!res.ok) {
    let code = 'http_error';
    let message = `${res.status} ${res.statusText}`;
    let correlationId = res.headers.get('x-correlation-id') ?? undefined;
    let details: unknown;
    try {
      const j = await res.json();
      if (j?.error && typeof j.error === 'object') {
        code = j.error.code ?? code;
        message = j.error.message ?? message;
        correlationId = j.error.correlationId ?? correlationId;
        details = j.error.details;
      } else if (typeof j?.message === 'string') {
        message = j.message;
      }
    } catch {
      /* non-JSON error body */
    }
    if (Array.isArray(details) && details.length && code === 'validation') {
      message = `${message}: ${(details as { path: string; message: string }[]).map((d) => `${d.path || 'body'} – ${d.message}`).join('; ')}`;
    }
    if (res.status === 401 && !path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/setup')) {
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
    }
    throw new ApiError(res.status, code, message, correlationId, details);
  }
  return res;
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; query?: Query; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const res = await raw(withQuery(path, opts.query), {
    method,
    json: opts.body !== undefined ? opts.body : method !== 'GET' && method !== 'DELETE' ? {} : undefined,
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export async function fetchText(path: string, query?: Query): Promise<string> {
  const res = await raw(withQuery(path, query));
  return res.text();
}

/** Fetch with auth and trigger a browser download of the response body. */
export async function download(path: string, fallbackName: string, query?: Query): Promise<void> {
  const res = await raw(withQuery(path, query));
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="?([^";]+)"?/i.exec(cd);
  const name = m?.[1] ?? fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
