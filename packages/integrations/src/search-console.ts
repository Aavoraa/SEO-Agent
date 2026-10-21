import type { GoogleAuth } from './google.js';

export interface GscApiRow {
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

interface SearchAnalyticsResponse {
  rows?: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[];
}

/**
 * Search Console Search Analytics API.
 * Data is fetched per day with dimensions [date, query, page, country, device] and paginated
 * (25k rows/request). Note: GSC omits anonymised queries, so query totals < site totals.
 */
export class SearchConsoleClient {
  constructor(
    private auth: GoogleAuth,
    private siteUrl: string,
  ) {}

  private endpoint() {
    return `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(this.siteUrl)}/searchAnalytics/query`;
  }

  async listSites(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
    const r = await this.auth.request<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>('https://searchconsole.googleapis.com/webmasters/v3/sites');
    return r.siteEntry ?? [];
  }

  async fetchRange(startDate: string, endDate: string, opts: { dimensions?: string[]; rowLimit?: number; maxRows?: number } = {}): Promise<GscApiRow[]> {
    const dimensions = opts.dimensions ?? ['date', 'query', 'page', 'country', 'device'];
    const rowLimit = opts.rowLimit ?? 25000;
    const out: GscApiRow[] = [];
    for (let startRow = 0; ; startRow += rowLimit) {
      const res = await this.auth.request<SearchAnalyticsResponse>(this.endpoint(), {
        method: 'POST',
        body: { startDate, endDate, dimensions, rowLimit, startRow, dataState: 'final', type: 'web' },
      });
      const rows = res.rows ?? [];
      for (const r of rows) {
        const rec: Record<string, string> = {};
        dimensions.forEach((d, i) => (rec[d] = r.keys[i] ?? ''));
        out.push({ date: rec.date ?? startDate, query: rec.query ?? '', page: rec.page ?? '', country: rec.country ?? '', device: rec.device ?? '', clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
      }
      if (rows.length < rowLimit || (opts.maxRows && out.length >= opts.maxRows)) break;
    }
    return out;
  }

  /** Site-level daily totals (no query dimension → includes anonymised queries). */
  async fetchDailyTotals(startDate: string, endDate: string): Promise<GscApiRow[]> {
    return this.fetchRange(startDate, endDate, { dimensions: ['date'] });
  }
}
