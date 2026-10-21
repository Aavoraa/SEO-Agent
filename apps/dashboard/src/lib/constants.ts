export const CHANGE_STATUSES = ['detected', 'analyzed', 'recommended', 'pending_approval', 'approved', 'rejected', 'implemented', 'verified', 'monitoring', 'completed', 'rolled_back', 'failed'] as const;

export const RECOMMENDATION_TYPES = ['title', 'meta_description', 'h1', 'headings', 'content', 'faq', 'schema', 'internal_link', 'alt_text', 'canonical', 'redirect', 'robots', 'noindex', 'sitemap', 'new_page', 'cta', 'technical', 'other'] as const;

export const RECOMMENDATION_SOURCES = ['rule', 'keyword', 'local', 'internal_linking', 'content', 'migration', 'ai', 'competitor', 'backlinks'] as const;

export const PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export const RISKS = ['low', 'medium', 'high'] as const;
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
