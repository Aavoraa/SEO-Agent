/**
 * Backlink data providers. Google's Search Console API does not expose the Links report, so
 * backlinks come either from a CSV export (handled in the API) or from a third-party index.
 * DataForSEO is supported because it is pay-per-request with no subscription.
 */
export interface ProviderBacklink {
  sourceUrl: string;
  targetUrl: string;
  anchor: string | null;
  nofollow: boolean | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** The provider saw this link disappear. */
  lost: boolean;
}

export interface BacklinkProvider {
  readonly name: string;
  fetchBacklinks(domain: string, opts?: { limit?: number }): Promise<ProviderBacklink[]>;
}

interface DataForSeoItem {
  url_from: string;
  url_to: string;
  anchor?: string | null;
  dofollow?: boolean | null;
  first_seen?: string | null;
  last_seen?: string | null;
  is_lost?: boolean | null;
}

interface DataForSeoResponse {
  status_code: number;
  status_message: string;
  tasks?: { status_code: number; status_message: string; result?: { total_count?: number; items?: DataForSeoItem[] | null }[] | null }[];
}

const toIso = (v?: string | null) => {
  if (!v) return null;
  const d = new Date(v.replace(' +00:00', 'Z').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** DataForSEO Backlinks API (v3 backlinks/backlinks/live). */
export class DataForSeoBacklinks implements BacklinkProvider {
  readonly name = 'dataforseo';
  constructor(
    private login: string,
    private password: string,
    private fetchImpl: typeof fetch = fetch,
    private endpoint = 'https://api.dataforseo.com/v3/backlinks/backlinks/live',
  ) {}

  async fetchBacklinks(domain: string, opts: { limit?: number } = {}): Promise<ProviderBacklink[]> {
    const limit = opts.limit ?? 1000;
    const out: ProviderBacklink[] = [];
    const pageSize = Math.min(1000, limit);
    for (let offset = 0; offset < limit; offset += pageSize) {
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: 'Basic ' + Buffer.from(`${this.login}:${this.password}`).toString('base64'), 'content-type': 'application/json' },
        body: JSON.stringify([{ target: domain, mode: 'as_is', include_subdomains: true, backlinks_status_type: 'all', limit: pageSize, offset, order_by: ['rank,desc'] }]),
      });
      if (!res.ok) throw new Error(`DataForSEO HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as DataForSeoResponse;
      const task = body.tasks?.[0];
      if (body.status_code !== 20000 || !task || task.status_code !== 20000) throw new Error(`DataForSEO error: ${task?.status_message ?? body.status_message}`);
      const result = task.result?.[0];
      const items = result?.items ?? [];
      for (const i of items) {
        out.push({ sourceUrl: i.url_from, targetUrl: i.url_to, anchor: i.anchor?.trim() || null, nofollow: i.dofollow == null ? null : !i.dofollow, firstSeen: toIso(i.first_seen), lastSeen: toIso(i.last_seen), lost: !!i.is_lost });
      }
      if (items.length < pageSize || out.length >= (result?.total_count ?? 0)) break;
    }
    return out;
  }
}

export function backlinkProviderFromConfig(cfg: { BACKLINK_PROVIDER: string; DATAFORSEO_LOGIN?: string; DATAFORSEO_PASSWORD?: string }): BacklinkProvider | null {
  if (cfg.BACKLINK_PROVIDER === 'dataforseo') {
    if (!cfg.DATAFORSEO_LOGIN || !cfg.DATAFORSEO_PASSWORD) throw new Error('BACKLINK_PROVIDER=dataforseo requires DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD');
    return new DataForSeoBacklinks(cfg.DATAFORSEO_LOGIN, cfg.DATAFORSEO_PASSWORD);
  }
  return null;
}
