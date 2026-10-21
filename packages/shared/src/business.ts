/**
 * Business profile – the factual grounding the AI is allowed to use.
 * Defaults were taken from the live phoenixxit.com site (inspected 2026-09-28).
 * Everything is editable per project in Settings → Business profile; nothing here
 * is a claim the AI may embellish (no invented stats, clients, awards or years).
 */
export interface ServiceDef {
  id: string;
  name: string;
  /** Existing URL path on the site, if a page exists. */
  path?: string;
  /** Terms that indicate a query/page is about this service. Lowercase. */
  terms: string[];
}

export interface LocationDef {
  id: string;
  name: string;
  level: 'locality' | 'city' | 'region' | 'country';
  /** Lowercase aliases used for detection. */
  aliases: string[];
  /** true = the business actively targets this location. Others are detection-only. */
  target: boolean;
}

export interface BusinessProfile {
  name: string;
  legalName?: string;
  description: string;
  url: string;
  logoUrl?: string;
  phone?: string;
  email?: string;
  address?: {
    streetAddress: string;
    addressLocality: string;
    addressRegion: string;
    postalCode?: string;
    addressCountry: string;
  };
  geo?: { latitude: number; longitude: number };
  sameAs: string[];
  services: ServiceDef[];
  locations: LocationDef[];
  /** Verified facts the AI may cite. Leave empty rather than guessing. */
  facts: string[];
  /** Words the brand uses in CTAs. */
  ctas: string[];
  languages: string[];
}

export const DEFAULT_SERVICES: ServiceDef[] = [
  { id: 'app-development', name: 'App Development', path: '/app-development', terms: ['app development', 'mobile app', 'android app', 'ios app', 'application development', 'app developer', 'app developers', 'flutter', 'react native'] },
  { id: 'automation', name: 'Business Automation', path: '/automation', terms: ['automation', 'workflow automation', 'business automation', 'process automation', 'crm integration', 'zapier', 'n8n', 'rpa'] },
  { id: 'growth-consulting', name: 'Growth Consulting', path: '/growth-consulting', terms: ['growth consulting', 'business consulting', 'digital strategy', 'growth strategy', 'business growth'] },
  { id: 'website-design-development', name: 'Website Design & Development', path: '/website-design-development', terms: ['website design', 'web design', 'website development', 'web development', 'website developer', 'web developer', 'website designer', 'ecommerce website', 'wordpress'] },
  { id: 'performance-marketing', name: 'Performance Marketing', path: '/performance-marketing', terms: ['performance marketing', 'google ads', 'ppc', 'meta ads', 'facebook ads', 'paid ads', 'paid marketing'] },
  { id: 'digital-marketing', name: 'Digital Marketing', path: '/digital-marketing', terms: ['digital marketing', 'online marketing', 'social media marketing', 'smm', 'content marketing', 'email marketing'] },
  { id: 'seo', name: 'SEO Services', terms: ['seo', 'search engine optimization', 'local seo', 'seo agency', 'seo company', 'seo services'] },
  { id: 'branding-pr', name: 'Branding & PR', path: '/branding-pr', terms: ['branding', 'brand identity', 'public relations', 'pr agency', 'logo design', 'brand strategy'] },
  { id: 'lead-generation', name: 'Lead Generation', path: '/lead-generation', terms: ['lead generation', 'lead gen', 'b2b leads', 'sales leads'] },
  { id: 'software-development', name: 'Software Development', terms: ['software development', 'software company', 'custom software', 'software developer', 'saas development', 'erp', 'crm development'] },
  { id: 'it-services', name: 'IT Services', terms: ['it company', 'it companies', 'it services', 'it solutions', 'technology company', 'tech company', 'it consulting', 'it firm'] },
];

export const DEFAULT_LOCATIONS: LocationDef[] = [
  { id: 'vadavalli', name: 'Vadavalli', level: 'locality', aliases: ['vadavalli'], target: true },
  { id: 'coimbatore', name: 'Coimbatore', level: 'city', aliases: ['coimbatore', 'cbe', 'kovai'], target: true },
  { id: 'tamil-nadu', name: 'Tamil Nadu', level: 'region', aliases: ['tamil nadu', 'tamilnadu', 'tn'], target: true },
  { id: 'india', name: 'India', level: 'country', aliases: ['india', 'indian'], target: true },
  // Detection-only: surfaced if real search data shows demand. Never auto-targeted.
  { id: 'chennai', name: 'Chennai', level: 'city', aliases: ['chennai'], target: false },
  { id: 'bangalore', name: 'Bengaluru', level: 'city', aliases: ['bangalore', 'bengaluru'], target: false },
  { id: 'tiruppur', name: 'Tiruppur', level: 'city', aliases: ['tiruppur', 'tirupur'], target: false },
  { id: 'erode', name: 'Erode', level: 'city', aliases: ['erode'], target: false },
  { id: 'madurai', name: 'Madurai', level: 'city', aliases: ['madurai'], target: false },
  { id: 'kochi', name: 'Kochi', level: 'city', aliases: ['kochi', 'cochin'], target: false },
];

export const DEFAULT_BUSINESS_PROFILE: BusinessProfile = {
  name: 'Phoenixx IT',
  description:
    'Phoenixx IT provides app development, automation, website development, digital marketing, lead generation and growth solutions for businesses.',
  url: 'https://www.phoenixxit.com/',
  logoUrl: 'https://www.phoenixxit.com/images/logo.png',
  phone: '+91 93427 21163',
  email: 'admin@phoenixxit.com',
  address: {
    streetAddress: '3rd Floor, 3/29, Jayanagar, Vadavalli',
    addressLocality: 'Coimbatore',
    addressRegion: 'Tamil Nadu',
    postalCode: '641041',
    addressCountry: 'IN',
  },
  geo: { latitude: 11.0286178, longitude: 76.9059176 },
  sameAs: ['https://www.linkedin.com/company/phoenixx-it', 'https://www.instagram.com/phoenixxit/', 'https://www.facebook.com/phoenixxit'],
  services: DEFAULT_SERVICES,
  locations: DEFAULT_LOCATIONS,
  facts: [
    'Office: 3rd Floor, 3/29, Jayanagar, Vadavalli, Coimbatore 641041, Tamil Nadu, India',
    'Customer service languages: English and Tamil',
    'Services offered: app development, business automation, growth consulting, website design & development, performance marketing, digital marketing, branding & PR, lead generation',
  ],
  ctas: ['Talk to Phoenixx IT', 'Get a free consultation', 'Contact Us'],
  languages: ['English', 'Tamil'],
};

export function detectServices(text: string, services: ServiceDef[] = DEFAULT_SERVICES): string[] {
  const t = ' ' + text.toLowerCase().replace(/[^a-z0-9&\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  return services.filter((s) => s.terms.some((term) => t.includes(' ' + term + ' ') || t.includes(' ' + term + 's '))).map((s) => s.id);
}

export function detectLocations(text: string, locations: LocationDef[] = DEFAULT_LOCATIONS): string[] {
  const t = ' ' + text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
  return locations.filter((l) => l.aliases.some((a) => t.includes(' ' + a + ' '))).map((l) => l.id);
}
