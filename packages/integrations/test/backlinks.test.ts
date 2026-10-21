import { describe, expect, it } from 'vitest';
import { backlinkProviderFromConfig, DataForSeoBacklinks } from '../src/index.js';

const ok = (items: unknown[], total = items.length) =>
  new Response(JSON.stringify({ status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 20000, status_message: 'Ok.', result: [{ total_count: total, items }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('DataForSEO backlinks client', () => {
  it('sends basic auth + the target domain and maps items', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return ok([{ url_from: 'https://blog.example/post', url_to: 'https://www.phoenixxit.com/', anchor: ' Phoenixx IT ', dofollow: false, first_seen: '2026-01-02 10:00:00 +00:00', last_seen: '2026-09-01 08:00:00 +00:00', is_lost: false }]);
    }) as unknown as typeof fetch;
    const links = await new DataForSeoBacklinks('me@example.com', 'secret', fake).fetchBacklinks('phoenixxit.com', { limit: 10 });
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Basic ' + Buffer.from('me@example.com:secret').toString('base64'));
    expect(JSON.parse(calls[0]!.init.body as string)[0]).toMatchObject({ target: 'phoenixxit.com', limit: 10, backlinks_status_type: 'all' });
    expect(links).toEqual([{ sourceUrl: 'https://blog.example/post', targetUrl: 'https://www.phoenixxit.com/', anchor: 'Phoenixx IT', nofollow: true, firstSeen: '2026-01-02T10:00:00.000Z', lastSeen: '2026-09-01T08:00:00.000Z', lost: false }]);
  });

  it('surfaces API errors instead of returning an empty list', async () => {
    const fake = (async () => new Response(JSON.stringify({ status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 40200, status_message: 'Payment Required.' }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(new DataForSeoBacklinks('a', 'b', fake).fetchBacklinks('phoenixxit.com')).rejects.toThrow(/Payment Required/);
  });

  it('is only created when configured, and requires credentials', () => {
    expect(backlinkProviderFromConfig({ BACKLINK_PROVIDER: 'none' })).toBeNull();
    expect(() => backlinkProviderFromConfig({ BACKLINK_PROVIDER: 'dataforseo' })).toThrow(/DATAFORSEO_LOGIN/);
    expect(backlinkProviderFromConfig({ BACKLINK_PROVIDER: 'dataforseo', DATAFORSEO_LOGIN: 'a', DATAFORSEO_PASSWORD: 'b' })?.name).toBe('dataforseo');
  });
});
