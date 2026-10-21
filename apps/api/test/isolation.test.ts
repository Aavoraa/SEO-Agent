import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { json, testApp } from './helpers.js';
import { createProject } from '../src/services/projects.js';

/** Two client projects on one platform: members of one must never see the other. */
let t: Awaited<ReturnType<typeof testApp>>;
let admin: string;
let a: string; // client A project
let b: string; // client B project
const SERVICE = 'test-service-key-123456';

const login = async (email: string) => (await json(t.app, 'POST', '/api/auth/login', { body: { email, password: 'password-long-enough' } })).body.token as string;

beforeAll(async () => {
  t = await testApp();
  a = (await createProject(t.ctx, { name: 'Client A', siteUrl: 'https://client-a.example/' })).id;
  b = (await createProject(t.ctx, { name: 'Client B', siteUrl: 'https://client-b.example/' })).id;
  admin = (await json(t.app, 'POST', '/api/auth/setup', { body: { email: 'admin@phoenixxit.com', name: 'Admin', password: 'correct horse battery' } })).body.token;
  const mk = (email: string, projects: { projectId: string; role: string }[]) => json(t.app, 'POST', '/api/auth/users', { token: admin, body: { email, name: email, password: 'password-long-enough', role: 'viewer', projects } });
  expect((await mk('viewer-a@client.example', [{ projectId: a, role: 'viewer' }])).status).toBe(200);
  expect((await mk('owner-b@client.example', [{ projectId: b, role: 'admin' }])).status).toBe(200);
  expect((await mk('nobody@client.example', [])).status).toBe(200);
});
afterAll(() => t.close());

describe('project isolation', () => {
  it('lists only the projects a user belongs to; platform admins see all', async () => {
    const va = await login('viewer-a@client.example');
    expect((await json(t.app, 'GET', '/api/projects', { token: va })).body.map((p: any) => p.id)).toEqual([a]);
    expect((await json(t.app, 'GET', '/api/projects', { token: await login('nobody@client.example') })).body).toEqual([]);
    expect((await json(t.app, 'GET', '/api/projects', { token: admin })).body.map((p: any) => p.id).sort()).toEqual([a, b].sort());
    const me = await json(t.app, 'GET', '/api/auth/me', { token: va });
    expect(me.body.memberships).toEqual([{ projectId: a, role: 'viewer' }]);
  });

  it("returns 404 for another client's project on every route", async () => {
    const va = await login('viewer-a@client.example');
    for (const path of ['', '/overview', '/issues', '/recommendations', '/backlinks', '/audit-logs', '/members']) {
      expect((await json(t.app, 'GET', `/api/projects/${b}${path}`, { token: va })).status, path).toBe(404);
    }
    expect((await json(t.app, 'POST', `/api/projects/${b}/jobs/crawl`, { token: va })).status).toBe(404);
    expect((await json(t.app, 'GET', `/api/projects/${a}/overview`, { token: va })).status).toBe(200);
  });

  it('applies the membership role per project', async () => {
    const va = await login('viewer-a@client.example');
    expect((await json(t.app, 'POST', `/api/projects/${a}/jobs/crawl`, { token: va })).status).toBe(403); // viewer in A
    const ob = await login('owner-b@client.example');
    // Project admin of B: may manage B's settings and members, but not create projects or users.
    expect((await json(t.app, 'PATCH', `/api/projects/${b}`, { token: ob, body: { name: 'Client B (renamed)' } })).status).toBe(200);
    expect((await json(t.app, 'POST', '/api/projects', { token: ob, body: { name: 'X', siteUrl: 'https://x.example/' } })).status).toBe(400); // needs an organization it may create projects in
    expect((await json(t.app, 'POST', '/api/auth/users', { token: ob, body: { email: 'x@x.example', name: 'x', password: 'password-long-enough' } })).status).toBe(403);
    expect((await json(t.app, 'PATCH', `/api/projects/${a}`, { token: ob, body: { name: 'hijack' } })).status).toBe(404);
  });

  it('project admins manage members of their own project only', async () => {
    const ob = await login('owner-b@client.example');
    const nobody = (await json(t.app, 'GET', '/api/auth/users', { token: admin })).body.find((u: any) => u.email === 'nobody@client.example');
    expect((await json(t.app, 'PUT', `/api/projects/${b}/members/${nobody.id}`, { token: ob, body: { role: 'editor' } })).status).toBe(200);
    const members = await json(t.app, 'GET', `/api/projects/${b}/members`, { token: ob });
    expect(members.body.map((m: any) => [m.email, m.role])).toEqual([['owner-b@client.example', 'admin'], ['nobody@client.example', 'editor']]);
    expect((await json(t.app, 'GET', '/api/projects', { token: await login('nobody@client.example') })).body.map((p: any) => p.id)).toEqual([b]);
    expect((await json(t.app, 'PUT', `/api/projects/${a}/members/${nobody.id}`, { token: ob, body: { role: 'admin' } })).status).toBe(404);
    expect((await json(t.app, 'POST', `/api/projects/${b}/members`, { token: ob, body: { email: 'VIEWER-A@client.example', role: 'viewer' } })).status).toBe(200);
    expect((await json(t.app, 'POST', `/api/projects/${b}/members`, { token: ob, body: { email: 'ghost@client.example', role: 'viewer' } })).status).toBe(404);
    expect((await json(t.app, 'GET', `/api/projects/${b}`, { token: ob })).body.myRole).toBe('admin');
    expect((await json(t.app, 'GET', `/api/projects/${b}`, { token: await login('viewer-a@client.example') })).body.myRole).toBe('viewer');
    const va = await login('viewer-a@client.example');
    expect((await json(t.app, 'GET', `/api/projects/${a}/members`, { token: va })).status).toBe(403);
    expect((await json(t.app, 'DELETE', `/api/projects/${b}/members/${nobody.id}`, { token: ob })).status).toBe(200);
    expect((await json(t.app, 'GET', `/api/projects/${b}/overview`, { token: await login('nobody@client.example') })).status).toBe(404);
  });

  it('project-scoped API keys only reach their project; the n8n service key reaches all', async () => {
    const k = await json(t.app, 'POST', '/api/auth/api-keys', { token: admin, body: { name: 'client-a-n8n', projectId: a } });
    expect(k.body.project_id).toBe(a);
    expect((await json(t.app, 'GET', '/api/projects', { apiKey: k.body.key })).body.map((p: any) => p.id)).toEqual([a]);
    expect((await json(t.app, 'GET', `/api/projects/${a}/jobs`, { apiKey: k.body.key })).status).toBe(200);
    expect((await json(t.app, 'GET', `/api/projects/${b}/jobs`, { apiKey: k.body.key })).status).toBe(404);
    expect((await json(t.app, 'GET', `/api/projects/${b}/jobs`, { apiKey: SERVICE })).status).toBe(200);
  });
});
