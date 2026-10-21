import type { BusinessProfile } from '@phoenixx/shared';

/**
 * Structured-data generator + validator.
 * Only schema that truthfully describes visible page content is generated
 * (e.g. FAQPage only when real Q&A exists on the page). No review/rating markup
 * is ever generated because there is no verified review data.
 */

type Json = Record<string, unknown>;

export const REQUIRED_PROPS: Record<string, string[]> = {
  Organization: ['name', 'url'],
  LocalBusiness: ['name', 'address'],
  ProfessionalService: ['name', 'address'],
  WebSite: ['name', 'url'],
  WebPage: ['name', 'url'],
  Service: ['name', 'provider'],
  FAQPage: ['mainEntity'],
  BreadcrumbList: ['itemListElement'],
  Article: ['headline', 'author', 'datePublished'],
  BlogPosting: ['headline', 'author', 'datePublished'],
  PostalAddress: ['addressLocality', 'addressCountry'],
};

const RECOMMENDED_PROPS: Record<string, string[]> = {
  Organization: ['logo', 'sameAs', 'contactPoint'],
  LocalBusiness: ['telephone', 'url', 'geo', 'openingHoursSpecification'],
  ProfessionalService: ['telephone', 'url', 'geo'],
  Article: ['image', 'dateModified'],
  Service: ['areaServed', 'serviceType', 'description'],
};

export interface SchemaValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  types: string[];
}

function nodes(data: unknown): Json[] {
  const out: Json[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      const o = v as Json;
      if (o['@type']) out.push(o);
      if (o['@graph']) walk(o['@graph']);
      for (const [k, x] of Object.entries(o)) if (k !== '@graph' && x && typeof x === 'object') walk(x);
    }
  };
  walk(data);
  return out;
}

/** Validates a JSON-LD string or object: JSON syntax, @context, required and recommended properties. */
export function validateJsonLd(input: string | unknown): SchemaValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let data: unknown = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (e) {
      return { valid: false, errors: [`Invalid JSON: ${(e as Error).message}`], warnings, types: [] };
    }
  }
  const roots = Array.isArray(data) ? data : [data];
  for (const r of roots) {
    const ctx = (r as Json)?.['@context'];
    if (!ctx || !String(JSON.stringify(ctx)).includes('schema.org')) errors.push('Missing or invalid @context (expected https://schema.org)');
  }
  const all = nodes(data);
  if (!all.length) errors.push('No @type found');
  const types = new Set<string>();
  for (const n of all) {
    const tList = Array.isArray(n['@type']) ? (n['@type'] as string[]) : [String(n['@type'])];
    for (const t of tList) {
      types.add(t);
      for (const prop of REQUIRED_PROPS[t] ?? []) if (n[prop] === undefined || n[prop] === '' || (Array.isArray(n[prop]) && !(n[prop] as unknown[]).length)) errors.push(`${t}: missing required property "${prop}"`);
      for (const prop of RECOMMENDED_PROPS[t] ?? []) if (n[prop] === undefined) warnings.push(`${t}: recommended property "${prop}" not set`);
      if (t === 'FAQPage') {
        const qs = Array.isArray(n.mainEntity) ? (n.mainEntity as Json[]) : [];
        qs.forEach((q, i) => {
          if (q['@type'] !== 'Question' || !q.name) errors.push(`FAQPage: mainEntity[${i}] must be a Question with a name`);
          const a = q.acceptedAnswer as Json | undefined;
          if (!a || a['@type'] !== 'Answer' || !a.text) errors.push(`FAQPage: mainEntity[${i}] needs an acceptedAnswer with text`);
        });
      }
      if (['AggregateRating', 'Review'].includes(t)) warnings.push(`${t}: only use with genuine, visible, first-party review data`);
    }
  }
  return { valid: errors.length === 0, errors, warnings, types: [...types] };
}

/* ---------------- Generators ---------------- */

const CTX = 'https://schema.org';

export function organizationSchema(p: BusinessProfile): Json {
  return {
    '@context': CTX,
    '@type': 'Organization',
    '@id': new URL('#organization', p.url).toString(),
    name: p.name,
    url: p.url,
    ...(p.logoUrl ? { logo: p.logoUrl } : {}),
    description: p.description,
    ...(p.email ? { email: p.email } : {}),
    ...(p.phone ? { telephone: p.phone } : {}),
    ...(p.address ? { address: { '@type': 'PostalAddress', ...p.address } } : {}),
    ...(p.sameAs.length ? { sameAs: p.sameAs } : {}),
    ...(p.phone
      ? { contactPoint: { '@type': 'ContactPoint', contactType: 'customer service', telephone: p.phone, ...(p.email ? { email: p.email } : {}), availableLanguage: p.languages } }
      : {}),
  };
}

export function localBusinessSchema(p: BusinessProfile, type = 'ProfessionalService'): Json | null {
  if (!p.address) return null;
  return {
    '@context': CTX,
    '@type': type,
    '@id': new URL('#localbusiness', p.url).toString(),
    name: p.name,
    url: p.url,
    ...(p.logoUrl ? { image: p.logoUrl, logo: p.logoUrl } : {}),
    ...(p.phone ? { telephone: p.phone } : {}),
    ...(p.email ? { email: p.email } : {}),
    address: { '@type': 'PostalAddress', ...p.address },
    ...(p.geo ? { geo: { '@type': 'GeoCoordinates', latitude: p.geo.latitude, longitude: p.geo.longitude } } : {}),
    areaServed: p.locations.filter((l) => l.target && l.level !== 'locality').map((l) => ({ '@type': l.level === 'country' ? 'Country' : l.level === 'region' ? 'State' : 'City', name: l.name })),
    ...(p.sameAs.length ? { sameAs: p.sameAs } : {}),
    parentOrganization: { '@id': new URL('#organization', p.url).toString() },
  };
}

export function websiteSchema(p: BusinessProfile): Json {
  return { '@context': CTX, '@type': 'WebSite', '@id': new URL('#website', p.url).toString(), name: p.name, url: p.url, publisher: { '@id': new URL('#organization', p.url).toString() } };
}

export function serviceSchema(p: BusinessProfile, s: { name: string; description?: string; url: string; areaServed?: string[] }): Json {
  return {
    '@context': CTX,
    '@type': 'Service',
    name: s.name,
    serviceType: s.name,
    url: s.url,
    ...(s.description ? { description: s.description } : {}),
    provider: { '@type': 'Organization', '@id': new URL('#organization', p.url).toString(), name: p.name },
    areaServed: (s.areaServed ?? p.locations.filter((l) => l.target && l.level !== 'locality').map((l) => l.name)).map((name) => ({ '@type': 'Place', name })),
  };
}

export function faqSchema(items: { question: string; answer: string }[]): Json | null {
  if (!items.length) return null;
  return {
    '@context': CTX,
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({ '@type': 'Question', name: i.question, acceptedAnswer: { '@type': 'Answer', text: i.answer } })),
  };
}

export function breadcrumbSchema(crumbs: { name: string; url: string }[]): Json {
  return { '@context': CTX, '@type': 'BreadcrumbList', itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: c.url })) };
}

export function webPageSchema(p: BusinessProfile, page: { name: string; url: string; description?: string }): Json {
  return { '@context': CTX, '@type': 'WebPage', name: page.name, url: page.url, ...(page.description ? { description: page.description } : {}), isPartOf: { '@id': new URL('#website', p.url).toString() } };
}

export function articleSchema(p: BusinessProfile, a: { headline: string; url: string; datePublished: string; dateModified?: string; authorName?: string; image?: string }): Json {
  return {
    '@context': CTX,
    '@type': 'Article',
    headline: a.headline.slice(0, 110),
    mainEntityOfPage: a.url,
    datePublished: a.datePublished,
    dateModified: a.dateModified ?? a.datePublished,
    author: a.authorName ? { '@type': 'Person', name: a.authorName } : { '@type': 'Organization', name: p.name },
    publisher: { '@type': 'Organization', name: p.name, ...(p.logoUrl ? { logo: { '@type': 'ImageObject', url: p.logoUrl } } : {}) },
    ...(a.image ? { image: a.image } : {}),
  };
}

/** Recommend the set of schema blocks appropriate for a page, based on what the page actually is. */
export function recommendSchemaForPage(
  p: BusinessProfile,
  page: { url: string; title: string | null; description: string | null; pageType: string; faqs?: { question: string; answer: string }[]; serviceName?: string },
): { type: string; jsonLd: Json; reason: string }[] {
  const out: { type: string; jsonLd: Json; reason: string }[] = [];
  if (page.pageType === 'home') {
    out.push({ type: 'Organization', jsonLd: organizationSchema(p), reason: 'Identifies the business entity, logo, contact and social profiles.' });
    out.push({ type: 'WebSite', jsonLd: websiteSchema(p), reason: 'Declares the site name for search results.' });
    const lb = localBusinessSchema(p);
    if (lb) out.push({ type: 'ProfessionalService', jsonLd: lb, reason: 'The business has a physical office in Coimbatore; LocalBusiness data supports local relevance.' });
  }
  if (page.pageType === 'service' && page.serviceName) {
    out.push({ type: 'Service', jsonLd: serviceSchema(p, { name: page.serviceName, url: page.url, description: page.description ?? undefined }), reason: 'Describes the service offered on this page and who provides it.' });
    const path = new URL(page.url).pathname;
    out.push({ type: 'BreadcrumbList', jsonLd: breadcrumbSchema([{ name: 'Home', url: p.url }, { name: page.serviceName, url: page.url }]), reason: `Clarifies site hierarchy for ${path}.` });
  }
  if (page.faqs?.length) {
    const f = faqSchema(page.faqs);
    if (f) out.push({ type: 'FAQPage', jsonLd: f, reason: 'Page contains visible question/answer content. Note: Google shows FAQ rich results only for limited site types; markup still clarifies content.' });
  }
  return out;
}
