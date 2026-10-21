import type { GoogleAuth } from './google.js';

export interface Ga4Row {
  date: string;
  landingPage: string;
  channelGroup: string;
  source: string;
  medium: string;
  sessions: number;
  users: number;
  engagedSessions: number;
  engagementRate: number;
  conversions: number;
}

interface RunReportResponse {
  rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[];
  rowCount?: number;
}

/** GA4 Data API (runReport). "conversions" = GA4 key events; 0 if none are configured. */
export class Ga4Client {
  constructor(
    private auth: GoogleAuth,
    private propertyId: string,
  ) {}

  async fetchRange(startDate: string, endDate: string): Promise<Ga4Row[]> {
    const out: Ga4Row[] = [];
    const limit = 50000;
    for (let offset = 0; ; offset += limit) {
      const res = await this.auth.request<RunReportResponse>(`https://analyticsdata.googleapis.com/v1beta/properties/${this.propertyId}:runReport`, {
        method: 'POST',
        body: {
          dateRanges: [{ startDate, endDate }],
          dimensions: [{ name: 'date' }, { name: 'landingPage' }, { name: 'sessionDefaultChannelGroup' }, { name: 'sessionSource' }, { name: 'sessionMedium' }],
          metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagedSessions' }, { name: 'engagementRate' }, { name: 'keyEvents' }],
          limit,
          offset,
        },
      });
      for (const r of res.rows ?? []) {
        const d = r.dimensionValues.map((x) => x.value);
        const m = r.metricValues.map((x) => Number(x.value) || 0);
        const date = d[0] ?? '';
        out.push({
          date: date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : date,
          landingPage: d[1] ?? '',
          channelGroup: d[2] ?? '',
          source: d[3] ?? '',
          medium: d[4] ?? '',
          sessions: m[0] ?? 0,
          users: m[1] ?? 0,
          engagedSessions: m[2] ?? 0,
          engagementRate: m[3] ?? 0,
          conversions: m[4] ?? 0,
        });
      }
      if ((res.rows?.length ?? 0) < limit) break;
    }
    return out;
  }
}
