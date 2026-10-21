import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, testApp } from './helpers.js';
import { startFixtureSite } from '../../../tests/fixtures/site.js';
import { createProject } from '../src/services/projects.js';

let t: Awaited<ReturnType<typeof testApp>>;
let site: Awaited<ReturnType<typeof startFixtureSite>>;
let projectId: string;
const SERVICE = 'test-service-key-123456';

beforeAll(async () => {
  site = await startFixtureSite();
  t = await testApp();
  projectId = (await createProject(t.ctx, { name: 'Catalog', siteUrl: site.origin + '/' })).id;
});
afterAll(async () => {
  await t.close();
  await site.close();
});

describe('integrations catalog', () => {
  it('reports the real state of every provider and never claims planned ones', async () => {
    const r = await json(t.app, 'GET', `/api/projects/${projectId}/integrations/catalog`, { apiKey: SERVICE });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.body.entries.map((e: any) => [e.id, e]));
    expect(by.crawler).toMatchObject({ status: 'connected', dataLabel: 'verified' });
    expect(by.google_search_console.status).toBe('integration_required'); // no Google credentials in tests
    expect(by.ai_provider).toMatchObject({ status: 'configured', dataLabel: 'modeled' }); // mock provider
    expect(by.backlinks.status).toBe('manual');
    expect(by.website_adapter.status).toBe('manual');
    for (const id of ['keyword_data', 'serp', 'ai_visibility', 'pagespeed', 'google_business_profile']) expect(by[id]).toMatchObject({ status: 'planned', dataLabel: 'unavailable' });
    expect(by.keyword_data.phase).toBe(3);
  });
});

describe('AI readiness', () => {
  it('is unavailable before a crawl, then reports crawler access and structure checks', async () => {
    const before = await json(t.app, 'GET', `/api/projects/${projectId}/ai-readiness`, { apiKey: SERVICE });
    expect(before.body).toMatchObject({ available: false });
    expect((await json(t.app, 'POST', `/api/projects/${projectId}/jobs/crawl?wait=true`, { apiKey: SERVICE, body: {} })).body.status).toBe('succeeded');
    const r = await json(t.app, 'GET', `/api/projects/${projectId}/ai-readiness`, { apiKey: SERVICE });
    expect(r.body.available).toBe(true);
    expect(r.body.dataLabel).toBe('verified');
    expect(r.body.crawlers.find((c: any) => c.token === 'OAI-SearchBot')).toMatchObject({ allowed: true, purpose: 'search' });
    const checks = Object.fromEntries(r.body.checks.map((c: any) => [c.id, c]));
    expect(checks.search_crawlers.ok).toBe(true);
    expect(checks.schema_org.ok).toBe(false); // fixture homepage JSON-LD is invalid
    expect(r.body.llmsTxt.found).toBe(false);
    expect(r.body.stack.rendering).toBe('static-html');
  });
});
