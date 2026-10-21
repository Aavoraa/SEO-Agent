import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * Serves a directory like static hosting does (`/about` → about.html, `/` → index.html), so the
 * deployment pipeline can write files and then verify them over HTTP.
 * `faults` simulates production problems: a broken page (status) or a stale cache (frozen body).
 */
export async function startStaticSite(root: string) {
  const faults = new Map<string, { status?: number; frozenBody?: string }>();
  const server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0]!;
    const f = faults.get(p);
    if (f?.status) {
      res.writeHead(f.status, { 'content-type': 'text/html' });
      return res.end('<h1>Server error</h1>');
    }
    if (p === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nAllow: /\n');
    }
    const clean = decodeURIComponent(p).replace(/^\/+|\/+$/g, '');
    const candidates = !clean ? ['index.html'] : /\.html?$/.test(clean) ? [clean] : [`${clean}.html`, `${clean}/index.html`];
    for (const c of candidates) {
      const abs = path.join(root, c);
      if (existsSync(abs)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(f?.frozenBody ?? readFileSync(abs, 'utf8'));
      }
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<h1>Not found</h1>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, faults, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export const page = (o: { title: string; description?: string; h1?: string | null; body?: string; canonical?: string }) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${o.title}</title>
${o.description ? `<meta name="description" content="${o.description}">` : ''}
${o.canonical ? `<link rel="canonical" href="${o.canonical}">` : ''}
</head><body><nav><a href="/">Home</a> <a href="/web-development">Web development</a> <a href="/services">Services</a></nav>
${o.h1 ? `<h1>${o.h1}</h1>` : ''}<h2>What we do</h2>
<p>${o.body ?? 'We design and build fast, accessible websites for businesses in Coimbatore and across Tamil Nadu. '.repeat(30)}</p>
</body></html>`;
