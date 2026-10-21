import type { BusinessProfile } from '@phoenixx/shared';
import { normalizeKeyword } from './intent.js';

/**
 * Semantic expansion: candidate keywords derived from the service taxonomy × target
 * locations and a few intent modifiers. These are HYPOTHESES, not demand data:
 * search volume is always "unavailable" until Search Console shows impressions.
 */
export interface ExpandedKeyword {
  keyword: string;
  services: string[];
  locations: string[];
  pattern: string;
}

const MODIFIERS = ['{service} company in {location}', '{service} services {location}', 'best {service} agency {location}', '{service} cost'];

export function expandKeywords(profile: BusinessProfile, existing: Set<string> = new Set(), limitPerService = 6): ExpandedKeyword[] {
  const out: ExpandedKeyword[] = [];
  const locations = profile.locations.filter((l) => l.target && l.level !== 'locality');
  for (const s of profile.services) {
    const head = s.terms[0] ?? s.name.toLowerCase();
    let n = 0;
    for (const pattern of MODIFIERS) {
      const locs = pattern.includes('{location}') ? locations : [null];
      for (const loc of locs) {
        if (n >= limitPerService) break;
        const kw = normalizeKeyword(pattern.replace('{service}', head).replace('{location}', loc?.name ?? ''));
        if (existing.has(kw)) continue;
        out.push({ keyword: kw, services: [s.id], locations: loc ? [loc.id] : [], pattern });
        n++;
      }
    }
  }
  return out;
}
