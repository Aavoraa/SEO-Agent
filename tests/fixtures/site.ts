import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny local website that reproduces the real problems found on phoenixxit.com
 * (no H1 on service pages, invalid JSON-LD, mojibake, thin pages) plus classic
 * technical issues (404 link, redirect chain, noindex, orphan page, canonical mismatch).
 */
const layout = (title: string, body: string, head = '') => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>${head}
</head><body><nav><a href="/">Home</a> <a href="/web-design">Web Design</a> <a href="/seo-services">SEO</a> <a href="/old-page">Old</a></nav>
${body}
<footer><a href="tel:+919342721163">+91 93427 21163</a> <a href="mailto:admin@example.com">Email</a></footer></body></html>`;

const words = (n: number, topic: string) => Array.from({ length: n }, (_, i) => `${topic}${i % 7 === 0 ? '.' : ''}`).join(' ');

export function fixtureRoutes(origin: string): Record<string, { status: number; body?: string; headers?: Record<string, string> }> {
  return {
    '/robots.txt': { status: 200, body: `User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`, headers: { 'content-type': 'text/plain' } },
    '/sitemap.xml': {
      status: 200,
      headers: { 'content-type': 'application/xml' },
      body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/web-design', '/seo-services', '/orphan-guide', '/gone', '/private/secret'].map((p) => `<url><loc>${origin}${p}</loc></url>`).join('')}</urlset>`,
    },
    '/': {
      status: 200,
      body: layout(
        'Example IT Company in Coimbatore | Web Design, SEO',
        `<h1>IT and Digital Services in Coimbatore</h1><p>${words(450, 'website design development seo coimbatore business')}</p><img src="/logo.png" alt="Logo"><img src="/team.jpg">`,
        `<meta name="description" content="Example IT company providing web design and SEO services in Coimbatore for growing businesses across Tamil Nadu.">
<link rel="canonical" href="${origin}/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Example"}
"contactPoint": {"@type":"ContactPoint"}</script>`,
      ),
    },
    '/web-design': {
      status: 200,
      body: layout('Website Design Company | Example', `<h2>Website Design</h2><p>We design websites â€” fast and responsive. 99% uptime.</p><p>${words(120, 'website design responsive')}</p><a href="/missing-page">Broken</a>`, `<link rel="canonical" href="${origin}/web-design"><meta name="description" content="Short.">`),
    },
    '/seo-services': {
      status: 200,
      body: layout('Website Design Company | Example', `<h1>SEO Services</h1><h1>Second H1</h1><p>${words(500, 'seo search engine optimization ranking')}</p><a href="/web-design">website design</a>`, `<link rel="canonical" href="${origin}/web-design">`),
    },
    '/orphan-guide': { status: 200, body: layout('A Guide Nobody Links To | Example', `<h1>Guide</h1><p>${words(600, 'guide seo website design tips')}</p>`, `<meta name="robots" content="noindex, nofollow">`) },
    '/old-page': { status: 301, headers: { location: '/old-page-2' } },
    '/old-page-2': { status: 301, headers: { location: '/web-design' } },
    '/gone': { status: 404, body: 'Not found' },
    '/private/secret': { status: 200, body: layout('Secret', '<h1>Secret</h1>') },
  };
}

export async function startFixtureSite(overrides: Record<string, { status: number; body?: string; headers?: Record<string, string> }> = {}) {
  let origin = '';
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    const routes = { ...fixtureRoutes(origin), ...overrides };
    const r = routes[path];
    if (!r) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<h1>Not found</h1>');
      return;
    }
    res.writeHead(r.status, { 'content-type': 'text/html; charset=utf-8', ...(r.headers ?? {}) });
    res.end(r.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((r) => server.close(() => r())) };
}
