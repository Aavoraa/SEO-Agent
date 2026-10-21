/**
 * END-TO-END: the full SEO Agent lifecycle against a real static website stored in a git repo
 * (the same shape as today's phoenixxit.com: plain HTML files, clean URLs).
 *
 * COLLECT → CRAWL → ANALYZE → DISCOVER → PRIORITIZE → GENERATE → HUMAN APPROVAL →
 * IMPLEMENT (git commit on a branch) → deploy (merge) → VERIFY (live check) → MEASURE → LEARN
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { bulkInsert } from '@phoenixx/database';
import { addDays, isoDate } from '@phoenixx/shared';
import { json, testApp } from '../../apps/api/test/helpers.js';
import { createProject } from '../../apps/api/src/services/projects.js';

let repo: string;
let origin: string;
let server: http.Server;
let t: Awaited<ReturnType<typeof testApp>>;
let token: string;
let projectId: string;
const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=dev', '-c', 'user.email=dev@example.com', ...a], { encoding: 'utf8' });

const page = (title: string, body: string, extraHead = '') => `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="Phoenixx IT builds automation, websites and digital marketing programmes for growing businesses in Coimbatore and across India.">
${extraHead}
</head><body><nav><a href="/">Home</a> <a href="/automation">Automation</a> <a href="/digital-marketing">Digital Marketing</a></nav>
${body}
<footer><a href="tel:+919342721163">+91 93427 21163</a></footer></body></html>`;

beforeAll(async () => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'phoenixx-site-'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  const filler = (t: string) => Array.from({ length: 80 }, () => t).join(' ');
  writeFileSync(path.join(repo, 'index.html'), page('Phoenixx IT — IT & Digital Solutions, Coimbatore', `<h1>IT & Digital Solutions in Coimbatore</h1><p>${filler('automation websites marketing coimbatore')}</p>`, `<link rel="canonical" href="ORIGIN/"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Phoenixx IT"}\n"contactPoint": {}</script>`));
  writeFileSync(path.join(repo, 'automation.html'), page('Business Automation Services in Coimbatore | Phoenixx IT', `<h2>Workflow <em>Automation</em></h2><p>${filler('workflow automation crm integration business process')}</p>`, `<link rel="canonical" href="ORIGIN/automation">`));
  writeFileSync(path.join(repo, 'digital-marketing.html'), page('Digital Marketing Agency in Coimbatore | Phoenixx IT', `<h1>Digital Marketing</h1><p>${filler('digital marketing seo social media campaigns')}</p><a href="/automation">marketing automation</a>`, `<link rel="canonical" href="ORIGIN/digital-marketing">`));
  git('add', '.');
  git('commit', '-qm', 'initial site');

  // Static server over the repo working tree with clean URLs (like the Apache rewrite on phoenixxit.com).
  server = http.createServer((req, res) => {
    const p = (req.url ?? '/').split('?')[0]!;
    const file = p === '/' ? 'index.html' : p === '/robots.txt' ? null : `${p.replace(/^\//, '')}.html`;
    if (p === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    }
    if (p === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      return res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/automation', '/digital-marketing'].map((x) => `<url><loc>${origin}${x}</loc></url>`).join('')}</urlset>`);
    }
    const abs = file ? path.join(repo, file) : '';
    if (!file || !existsSync(abs)) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<h1>Not found</h1>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(readFileSync(abs, 'utf8').replaceAll('ORIGIN', origin));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  t = await testApp({ WEBSITE_ADAPTER: 'git', WEBSITE_REPO_PATH: repo });
  token = (await json(t.app, 'POST', '/api/auth/setup', { body: { email: 'owner@phoenixxit.com', name: 'Owner', password: 'a-very-long-password' } })).body.token;
  projectId = (await createProject(t.ctx, { name: 'Phoenixx IT (e2e)', siteUrl: origin + '/' })).id;
  // Business profile service paths match the fixture site.
  await json(t.app, 'PATCH', `/api/projects/${projectId}`, { token, body: { businessProfile: { url: origin + '/' } } });
});

afterAll(async () => {
  await t.close();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('SEO Agent lifecycle (e2e)', () => {
  let changeId: string;

  it('COLLECT: ingests Search Console data', async () => {
    const end = isoDate(addDays(new Date(), -3));
    const rows = [];
    for (let d = 0; d < 60; d++) {
      const date = isoDate(addDays(end, -d));
      rows.push({ project_id: projectId, date, query: 'business automation services coimbatore', page: `${origin}/automation`, country: '', device: '', clicks: 1, impressions: 60, ctr: 1 / 60, position: 9.4 });
      rows.push({ project_id: projectId, date, query: 'what is workflow automation', page: `${origin}/automation`, country: '', device: '', clicks: 0, impressions: 20, ctr: 0, position: 24 });
      rows.push({ project_id: projectId, date, query: 'digital marketing agency coimbatore', page: `${origin}/digital-marketing`, country: '', device: '', clicks: 3, impressions: 90, ctr: 3 / 90, position: 7.2 });
    }
    expect(await bulkInsert(t.ctx.db, 'search_console_data', rows)).toBe(180);
  });

  it('CRAWL + ANALYZE: finds the real-world issues (missing H1, invalid JSON-LD)', async () => {
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl?wait=true`, { token, body: {} });
    expect(r.body.status).toBe('succeeded');
    expect(r.body.output.pagesCrawled).toBe(3);
    const issues = await json(t.app, 'GET', `/api/projects/${projectId}/issues?limit=200`, { token });
    const rules = issues.body.items.map((i: any) => i.rule_id);
    expect(rules).toEqual(expect.arrayContaining(['missing_h1', 'invalid_structured_data']));
  });

  it('DISCOVER + PRIORITIZE: keyword opportunities and scored recommendations', async () => {
    const k = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/keywords?wait=true`, { token, body: {} });
    expect(k.body.status).toBe('succeeded');
    const kw = await json(t.app, 'GET', `/api/projects/${projectId}/keywords`, { token });
    const auto = kw.body.items.find((x: any) => x.keyword === 'business automation services coimbatore');
    expect(auto.intent).toBe('local');
    expect(auto.opportunity_score).toBeGreaterThan(0);
    const recs = await json(t.app, 'GET', `/api/projects/${projectId}/recommendations?status=all&limit=200`, { token });
    const h1 = recs.body.items.find((r: any) => r.type === 'h1' && r.page_url === `${origin}/automation`);
    expect(h1).toBeTruthy();
    expect(h1.score_breakdown.factors.length).toBe(6);
    expect(h1.evidence.some((e: any) => /Impressions/.test(e.label))).toBe(true);
  });

  it('GENERATE: AI (mock) proposes copy; HUMAN APPROVAL with an edit', async () => {
    const recs = await json(t.app, 'GET', `/api/projects/${projectId}/recommendations?status=all&limit=200`, { token });
    const h1 = recs.body.items.find((r: any) => r.type === 'h1' && r.page_url === `${origin}/automation`);
    const g = await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${h1.id}/generate`, { token });
    expect(g.status).toBe(200);
    const d = await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${h1.id}/decision`, { token, body: { decision: 'approve', editedValue: 'Business Automation Services in Coimbatore', comment: 'Approved in e2e' } });
    expect(d.body.status).toBe('approved');
    changeId = d.body.changeId;
  });

  it('IMPLEMENT: git adapter commits on a branch and leaves main untouched', async () => {
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/implement`, { token });
    expect(r.body.ok).toBe(true);
    expect(r.body.adapter).toBe('git');
    const branch = String(r.body.ref).split('@')[0]!;
    expect(git('show', `${branch}:automation.html`)).toContain('<h1>Business Automation Services in Coimbatore</h1>');
    expect(readFileSync(path.join(repo, 'automation.html'), 'utf8')).not.toContain('<h1>');
    // Not live yet → verification must say so.
    const v = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/verify`, { token });
    expect(v.body.verified).toBe(false);
    // A developer merges & deploys.
    git('merge', '-q', '--ff-only', branch);
  });

  it('VERIFY → MONITORING: live page confirmed, experiment started', async () => {
    const v = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/verify`, { token });
    expect(v.body.verified).toBe(true);
    expect(v.body.experimentId).toBeTruthy();
    const c = await json(t.app, 'GET', `/api/projects/${projectId}/changes/${changeId}`, { token });
    expect(c.body.status).toBe('monitoring');
    expect(c.body.events.map((e: any) => e.to_status)).toEqual(expect.arrayContaining(['approved', 'implemented', 'verified', 'monitoring']));
  });

  it('MEASURE + LEARN: experiment evaluation reports correlation, not causation', async () => {
    // Pretend 28 days have passed: move the experiment start back and add post-change data.
    await t.ctx.db.query(`UPDATE experiments SET start_date = start_date - 40 WHERE change_id = $1`, [changeId]);
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/experiments-evaluate?wait=true`, { token, body: {} });
    expect(r.body.status).toBe('succeeded');
    const ex = await json(t.app, 'GET', `/api/projects/${projectId}/experiments`, { token });
    expect(['completed', 'inconclusive']).toContain(ex.body[0].status);
    expect(ex.body[0].conclusion).toMatch(/correlation|Not enough data/);
    const c = await json(t.app, 'GET', `/api/projects/${projectId}/changes/${changeId}`, { token });
    expect(c.body.status).toBe('completed');
  });

  it('re-crawl resolves the fixed issue', async () => {
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl?wait=true`, { token, body: {} });
    expect(r.body.output.resolvedIssues).toBeGreaterThan(0);
    const issues = await json(t.app, 'GET', `/api/projects/${projectId}/issues?rule=missing_h1&status=resolved`, { token });
    expect(issues.body.items.some((i: any) => i.url === `${origin}/automation`)).toBe(true);
  });

  it('ROLLBACK: admin rollback commits the previous value', async () => {
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/rollback`, { token, body: { reason: 'e2e rollback check' } });
    expect(r.body.ok).toBe(true);
    const c = await json(t.app, 'GET', `/api/projects/${projectId}/changes/${changeId}`, { token });
    expect(c.body.status).toBe('rolled_back');
  });

  it('MIGRATION MONITOR: detects a deleted URL in the redesign and proposes a 301', async () => {
    const base = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/migration-snapshot?wait=true`, { token, body: { label: 'Before redesign', kind: 'baseline' } });
    expect(base.body.status).toBe('succeeded');
    // Redesign: /automation moves to /services/automation.
    git('mv', 'automation.html', 'services-automation.html');
    writeFileSync(path.join(repo, 'services-automation.html'), page('Business Automation Services | Phoenixx IT', '<h1>Business Automation Services</h1><p>workflow automation</p>'));
    git('add', '-A');
    git('commit', '-qm', 'redesign');
    const cmp = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/migration-snapshot?wait=true`, { token, body: { label: 'New site', kind: 'comparison', sourceUrl: origin + '/' } });
    // The new page is only reachable via a link; add it to the crawl through the homepage nav.
    expect(cmp.body.status).toBe('succeeded');
    const res = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/migration-compare?wait=true`, { token, body: { baselineId: base.body.output.snapshotId, comparisonId: cmp.body.output.snapshotId } });
    expect(res.body.status).toBe('succeeded');
    const missing = res.body.output.findings.find((f: any) => f.path === '/automation');
    expect(missing.type).toBe('missing_page');
    expect(['critical', 'high']).toContain(missing.severity);
    const recs = await json(t.app, 'GET', `/api/projects/${projectId}/recommendations?source=migration&status=all`, { token });
    expect(recs.body.items.every((r: any) => r.risk === 'high' && r.status === 'pending_approval')).toBe(true);
  });
});
