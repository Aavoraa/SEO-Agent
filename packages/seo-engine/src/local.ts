import { round, type BusinessProfile } from '@phoenixx/shared';

/**
 * Local SEO: builds a Service × Location matrix from real Search Console demand and
 * existing page coverage. It deliberately recommends a NEW location page only when
 * there is demand evidence AND no existing page can reasonably serve the intent –
 * preventing thin, doorway-style location pages.
 */
export interface LocalQueryInput {
  query: string;
  impressions: number;
  clicks: number;
  position: number;
  services: string[];
  locations: string[];
  topPage?: string | null;
}

export interface LocalPageInput {
  url: string;
  title: string | null;
  h1: string | null;
  services: string[];
  locations: string[];
}

export type LocalAction = 'optimize_existing_page' | 'create_location_page' | 'add_location_section' | 'monitor' | 'no_action';

export interface LocalCell {
  serviceId: string;
  serviceName: string;
  locationId: string;
  locationName: string;
  impressions: number;
  clicks: number;
  avgPosition: number | null;
  queries: string[];
  coveringPage: string | null;
  action: LocalAction;
  rationale: string;
  score: number;
}

export function buildLocalMatrix(queries: LocalQueryInput[], pages: LocalPageInput[], profile: BusinessProfile, opts: { minImpressionsForNewPage?: number } = {}): LocalCell[] {
  const minNew = opts.minImpressionsForNewPage ?? 200;
  const cells: LocalCell[] = [];
  const locs = profile.locations.filter((l) => l.level !== 'locality');
  for (const svc of profile.services) {
    for (const loc of locs) {
      const qs = queries.filter((q) => q.services.includes(svc.id) && q.locations.includes(loc.id));
      const impressions = qs.reduce((s, q) => s + q.impressions, 0);
      const clicks = qs.reduce((s, q) => s + q.clicks, 0);
      const avgPosition = impressions ? round(qs.reduce((s, q) => s + q.position * q.impressions, 0) / impressions, 1) : null;
      const svcPage = pages.find((p) => p.services.includes(svc.id) && svc.path && new URL(p.url).pathname === svc.path) ?? pages.find((p) => p.services.includes(svc.id));
      const locPage = pages.find((p) => p.services.includes(svc.id) && p.locations.includes(loc.id));
      const coveringPage = locPage?.url ?? svcPage?.url ?? null;
      let action: LocalAction = 'no_action';
      let rationale = '';
      if (!impressions && !loc.target) continue; // detection-only locations appear only with evidence
      if (!impressions) {
        action = 'monitor';
        rationale = 'No Search Console impressions yet for this combination – do not create content without demand evidence.';
      } else if (locPage) {
        action = avgPosition && avgPosition > 3 ? 'optimize_existing_page' : 'monitor';
        rationale = `Existing page ${new URL(locPage.url).pathname} already targets ${svc.name} + ${loc.name}.`;
      } else if (svcPage && (loc.target || impressions < minNew)) {
        action = loc.level === 'country' ? 'monitor' : 'add_location_section';
        rationale = loc.level === 'country' ? `National queries can be served by the main ${svc.name} page.` : `Serve ${loc.name} intent on the existing ${svc.name} page (location-specific section, FAQs, NAP) rather than a thin new page.`;
      } else if (!svcPage && impressions >= minNew && loc.target) {
        action = 'create_location_page';
        rationale = `${impressions} impressions for ${svc.name} + ${loc.name} with no page covering the service. A substantive page is justified if Phoenixx IT genuinely offers this service.`;
      } else if (!loc.target && impressions >= minNew) {
        action = 'monitor';
        rationale = `Demand exists for ${loc.name}, but it is not a target location. Only pursue if Phoenixx IT actually serves ${loc.name} clients.`;
      } else {
        action = 'monitor';
        rationale = 'Demand is too low to justify new content.';
      }
      const score = round(Math.min(100, Math.log10(impressions + 1) * 20 + (avgPosition && avgPosition >= 4 && avgPosition <= 20 ? 20 : 0) + (loc.target ? 15 : 0) + (action === 'create_location_page' ? 10 : 0)), 0);
      cells.push({ serviceId: svc.id, serviceName: svc.name, locationId: loc.id, locationName: loc.name, impressions, clicks, avgPosition, queries: qs.sort((a, b) => b.impressions - a.impressions).slice(0, 8).map((q) => q.query), coveringPage, action, rationale, score });
    }
  }
  return cells.sort((a, b) => b.score - a.score);
}
