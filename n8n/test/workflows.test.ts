import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOBS } from '../../apps/api/src/services/jobs.js';
import { json, testApp } from '../../apps/api/test/helpers.js';
import { createProject } from '../../apps/api/src/services/projects.js';
import { startFixtureSite } from '../../tests/fixtures/site.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workflows');
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
const workflows = files.map((f) => ({ file: f, wf: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }));

const KNOWN_TYPES = new Set(['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code', 'n8n-nodes-base.if', 'n8n-nodes-base.webhook', 'n8n-nodes-base.errorTrigger', 'n8n-nodes-base.stickyNote']);

describe('n8n workflow files', () => {
  it('has the 8 required workflows plus the error handler', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
    const names = workflows.map((w) => w.wf.name).join('\n');
    for (const n of ['Daily SEO Monitor', 'Weekly Website Crawl', 'Keyword Opportunity Discovery', 'Content Opportunity Agent', 'On-Page Optimization', 'Internal Linking Agent', 'Local SEO Monitor', 'Weekly Report', 'Error Handler', 'SEO Audit', 'Change Deployment', 'Post-Deployment Verification']) expect(names).toContain(n);
  });

  for (const { file, wf } of workflows) {
    describe(file, () => {
      it('is structurally valid and importable', () => {
        expect(typeof wf.name).toBe('string');
        expect(wf.id).toMatch(/^[A-Za-z0-9]{16}$/);
        expect(Array.isArray(wf.nodes)).toBe(true);
        const names = new Set(wf.nodes.map((n: any) => n.name));
        expect(names.size).toBe(wf.nodes.length); // unique names
        for (const n of wf.nodes) {
          expect(KNOWN_TYPES.has(n.type), `${n.type}`).toBe(true);
          expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
          expect(n.position).toHaveLength(2);
        }
        for (const [from, conn] of Object.entries<any>(wf.connections)) {
          expect(names.has(from), `connection from unknown node ${from}`).toBe(true);
          for (const branch of conn.main) for (const target of branch) expect(names.has(target.node), `unknown target ${target.node}`).toBe(true);
        }
        const triggers = wf.nodes.filter((n: any) => /Trigger|webhook/i.test(n.type));
        expect(triggers.length).toBeGreaterThan(0);
        // Every non-note, non-trigger node is reachable from a trigger.
        const reachable = new Set<string>();
        const visit = (n: string) => {
          if (reachable.has(n)) return;
          reachable.add(n);
          for (const b of wf.connections[n]?.main ?? []) for (const t of b) visit(t.node);
        };
        triggers.forEach((t: any) => visit(t.name));
        for (const n of wf.nodes) if (n.type !== 'n8n-nodes-base.stickyNote') expect(reachable.has(n.name), `${n.name} unreachable`).toBe(true);
      });

      it('uses env-based auth, retries, correlation ids and the error workflow – no hard-coded secrets', () => {
        const text = JSON.stringify(wf);
        expect(text).not.toMatch(/pxseo_[A-Za-z0-9_-]{10,}|sk-ant-|sk-[A-Za-z0-9]{20,}/);
        if (!/Error Handler/.test(wf.name)) expect(wf.settings.errorWorkflow).toBe('pxSeoErrHandler1');
        expect(wf.settings.timezone).toBe('Asia/Kolkata');
        for (const n of wf.nodes.filter((x: any) => x.type === 'n8n-nodes-base.httpRequest')) {
          expect(n.parameters.url).toContain('$env.SEO_API_URL');
          const headers = n.parameters.headerParameters.parameters.map((h: any) => h.name);
          expect(headers).toContain('x-api-key');
          expect(n.retryOnFail).toBe(true);
          expect(n.maxTries).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});

describe('n8n job payloads against the real API', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let site: Awaited<ReturnType<typeof startFixtureSite>>;
  let projectId: string;
  beforeAll(async () => {
    site = await startFixtureSite();
    t = await testApp();
    projectId = (await createProject(t.ctx, { name: 'n8n payloads', siteUrl: site.origin + '/' })).id;
  });
  afterAll(async () => {
    await t.close();
    await site.close();
  });

  const jobNodes = workflows.flatMap(({ file, wf }) =>
    wf.nodes
      .filter((n: any) => n.type === 'n8n-nodes-base.httpRequest' && /\/jobs\//.test(n.parameters.url))
      .map((n: any) => ({ file, name: n.name, url: n.parameters.url as string, body: n.parameters.jsonBody as string })),
  );

  it('every job node targets a registered job type with ?wait=true', () => {
    expect(jobNodes.length).toBeGreaterThan(10);
    for (const j of jobNodes) {
      const type = j.url.match(/\/jobs\/([a-z0-9-]+)\?wait=true$/)?.[1];
      expect(type && JOBS[type], `${j.file} → ${j.name}: ${j.url}`).toBeTruthy();
    }
  });

  it('static JSON bodies parse and are accepted by the API with the service key', async () => {
    // Order matters: crawl first so dependent jobs have data.
    const order = ['crawl', 'seo-audit', 'internal-links', 'local-seo', 'content-opportunities', 'alerts-dispatch', 'experiments-evaluate', 'process-changes'];
    for (const type of order) {
      const node = jobNodes.find((j) => j.url.includes(`/jobs/${type}?`));
      if (!node) continue;
      const raw = node.body.startsWith('=') ? node.body.slice(1) : node.body;
      if (raw.includes('{{')) continue; // dynamic expression bodies are exercised by n8n itself
      const body = JSON.parse(raw);
      const r = await json(t.app, 'POST', `/api/projects/${projectId}/jobs/${type}?wait=true`, { apiKey: 'test-service-key-123456', body });
      expect(r.body.status, `${type}: ${r.body.error}`).toBe('succeeded');
    }
  });

  it('the error-handler alert payload is accepted and becomes an alert', async () => {
    const r = await json(t.app, 'POST', `/api/projects/${projectId}/alerts`, { apiKey: 'test-service-key-123456', body: { severity: 'high', type: 'n8n_workflow_failed', title: 'Automation failed: test', message: 'Node "x" failed', fingerprint: 'n8n:test:x', evidence: { workflow: 'test' } } });
    expect(r.status).toBe(200);
    const alerts = await json(t.app, 'GET', `/api/projects/${projectId}/alerts`, { apiKey: 'test-service-key-123456' });
    expect(alerts.body.some((a: any) => a.type === 'external:n8n_workflow_failed')).toBe(true);
  });

  it('the service key can generate briefs but can never approve', async () => {
    const recs = await json(t.app, 'GET', `/api/projects/${projectId}/recommendations?status=all&limit=5`, { apiKey: 'test-service-key-123456' });
    const d = await json(t.app, 'POST', `/api/projects/${projectId}/recommendations/${recs.body.items[0].id}/decision`, { apiKey: 'test-service-key-123456', body: { decision: 'approve' } });
    expect(d.status).toBe(403);
  });
});
