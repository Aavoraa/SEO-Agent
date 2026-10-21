export interface RedirectHop {
  url: string;
  status: number;
  location: string | null;
}

export interface LinkRef {
  href: string; // absolute, normalised
  anchor: string;
  rel: string | null;
  nofollow: boolean;
}

export interface ImageRef {
  src: string;
  alt: string | null;
  hasAlt: boolean;
  width?: string | null;
  height?: string | null;
  loading?: string | null;
}

export interface StructuredDataBlock {
  valid: boolean;
  error?: string;
  types: string[];
  raw: string;
  data?: unknown;
}

export interface PageSignals {
  hasViewport: boolean;
  hasCharset: boolean;
  /** Count of double-encoded UTF-8 sequences like "â€”" visible in text. */
  mojibakeCount: number;
  mixedContent: string[];
  duplicateMetaTags: string[];
  relativeOgImage: boolean;
  htmlLang: string | null;
  headingOrderSkips: number;
  hotlinkedImages: number;
  /** Phone numbers found in tel: links and visible text (digits only). */
  phones: string[];
  /** Precise claims found in visible text (stats, superlatives, guarantees) that need evidence. */
  claims: string[];
}

export interface CrawledPage {
  url: string;
  finalUrl: string;
  statusCode: number | null;
  redirectChain: RedirectHop[];
  redirectLoop: boolean;
  responseTimeMs: number | null;
  contentType: string | null;
  contentLength: number | null;
  canonical: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  indexable: boolean;
  indexabilityReason: string | null;
  title: string | null;
  metaDescription: string | null;
  h1s: string[];
  h2s: string[];
  h3s: string[];
  wordCount: number;
  images: ImageRef[];
  internalLinks: LinkRef[];
  externalLinks: LinkRef[];
  structuredData: StructuredDataBlock[];
  openGraph: Record<string, string>;
  hreflang: { lang: string; href: string }[];
  lang: string | null;
  contentHash: string | null;
  /** First ~3,000 chars of visible text, used for similarity and AI context (never the whole site). */
  textSample: string;
  signals: PageSignals;
  depth: number;
  inSitemap: boolean;
  discoveredFrom: string | null;
  blockedByRobots: boolean;
  error: string | null;
}

export interface SiteChecks {
  baseUrl: string;
  robots: {
    url: string;
    status: number | null;
    found: boolean;
    sitemaps: string[];
    disallowAll: boolean;
    rules: { userAgent: string; allow: string[]; disallow: string[] }[];
    error?: string;
  };
  sitemaps: {
    url: string;
    status: number | null;
    urlCount: number;
    error?: string;
  }[];
  sitemapUrls: string[];
  https: {
    httpRedirectsToHttps: boolean | null;
    httpStatus: number | null;
    finalUrl: string | null;
  };
  hostCanonicalization: {
    variant: string;
    finalUrl: string | null;
    status: number | null;
    consistent: boolean;
  }[];
  notFoundHandling: { url: string; status: number | null; soft404: boolean } | null;
  homepageReachable: boolean;
  /** Technology stack, analytics, rendering mode and AI-crawler access (absent on crawls before Phase 1). */
  profile?: SiteProfile;
}

export interface AiCrawlerAccess {
  /** robots.txt user-agent token */
  token: string;
  owner: string;
  product: string;
  /** search/user = affects appearing and being cited in that product; training = model-training opt-out only */
  purpose: 'search' | 'user' | 'training';
  allowed: boolean;
  /** Which robots.txt group decided it: the bot's own token, '*' or none. */
  matchedGroup: string | null;
}

export interface SiteProfile {
  server: string | null;
  poweredBy: string | null;
  technologies: { name: string; category: 'cms' | 'framework' | 'library' | 'analytics' | 'hosting' | 'cdn' | 'seo_plugin' }[];
  analytics: { ga4: string[]; gtm: string[] };
  rendering: 'static-html' | 'cms' | 'framework-ssr' | 'client-side';
  renderingNote: string;
  aiCrawlers: AiCrawlerAccess[];
  /** Response headers of the homepage relevant to security (null = header absent). Optional on older crawls. */
  securityHeaders?: { hsts: string | null; contentTypeOptions: string | null; frameOptions: string | null; csp: string | null; referrerPolicy: string | null; permissionsPolicy: string | null };
  /** Whether the site allows being shown inside an iframe (X-Frame-Options / CSP frame-ancestors). */
  embeddable?: boolean;
  /** /llms.txt – an optional proposal some AI tools read; not used by Google Search. */
  llmsTxt: { url: string; status: number | null; found: boolean };
}

export interface CrawlOutput {
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  pages: CrawledPage[];
  site: SiteChecks;
  externalLinkStatus: Record<string, number | null>;
  stats: {
    pagesCrawled: number;
    pagesFailed: number;
    durationMs: number;
    truncated: boolean;
  };
}
