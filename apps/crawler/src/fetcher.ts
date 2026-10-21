import type { RedirectHop } from '@phoenixx/shared';

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number | null;
  headers: Record<string, string>;
  body: string | null;
  redirectChain: RedirectHop[];
  redirectLoop: boolean;
  timeMs: number;
  error: string | null;
}

export interface FetchOptions {
  userAgent: string;
  timeoutMs: number;
  maxRedirects?: number;
  method?: 'GET' | 'HEAD';
  maxBytes?: number;
  readBody?: boolean;
}

/**
 * Fetch that follows redirects manually so every hop (and loops) can be recorded.
 * Response time is time-to-final-response (headers), which approximates TTFB for the final hop.
 */
export async function fetchWithRedirects(url: string, opts: FetchOptions): Promise<FetchResult> {
  const chain: RedirectHop[] = [];
  const seen = new Set<string>();
  let current = url;
  const started = performance.now();
  const max = opts.maxRedirects ?? 10;
  for (let hop = 0; hop <= max; hop++) {
    if (seen.has(current)) {
      return { url, finalUrl: current, status: null, headers: {}, body: null, redirectChain: chain, redirectLoop: true, timeMs: Math.round(performance.now() - started), error: 'Redirect loop detected' };
    }
    seen.add(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, {
        method: opts.method ?? 'GET',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': opts.userAgent, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = (e as Error).name === 'AbortError' ? `Timeout after ${opts.timeoutMs}ms` : (e as Error).message;
      return { url, finalUrl: current, status: null, headers: {}, body: null, redirectChain: chain, redirectLoop: false, timeMs: Math.round(performance.now() - started), error: msg };
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    if (res.status >= 300 && res.status < 400 && headers.location) {
      clearTimeout(timer);
      const next = new URL(headers.location, current).toString();
      chain.push({ url: current, status: res.status, location: next });
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      current = next;
      continue;
    }
    let body: string | null = null;
    try {
      if (opts.readBody !== false && opts.method !== 'HEAD') {
        const buf = Buffer.from(await res.arrayBuffer());
        const limited = opts.maxBytes && buf.length > opts.maxBytes ? buf.subarray(0, opts.maxBytes) : buf;
        body = limited.toString('utf8');
        headers['x-body-bytes'] = String(buf.length);
      } else {
        await res.body?.cancel();
      }
    } catch (e) {
      clearTimeout(timer);
      return { url, finalUrl: current, status: res.status, headers, body: null, redirectChain: chain, redirectLoop: false, timeMs: Math.round(performance.now() - started), error: `Body read failed: ${(e as Error).message}` };
    }
    clearTimeout(timer);
    return { url, finalUrl: current, status: res.status, headers, body, redirectChain: chain, redirectLoop: false, timeMs: Math.round(performance.now() - started), error: null };
  }
  return { url, finalUrl: current, status: null, headers: {}, body: null, redirectChain: chain, redirectLoop: false, timeMs: Math.round(performance.now() - started), error: `Too many redirects (>${max})` };
}
