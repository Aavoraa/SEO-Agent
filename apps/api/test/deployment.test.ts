import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalFileStore } from '@phoenixx/integrations';
import { scorePriority } from '@phoenixx/seo-engine';
import { json, testApp } from './helpers.js';
import { startStaticSite, page } from '../../../tests/fixtures/static-site.js';
import { createProject } from '../src/services/projects.js';
import { upsertRecommendation } from '../src/services/recommendations.js';
import { emitEvent } from '../src/services/events.js';

/**
 * Full pipeline against a real web root served over HTTP:
 * audit → recommendation → preview → approval → live switch → backup → deploy → verify → re-score → rollback,
 * plus the failure paths (connection, upload, broken page, stale cache, changed page) and the safety rules.
 */
let t: Awaited<ReturnType<typeof testApp>>;
let site: Awaited<ReturnType<typeof startStaticSite>>;
let dir: string;
let projectId: string;
let admin: string;
let editor: string;
let viewer: string;
const SERVICE = 'test-service-key-123456';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const file = (f: string) => readFileSync(path.join(dir, f), 'utf8');
const ORIGINAL_TITLE = 'Web Development Company | Phoenixx IT';
const NEW_TITLE = 'Web Development Company in Coimbatore | Phoenixx IT';

let n = 0;
async function proposal(o: { page: string; type: string; current: string | null; proposed: string; risk?: 'low' | 'medium' | 'high' | 'critical' }) {
  const r = await upsertRecommendation(t.ctx, {
    projectId,
    pageUrl: `${site.origin}${o.page}`,
    source: 'manual',
    type: o.type as never,
    title: `Test ${o.type} ${++n}`,
    what: `Change the ${o.type}`,
    why: 'Test',
    evidence: [{ label: 'Detected', value: 'test' }],
    currentValue: o.current,
    proposedValue: o.proposed,
    expectedPurpose: 'Test',
    risk: o.risk,
    priority: scorePriority({ impact: 3 }),
    fingerprint: `test-${n}`,
    queueForApproval: true,
  });
  return r.id;
}
const approve = async (recId: string, token = editor, body: Record<string, unknown> = {}) => (await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${recId}/decision`, { token, body: { decision: 'approve', ...body } })).body;

beforeAll(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'webroot-'));
  site = await startStaticSite(dir);
  writeFileSync(path.join(dir, 'index.html'), page({ title: 'Phoenixx IT – IT & Digital Solutions in Coimbatore', description: 'Phoenixx IT builds websites, apps and marketing for growing businesses in Coimbatore and Tamil Nadu.', h1: 'Digital solutions for growing businesses', canonical: `${site.origin}/` }));
  writeFileSync(path.join(dir, 'web-development.html'), page({ title: ORIGINAL_TITLE, description: 'Websites that load fast and convert visitors into enquiries.', h1: null, canonical: `${site.origin}/web-development` }));
  writeFileSync(path.join(dir, 'services.html'), page({ title: 'Our Services | Phoenixx IT', description: 'Everything Phoenixx IT offers: web, apps, marketing and automation for businesses.', h1: 'Services' }));
  t = await testApp({ WEBSITE_DEPLOYMENT_PROVIDER: 'local', LOCAL_DEPLOY_ROOT: dir, DEPLOY_VERIFY_RETRIES: 0, DEPLOY_VERIFY_DELAY_MS: 0 } as never);
  projectId = (await createProject(t.ctx, { name: 'Phoenixx test', siteUrl: site.origin + '/' })).id;
  admin = (await json(t.app, 'POST', '/api/auth/setup', { body: { email: 'admin@phoenixxit.com', name: 'Admin', password: 'correct horse battery' } })).body.token;
  for (const role of ['editor', 'viewer'] as const) {
    await json(t.app, 'POST', '/api/auth/users', { token: admin, body: { email: `${role}@phoenixxit.com`, name: role, password: 'password-long-enough', projects: [{ projectId, role }] } });
    const tok = (await json(t.app, 'POST', '/api/auth/login', { body: { email: `${role}@phoenixxit.com`, password: 'password-long-enough' } })).body.token;
    if (role === 'editor') editor = tok;
    else viewer = tok;
  }
});
afterAll(async () => {
  await t.close();
  await site.close();
});

describe('SEO audit', () => {
  it('scores 10 categories from real checks and records the audit', async () => {
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/seo-audit?wait=true`, { token: editor, body: {} });
    expect(r.body.status, r.body.error).toBe('succeeded');
    expect(r.body.output.auditId).toBeTruthy();
    const a = await json(t.app, 'GET', `/api/projects/${projectId}/audits`, { token: viewer });
    expect(a.body.audit).toMatchObject({ device: 'desktop', pagesCrawled: 3, createdBy: 'editor@phoenixxit.com' });
    expect(a.body.categories.map((c: any) => c.id)).toEqual(['technical', 'onpage', 'content', 'performance', 'links', 'local', 'ai_search', 'usability', 'security', 'structured_data']);
    expect(a.body.audit.checksPassed).toBeLessThanOrEqual(a.body.audit.checksTotal);
    const onpage = a.body.categories.find((c: any) => c.id === 'onpage');
    expect(onpage.score).toBeLessThan(100); // /web-development has no H1
    expect(a.body.recommendations.find((g: any) => g.ruleId === 'missing_h1')).toMatchObject({ category: 'onpage', affected: 1 });
    expect(a.body.categories.find((c: any) => c.id === 'performance').coverage).toBe('partial');
    expect(a.body.preview.url).toBe(site.origin + '/');
  });

  it('exports a PDF', async () => {
    const a = await json(t.app, 'GET', `/api/projects/${projectId}/audits`, { token: viewer });
    const pdf = await t.app.inject({ method: 'GET', url: `/api/projects/${projectId}/audits/${a.body.audit.id}/pdf`, headers: { authorization: `Bearer ${viewer}` } });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('deployment pipeline', () => {
  let recId: string;
  let changeId: string;
  const originalFile = () => file('web-development.html');
  let original: string;

  it('previews the exact file change without writing anything', async () => {
    original = originalFile();
    recId = await proposal({ page: '/web-development', type: 'title', current: ORIGINAL_TITLE, proposed: NEW_TITLE });
    const p = await json(t.app, 'GET', `/api/projects/${projectId}/recommendations/${recId}/preview`, { token: viewer });
    expect(p.body).toMatchObject({ ok: true, file: 'web-development.html', current: ORIGINAL_TITLE, proposed: NEW_TITLE });
    expect(p.body.fileDiff).toEqual([{ line: 3, before: `<title>${ORIGINAL_TITLE}</title>`, after: `<title>${NEW_TITLE}</title>` }]);
    expect(p.body.checks.every((c: any) => c.passed)).toBe(true);
    expect(originalFile()).toBe(original);
  });

  it('refuses to deploy until an admin tests the connection and switches live deployment on', async () => {
    const d = await approve(recId);
    changeId = d.changeId;
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/deploy`, { token: editor })).body.error.code).toBe('live_disabled');
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/deployment/live`, { token: editor, body: { enabled: true, confirmDomain: '127.0.0.1' } })).status).toBe(403);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/deployment/live`, { token: admin, body: { enabled: true, confirmDomain: '127.0.0.1' } })).body.error.code).toBe('test_required');
    const test = await json(t.app, 'POST', `/api/projects/${projectId}/deployment/test`, { token: admin });
    expect(test.body.ok, JSON.stringify(test.body.steps)).toBe(true);
    expect(originalFile()).toBe(original); // the test is read-only
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/deployment/live`, { token: admin, body: { enabled: true, confirmDomain: 'wrong.com' } })).body.error.code).toBe('confirmation_required');
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/deployment/live`, { token: admin, body: { enabled: true, confirmDomain: '127.0.0.1' } })).body.liveEnabled).toBe(true);
    expect((await json(t.app, 'GET', `/api/projects/${projectId}/deployment`, { token: viewer })).body).toMatchObject({ provider: 'local', mode: 'live', configured: true, liveEnabled: true, liveEnabledBy: 'admin@phoenixxit.com' });
  });

  it('backs up, deploys, verifies the live page and re-scores the audit', async () => {
    const auditsBefore = (await json(t.app, 'GET', `/api/projects/${projectId}/audits/history`, { token: viewer })).body.length;
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/deploy`, { token: viewer })).status).toBe(403);
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/deploy?wait=true`, { token: editor });
    expect(r.body.status, JSON.stringify(r.body)).toBe('verified');
    expect(originalFile()).toBe(original.replace(`<title>${ORIGINAL_TITLE}</title>`, `<title>${NEW_TITLE}</title>`));
    const d = await json(t.app, 'GET', `/api/projects/${projectId}/deployments/${r.body.deploymentId}`, { token: viewer });
    expect(d.body).toMatchObject({ status: 'verified', verification_status: 'passed', rollback_available: true, target: 'web-development.html', mode: 'live' });
    expect(d.body.steps.map((s: any) => s.step)).toEqual(expect.arrayContaining(['Create backup', 'Apply change', 'Deploy', 'HTTP check', 'Verify title', 'Verified', 'Update SEO score']));
    expect(d.body.steps.every((s: any) => s.status === 'done')).toBe(true);
    expect(d.body.snapshots[0].original_checksum).toBe(sha(original));
    expect(d.body.verifications[0]).toMatchObject({ passed: true, http_status: 200 });
    expect(d.body.verifications[0].checks.find((c: any) => c.kind === 'changed')).toMatchObject({ field: 'title', expected: NEW_TITLE, actual: NEW_TITLE, passed: true });
    expect(d.body.snapshots[0]).not.toHaveProperty('original_content'); // backups stay server-side
    const list = (await json(t.app, 'GET', `/api/projects/${projectId}/change-requests`, { token: viewer })).body;
    expect(list.find((c: any) => c.changeId === changeId)).toMatchObject({ status: 'VERIFIED', approvedBy: 'editor@phoenixxit.com', risk: 'low', verificationStatus: 'passed', oldValue: ORIGINAL_TITLE, newValue: NEW_TITLE });
    const history = (await json(t.app, 'GET', `/api/projects/${projectId}/audits/history`, { token: viewer })).body;
    expect(history.length).toBe(auditsBefore + 1);
    expect(history[0].trigger).toBe('post-deployment');
  });

  it('rolls back from the backup (admin only), verifies and restores the file byte for byte', async () => {
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/rollback`, { token: editor, body: {} })).status).toBe(403);
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${changeId}/rollback`, { token: admin, body: { reason: 'Test rollback' } });
    expect(r.body, JSON.stringify(r.body)).toMatchObject({ ok: true, verified: true });
    expect(sha(originalFile())).toBe(sha(original));
    const list = (await json(t.app, 'GET', `/api/projects/${projectId}/change-requests`, { token: viewer })).body;
    expect(list.find((c: any) => c.changeId === changeId)).toMatchObject({ status: 'ROLLED_BACK' });
    const deps = (await json(t.app, 'GET', `/api/projects/${projectId}/deployments?changeId=${changeId}`, { token: viewer })).body;
    expect(deps.map((d: any) => `${d.action}:${d.status}`)).toEqual(['rollback:verified', 'deploy:verified']);
  });

  it('flags VERIFICATION_FAILED when the live page does not show the change (stale cache) and keeps rollback available', async () => {
    const before = file('web-development.html');
    const rec = await proposal({ page: '/web-development', type: 'meta_description', current: 'Websites that load fast and convert visitors into enquiries.', proposed: 'Fast, accessible websites from Phoenixx IT in Coimbatore. See our process and get a quote.' });
    const { changeId: id } = await approve(rec);
    site.faults.set('/web-development', { frozenBody: before });
    try {
      const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/deploy?wait=true`, { token: editor });
      expect(r.body.status).toBe('verification_failed');
    } finally {
      site.faults.delete('/web-development');
    }
    expect(file('web-development.html')).toContain('Fast, accessible websites from Phoenixx IT');
    const c = (await json(t.app, 'GET', `/api/projects/${projectId}/change-requests`, { token: viewer })).body.find((x: any) => x.changeId === id);
    expect(c).toMatchObject({ status: 'VERIFICATION_FAILED', rollbackAvailable: true });
    const alerts = (await json(t.app, 'GET', `/api/projects/${projectId}/alerts`, { token: viewer })).body;
    expect(alerts.some((a: any) => a.type === 'deployment_verification_failed')).toBe(true);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/rollback`, { token: admin, body: {} })).body.ok).toBe(true);
    expect(file('web-development.html')).toBe(before);
  });

  it('restores the original automatically when the page breaks after upload (HTTP 500)', async () => {
    const before = file('services.html');
    const rec = await proposal({ page: '/services', type: 'title', current: 'Our Services | Phoenixx IT', proposed: 'IT & Digital Marketing Services in Coimbatore | Phoenixx IT' });
    const { changeId: id } = await approve(rec);
    site.faults.set('/services', { status: 500 });
    try {
      const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/deploy?wait=true`, { token: editor });
      expect(r.body.status).toBe('restored');
    } finally {
      site.faults.delete('/services');
    }
    expect(file('services.html')).toBe(before);
    const c = (await json(t.app, 'GET', `/api/projects/${projectId}/change-requests`, { token: viewer })).body.find((x: any) => x.changeId === id);
    expect(c.status).toBe('FAILED');
    expect(c.deployment).toMatchObject({ status: 'restored', restored_automatically: true });
  });

  it('restores the original when the upload itself fails', async () => {
    const before = file('services.html');
    const rec = await proposal({ page: '/services', type: 'meta_description', current: 'Everything Phoenixx IT offers: web, apps, marketing and automation for businesses.', proposed: 'Web design, apps, marketing and automation from Phoenixx IT in Coimbatore – talk to our team.' });
    const { changeId: id } = await approve(rec);
    const spy = vi.spyOn(LocalFileStore.prototype, 'write').mockRejectedValueOnce(new Error('Disk quota exceeded'));
    try {
      const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/deploy?wait=true`, { token: editor });
      expect(r.body).toMatchObject({ status: 'restored', error: 'Disk quota exceeded' });
    } finally {
      spy.mockRestore();
    }
    expect(file('services.html')).toBe(before);
  });

  it('refuses when the page changed since the recommendation was made', async () => {
    const before = file('index.html');
    const rec = await proposal({ page: '/', type: 'title', current: 'An old title nobody sees any more', proposed: 'Phoenixx IT | Coimbatore' });
    const { changeId: id } = await approve(rec);
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/deploy?wait=true`, { token: editor });
    expect(r.body.status).toBe('failed');
    expect(file('index.html')).toBe(before);
    const d = (await json(t.app, 'GET', `/api/projects/${projectId}/deployments?changeId=${id}`, { token: viewer })).body[0];
    expect(d.error_message).toMatch(/page changed since the recommendation/);
  });
});

describe('risk levels & approval rules', () => {
  it('never lets anyone approve CRITICAL changes', async () => {
    const rec = await proposal({ page: '/', type: 'technical', current: null, proposed: 'Delete old files', risk: 'critical' });
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${rec}/decision`, { token: admin, body: { decision: 'approve', previewConfirmed: true } });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toMatch(/never executed/);
  });

  it('HIGH risk needs an admin who confirmed the preview', async () => {
    const rec = await proposal({ page: '/services', type: 'canonical', current: null, proposed: `${site.origin}/services` });
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${rec}/decision`, { token: editor, body: { decision: 'approve', previewConfirmed: true } })).status).toBe(403);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${rec}/decision`, { token: admin, body: { decision: 'approve' } })).body.error.code).toBe('preview_required');
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${rec}/decision`, { token: admin, body: { decision: 'approve', previewConfirmed: true } })).status).toBe(200);
  });

  it('service keys (n8n) and viewers can never approve', async () => {
    const rec = await proposal({ page: '/services', type: 'title', current: 'Our Services | Phoenixx IT', proposed: 'Services | Phoenixx IT Coimbatore' });
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${rec}/decision`, { apiKey: SERVICE, body: { decision: 'approve' } })).status).toBe(403);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${rec}/decision`, { token: viewer, body: { decision: 'approve' } })).status).toBe(403);
  });
});

describe('connection security', () => {
  let pid2: string;
  beforeAll(async () => {
    pid2 = (await createProject(t.ctx, { name: 'FTP client', siteUrl: site.origin + '/' })).id;
    await json(t.app, 'POST', `/api/projects/${pid2}/members`, { token: admin, body: { email: 'editor@phoenixxit.com', role: 'editor' } });
  });

  it('stores FTP credentials encrypted and never returns them', async () => {
    const put = await json(t.app, 'PUT', `/api/projects/${pid2}/deployment/connection`, { token: admin, body: { provider: 'ftp', host: '127.0.0.1', port: 1, username: 'deploy', password: 'super-secret-ftp-pass', remoteRoot: '/public_html', secure: 'true' } });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain('super-secret-ftp-pass');
    expect(put.body.connection).toMatchObject({ host: '127.0.0.1', username: 'deploy', hasPassword: true });
    const row = await t.ctx.db.one<any>(`SELECT config, secret_encrypted FROM integrations WHERE project_id = $1 AND provider = 'website_deploy'`, [pid2]);
    expect(JSON.stringify(row.config)).not.toContain('super-secret');
    expect(row.secret_encrypted).toMatch(/^v1:/);
    expect(row.secret_encrypted).not.toContain('super-secret');
    const logs = await t.ctx.db.query<any>(`SELECT details FROM audit_logs WHERE action = 'deployment.connection_saved'`);
    expect(JSON.stringify(logs)).not.toContain('super-secret');
  });

  it('validates connection input and requires an admin', async () => {
    expect((await json(t.app, 'PUT', `/api/projects/${pid2}/deployment/connection`, { token: editor, body: { provider: 'ftp' } })).status).toBe(403);
    expect((await json(t.app, 'PUT', `/api/projects/${pid2}/deployment/connection`, { token: admin, body: { provider: 'ftp', remoteRoot: '/public_html/../etc' } })).status).toBe(400);
    expect((await json(t.app, 'PUT', `/api/projects/${pid2}/deployment/connection`, { token: admin, body: { provider: 'ftp', host: 'ftp://evil.com/x' } })).status).toBe(400);
  });

  it('FTP connection failure → deployment FAILED, nothing changed', async () => {
    await json(t.app, 'PUT', `/api/projects/${pid2}/deployment/connection`, { token: admin, body: { provider: 'ftp', host: '127.0.0.1', port: 1, username: 'deploy', password: 'x', remoteRoot: '/public_html', secure: 'true' } });
    const test = await json(t.app, 'POST', `/api/projects/${pid2}/deployment/test`, { token: admin });
    expect(test.body.ok).toBe(false);
    // Simulate: live was enabled earlier, then the server became unreachable.
    await t.ctx.db.query(`UPDATE projects SET settings = jsonb_set(settings, '{deployment}', '{"liveEnabled": true}') WHERE id = $1`, [pid2]);
    const pid = projectId;
    projectId = pid2;
    try {
      const rec = await proposal({ page: '/services', type: 'title', current: 'Our Services | Phoenixx IT', proposed: 'Services | Phoenixx IT' });
      const { changeId: id } = await approve(rec, admin);
      const before = file('services.html');
      const r = await json(t.app, 'POST', `/api/projects/${pid2}/changes/${id}/deploy?wait=true`, { token: admin });
      expect(r.body.status).toBe('failed');
      expect(file('services.html')).toBe(before);
      const d = (await json(t.app, 'GET', `/api/projects/${pid2}/deployments?changeId=${id}`, { token: admin })).body[0];
      expect(d.steps.find((s: any) => s.step === 'Connect').status).toBe('failed');
    } finally {
      projectId = pid;
    }
  });
});

describe('n8n events', () => {
  it('are HMAC-signed and carry no secrets', async () => {
    let got: { sig: string; body: string } | null = null;
    const srv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got = { sig: String(req.headers['x-phoenixx-signature']), body: b };
        res.end('ok');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/webhook`;
    const ctx = { ...t.ctx, cfg: { ...t.ctx.cfg, N8N_EVENTS_WEBHOOK_URL: url, N8N_EVENTS_SECRET: 'n8n-shared-secret' } };
    expect((await emitEvent(ctx, projectId, 'deployment.completed', { changeId: 'c1' })).sent).toBe(true);
    srv.close();
    const [tPart, vPart] = got!.sig.split(',');
    const ts = tPart!.slice(2);
    expect(vPart!.slice(3)).toBe(createHmac('sha256', 'n8n-shared-secret').update(`${ts}.${got!.body}`).digest('hex'));
    expect(JSON.parse(got!.body)).toMatchObject({ event: 'deployment.completed', projectId, data: { changeId: 'c1' } });
    const unsigned = { ...t.ctx, cfg: { ...t.ctx.cfg, N8N_EVENTS_WEBHOOK_URL: url, N8N_EVENTS_SECRET: undefined } };
    expect((await emitEvent(unsigned, projectId, 'deployment.completed', {})).sent).toBe(false);
  });
});

describe('audit history', () => {
  it('compares two real audits: score change, resolved/new issues and page changes', async () => {
    const history = (await json(t.app, 'GET', `/api/projects/${projectId}/audits/history`, { token: viewer })).body;
    expect(history.length).toBeGreaterThanOrEqual(3);
    const oldest = history[history.length - 1];
    const deployed = [...history].reverse().find((h: any) => h.trigger === 'post-deployment'); // first re-score: right after the title deployment
    const c = await json(t.app, 'GET', `/api/projects/${projectId}/audits/compare?from=${oldest.id}&to=${deployed.id}`, { token: viewer });
    expect(c.status).toBe(200);
    expect(c.body.scoreDelta).toBe(deployed.overall_score - oldest.overall_score);
    expect(c.body.categories).toHaveLength(10);
    expect(Array.isArray(c.body.newIssues) && Array.isArray(c.body.resolvedIssues)).toBe(true);
    expect(c.body.pageChanges.some((p: any) => p.path === '/web-development' && p.field === 'title')).toBe(true);
  });
});

describe('recommendation lifecycle', () => {
  it('reopens a recommendation when its issue comes back after being resolved', async () => {
    const rec = await t.ctx.db.one<any>(`SELECT r.id FROM recommendations r JOIN seo_issues i ON i.id = r.issue_id WHERE r.project_id = $1 AND i.rule_id = 'missing_h1' LIMIT 1`, [projectId]);
    expect(rec).toBeTruthy();
    await t.ctx.db.query(`UPDATE recommendations SET status = 'completed' WHERE id = $1`, [rec.id]);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl?wait=true`, { token: editor, body: {} })).body.status).toBe('succeeded');
    const after = await t.ctx.db.one<any>('SELECT status FROM recommendations WHERE id = $1', [rec.id]);
    expect(['recommended', 'pending_approval']).toContain(after.status);
  });
});

describe('H1 fixes', () => {
  it('promotes the first H2 to the new H1, verifies, and rolls back byte for byte', async () => {
    const before = file('web-development.html');
    const rec = await proposal({ page: '/web-development', type: 'h1', current: null, proposed: 'Web Development Company in Coimbatore' });
    const { changeId: id } = await approve(rec);
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/deploy?wait=true`, { token: editor });
    expect(r.body.status, JSON.stringify(r.body)).toBe('verified');
    expect(file('web-development.html')).toContain('<h1>Web Development Company in Coimbatore</h1>');
    expect(file('web-development.html')).not.toContain('<h2>What we do</h2>');
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/rollback`, { token: admin, body: {} })).body.ok).toBe(true);
    expect(file('web-development.html')).toBe(before);
  });
});

describe('byte-exact backups', () => {
  it('restores a page with a UTF-8 BOM byte for byte and verifies against the pre-deployment page', async () => {
    const bomPage = '\uFEFF' + page({ title: 'About Phoenixx IT', description: 'Who we are: a digital agency in Coimbatore building websites, apps and campaigns.', h1: 'About us' });
    writeFileSync(path.join(dir, 'about.html'), bomPage);
    const original = readFileSync(path.join(dir, 'about.html'));
    const rec = await proposal({ page: '/about', type: 'title', current: 'About Phoenixx IT', proposed: 'About Phoenixx IT – Digital Agency in Coimbatore' });
    const { changeId: id } = await approve(rec);
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/deploy?wait=true`, { token: editor })).body.status).toBe('verified');
    const rb = await json(t.app, 'POST', `/api/projects/${projectId}/changes/${id}/rollback`, { token: admin, body: {} });
    expect(rb.body).toMatchObject({ ok: true, verified: true });
    expect(readFileSync(path.join(dir, 'about.html')).equals(original)).toBe(true);
  });
});
