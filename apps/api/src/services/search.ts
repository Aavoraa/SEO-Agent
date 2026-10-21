import type { AppContext } from '../context.js';

/** Global search within one project (tenant-scoped by the caller's project access). */
export async function globalSearch(ctx: AppContext, projectId: string, q: string) {
  const term = q.trim().slice(0, 100);
  if (term.length < 2) return { query: term, groups: [] };
  const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const run = <T>(sql: string) => ctx.db.query<T>(sql, [projectId, like]);
  const [pages, keywords, issues, recommendations, opportunities, changes, competitors, backlinks, reports] = await Promise.all([
    run<any>(`SELECT p.id, p.url, p.title FROM pages p JOIN websites w ON w.id = p.website_id WHERE w.project_id = $1 AND p.removed_at IS NULL AND (p.url ILIKE $2 OR p.title ILIKE $2) ORDER BY p.inlinks DESC LIMIT 6`),
    run<any>(`SELECT id, keyword, intent FROM keywords WHERE project_id = $1 AND keyword ILIKE $2 ORDER BY opportunity_score DESC LIMIT 6`),
    run<any>(`SELECT id, title, severity, url FROM seo_issues WHERE project_id = $1 AND status = 'open' AND (title ILIKE $2 OR url ILIKE $2 OR rule_id ILIKE $2) ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END LIMIT 6`),
    run<any>(`SELECT id, title, status, page_url FROM recommendations WHERE project_id = $1 AND (title ILIKE $2 OR page_url ILIKE $2) ORDER BY priority_score DESC LIMIT 6`),
    run<any>(`SELECT id, title, category, priority_score FROM opportunities WHERE project_id = $1 AND status = 'open' AND (title ILIKE $2 OR summary ILIKE $2) ORDER BY priority_score DESC LIMIT 6`),
    run<any>(`SELECT id, change_type, page_url, status FROM seo_changes WHERE project_id = $1 AND (page_url ILIKE $2 OR change_type ILIKE $2 OR new_value ILIKE $2) ORDER BY updated_at DESC LIMIT 6`),
    run<any>(`SELECT id, name, base_url FROM competitors WHERE project_id = $1 AND (name ILIKE $2 OR base_url ILIKE $2) LIMIT 6`),
    run<any>(`SELECT id, source_domain, source_url, status FROM backlinks WHERE project_id = $1 AND (source_domain ILIKE $2 OR source_url ILIKE $2) LIMIT 6`),
    run<any>(`SELECT id, title, type, created_at FROM reports WHERE project_id = $1 AND title ILIKE $2 ORDER BY created_at DESC LIMIT 6`),
  ]);
  const groups = [
    { type: 'pages', label: 'Pages', items: pages.map((r) => ({ id: r.id, title: r.title ?? r.url, subtitle: r.url, href: `/pages/${r.id}` })) },
    { type: 'keywords', label: 'Keywords', items: keywords.map((r) => ({ id: r.id, title: r.keyword, subtitle: r.intent ?? '', href: `/keywords?q=${encodeURIComponent(r.keyword)}` })) },
    { type: 'opportunities', label: 'Opportunities', items: opportunities.map((r) => ({ id: r.id, title: r.title, subtitle: `${r.category.replace('_', ' ')} · priority ${Math.round(r.priority_score)}`, href: `/opportunities?id=${r.id}` })) },
    { type: 'issues', label: 'Issues', items: issues.map((r) => ({ id: r.id, title: r.title, subtitle: `${r.severity}${r.url ? ` · ${r.url}` : ''}`, href: `/issues?q=${encodeURIComponent(r.title)}` })) },
    { type: 'recommendations', label: 'Recommendations', items: recommendations.map((r) => ({ id: r.id, title: r.title, subtitle: r.status, href: `/recommendations?id=${r.id}` })) },
    { type: 'changes', label: 'Changes', items: changes.map((r) => ({ id: r.id, title: `${r.change_type.replace('_', ' ')} · ${r.page_url ?? ''}`, subtitle: r.status, href: '/changes' })) },
    { type: 'competitors', label: 'Competitors', items: competitors.map((r) => ({ id: r.id, title: r.name, subtitle: r.base_url, href: '/competitors' })) },
    { type: 'backlinks', label: 'Backlinks', items: backlinks.map((r) => ({ id: r.id, title: r.source_domain, subtitle: `${r.status} · ${r.source_url}`, href: '/backlinks' })) },
    { type: 'reports', label: 'Reports', items: reports.map((r) => ({ id: r.id, title: r.title, subtitle: r.type, href: `/reports?id=${r.id}` })) },
  ].filter((g) => g.items.length);
  return { query: term, groups };
}
