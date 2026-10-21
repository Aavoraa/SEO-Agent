import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { bulkInsert } from '@phoenixx/database';
import { addDays, generateApiKey, hashPassword, isoDate, type CrawlOutput } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { createProject } from '../services/projects.js';
import { runCrawl } from '../services/crawl.js';
import { runKeywordDiscovery } from '../services/keywords.js';
import { runContentOpportunities } from '../services/content.js';
import { runInternalLinks } from '../services/optimization.js';
import { runLocalSeo } from '../services/local.js';
import { generateInitialReport, generateWeeklyReport } from '../services/reports.js';
import { raiseAlert } from '../services/alerts.js';
import { decideRecommendation } from '../services/recommendations.js';
import { recommendBrokenTargets } from '../services/backlinks.js';
import { ensureDemoSite } from './site.js';
import { seedDemoHeatmaps } from './heatmaps.js';
import { seedDemoRecordings } from './recordings.js';

/**
 * DEMO MODE SAMPLE DATA
 * ─────────────────────
 * • Runs only against the separate demo database (DEMO_DATABASE_URL) – never production.
 * • The crawl is a real snapshot of phoenixxit.com (structure only) captured 2026-09-28.
 * • Search Console / GA4 numbers are SYNTHETIC and deterministic. They are NOT Phoenixx IT's real
 *   performance and exist only so every screen can be explored before Google is connected.
 */

// Deterministic PRNG so the demo looks the same every time.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

const SITE = 'https://www.phoenixxit.com';
interface SampleQuery {
  q: string;
  page: string;
  imp: number; // daily impressions baseline
  pos: number;
  ctrMul?: number;
  trend?: number; // multiplier applied to the last 45 days
  alt?: string; // second page receiving impressions (cannibalisation)
}

const QUERIES: SampleQuery[] = [
  { q: 'phoenixx it', page: '/', imp: 9, pos: 1.2, ctrMul: 6 },
  { q: 'phoenixx it coimbatore', page: '/', imp: 4, pos: 1.1, ctrMul: 6 },
  { q: 'it company in coimbatore', page: '/', imp: 38, pos: 14.2, trend: 1.3 },
  { q: 'it companies in coimbatore', page: '/', imp: 31, pos: 16.8 },
  { q: 'best it company coimbatore', page: '/', imp: 12, pos: 18.5 },
  { q: 'software company in vadavalli', page: '/', imp: 6, pos: 6.4 },
  { q: 'software development company in coimbatore', page: '/', imp: 22, pos: 21.3 },
  { q: 'website design company in coimbatore', page: '/website-design-development', imp: 27, pos: 11.7, alt: '/' },
  { q: 'web design coimbatore', page: '/website-design-development', imp: 19, pos: 9.8, alt: '/' },
  { q: 'website development company coimbatore', page: '/website-design-development', imp: 15, pos: 12.4, trend: 1.4 },
  { q: 'digital marketing agency in coimbatore', page: '/digital-marketing', imp: 33, pos: 8.9, ctrMul: 0.5 },
  { q: 'digital marketing company coimbatore', page: '/digital-marketing', imp: 21, pos: 10.4 },
  { q: 'social media marketing coimbatore', page: '/digital-marketing', imp: 9, pos: 17.9 },
  { q: 'seo company in coimbatore', page: '/digital-marketing', imp: 24, pos: 23.5, trend: 1.2 },
  { q: 'seo services coimbatore', page: '/digital-marketing', imp: 14, pos: 27.1 },
  { q: 'app development company in coimbatore', page: '/app-development', imp: 18, pos: 7.6, ctrMul: 0.6 },
  { q: 'mobile app developers coimbatore', page: '/app-development', imp: 10, pos: 12.9 },
  { q: 'flutter app development company', page: '/app-development', imp: 6, pos: 34.0 },
  { q: 'business automation services', page: '/automation', imp: 7, pos: 19.3 },
  { q: 'workflow automation company india', page: '/automation', imp: 5, pos: 26.8 },
  { q: 'what is workflow automation', page: '/automation', imp: 11, pos: 31.5 },
  { q: 'performance marketing agency coimbatore', page: '/performance-marketing', imp: 8, pos: 6.1 },
  { q: 'google ads agency coimbatore', page: '/performance-marketing', imp: 12, pos: 13.8, trend: 0.45 },
  { q: 'lead generation company coimbatore', page: '/lead-generation', imp: 7, pos: 9.3 },
  { q: 'b2b lead generation services india', page: '/lead-generation', imp: 9, pos: 38.2 },
  { q: 'branding agency coimbatore', page: '/branding-pr', imp: 10, pos: 15.6, trend: 0.5 },
  { q: 'logo design coimbatore', page: '/branding-pr', imp: 8, pos: 29.4 },
  { q: 'business growth consultant coimbatore', page: '/growth-consulting', imp: 4, pos: 11.2 },
  { q: 'how much does a website cost in india', page: '/faq', imp: 14, pos: 24.6 },
  { q: 'how long does it take to build a mobile app', page: '/faq', imp: 8, pos: 33.1 },
  { q: 'website design chennai', page: '/website-design-development', imp: 11, pos: 47.0 },
  { q: 'digital marketing vs performance marketing', page: '/performance-marketing', imp: 6, pos: 18.7 },
  { q: 'it services tamil nadu', page: '/', imp: 7, pos: 22.9 },
];

// Share of clicks per position (rough, illustrative only).
const ctrAt = (pos: number) => (pos <= 1.5 ? 0.3 : pos <= 3 ? 0.15 : pos <= 5 ? 0.08 : pos <= 10 ? 0.035 : pos <= 20 ? 0.012 : 0.003);

export function sampleSearchConsoleRows(projectId: string, end: string, days = 180) {
  const r = rng(42);
  const rows: Record<string, unknown>[] = [];
  const totals = new Map<string, { clicks: number; imp: number; posW: number }>();
  for (let d = days - 1; d >= 0; d--) {
    const date = isoDate(addDays(end, -d));
    const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
    const seasonal = weekday === 0 || weekday === 6 ? 0.6 : 1.05;
    const recent = d < 45;
    for (const s of QUERIES) {
      const growth = recent && s.trend ? s.trend : 1;
      const imp = Math.max(0, Math.round(s.imp * seasonal * growth * (0.7 + r() * 0.6)));
      if (!imp) continue;
      const pos = Math.max(1, s.pos + (r() - 0.5) * 2.5 - (recent && (s.trend ?? 1) > 1 ? 2 : recent && (s.trend ?? 1) < 1 ? -3 : 0));
      const clicks = Math.min(imp, Math.round(imp * Math.min(0.6, ctrAt(pos) * (s.ctrMul ?? 1)) * (0.6 + r() * 0.8)));
      const split = s.alt ? 0.62 : 1;
      const parts: [string, number][] = s.alt ? [[s.page, split], [s.alt, 1 - split]] : [[s.page, 1]];
      for (const [page, share] of parts) {
        const pi = Math.round(imp * share);
        if (!pi) continue;
        const pc = Math.round(clicks * share);
        const pp = page === s.alt ? pos + 6 : pos;
        rows.push({ project_id: projectId, date, query: s.q, page: page === '/' ? `${SITE}/` : SITE + page, country: '', device: '', clicks: pc, impressions: pi, ctr: pi ? pc / pi : 0, position: Math.round(pp * 10) / 10 });
        const t = totals.get(date) ?? { clicks: 0, imp: 0, posW: 0 };
        t.clicks += pc;
        t.imp += pi;
        t.posW += pp * pi;
        totals.set(date, t);
      }
    }
  }
  // Site totals are larger than the sum of queries (anonymised queries), as in real GSC data.
  for (const [date, t] of totals) {
    const imp = Math.round(t.imp * 1.35);
    const clicks = Math.round(t.clicks * 1.2);
    rows.push({ project_id: projectId, date, query: '', page: '', country: '', device: '', clicks, impressions: imp, ctr: imp ? clicks / imp : 0, position: Math.round((t.posW / Math.max(1, t.imp)) * 10) / 10 });
  }
  return rows;
}

export function sampleAnalyticsRows(projectId: string, end: string, days = 90) {
  const r = rng(7);
  const pages = ['/', '/digital-marketing', '/website-design-development', '/app-development', '/automation', '/performance-marketing', '/lead-generation', '/faq'];
  const rows: Record<string, unknown>[] = [];
  for (let d = days - 1; d >= 0; d--) {
    const date = isoDate(addDays(end, -d));
    for (const p of pages) {
      for (const [channel, source, medium, base] of [
        ['Organic Search', 'google', 'organic', p === '/' ? 9 : 3],
        ['Direct', '(direct)', '(none)', p === '/' ? 6 : 1],
        ['Organic Social', 'instagram.com', 'referral', p === '/' ? 2 : 0.5],
      ] as const) {
        const sessions = Math.round(base * (0.5 + r()));
        if (!sessions) continue;
        const engaged = Math.round(sessions * (0.45 + r() * 0.3));
        rows.push({ project_id: projectId, date, landing_page: p === '/' ? `${SITE}/` : SITE + p, channel_group: channel, source, medium, sessions, users: Math.max(1, sessions - Math.round(r() * 2)), engaged_sessions: engaged, engagement_rate: engaged / sessions, conversions: r() < 0.05 ? 1 : 0 });
      }
    }
  }
  return rows;
}

/**
 * Sample backlinks on fictional .example sites (never fetched – origin 'demo' is skipped by verification).
 * Also added to existing demo databases, so upgrading doesn't require a re-seed.
 */
export async function seedDemoBacklinks(ctx: AppContext, pid: string) {
  const has = await ctx.db.one('SELECT 1 FROM backlinks WHERE project_id = $1 LIMIT 1', [pid]);
  if (has) return 0;
  // [source, target path, anchor, status, nofollow, target HTTP status, days since first seen]
  const links: [string, string, string, 'live' | 'lost' | 'unverified', boolean, number, number][] = [
    ['https://coimbatore-business-directory.example/it-services/phoenixx-it', '/', 'Phoenixx IT', 'live', false, 200, 410],
    ['https://startup-news.example/2026/05/coimbatore-agencies-to-watch', '/website-design-development', 'website design team', 'live', false, 200, 130],
    ['https://startup-news.example/2026/07/growth-playbook', '/growth-consulting', 'growth consulting', 'live', false, 200, 70],
    ['https://tn-tech-forum.example/threads/best-seo-agency', '/digital-marketing', 'Phoenixx', 'live', true, 200, 95],
    ['https://client-retail-store.example/about', '/', 'Website by Phoenixx IT', 'live', false, 200, 300],
    ['https://marketing-blog.example/lead-gen-tools', '/lead-generation', 'lead generation services', 'live', false, 200, 60],
    ['https://design-awards.example/2025/finalists', '/services/web-design.html', 'Phoenixx IT web design', 'live', false, 404, 240],
    ['https://old-partner.example/partners', '/services/web-design.html', 'our web partner', 'live', false, 404, 380],
    ['https://events-coimbatore.example/speakers', '/app-development', 'app development talk', 'lost', false, 200, 200],
    ['https://review-site.example/agencies/phoenixx-it', '/', 'Visit website', 'unverified', true, 0, 12],
  ];
  const now = Date.now();
  for (const [src, target, anchor, status, nofollow, tStatus, days] of links) {
    await ctx.db.query(
      `INSERT INTO backlinks(project_id, source_url, source_domain, target_url, anchor, nofollow, origin, status, first_seen_at, last_seen_at, last_checked_at, found_anchor, found_nofollow, lost_at, target_status, target_final_url)
       VALUES ($1,$2,$3,$4,$5,$6,'demo',$7,$8,$9,$10,$11,$12,$13,$14,$4) ON CONFLICT DO NOTHING`,
      [pid, src, new URL(src).hostname.replace(/^www\./, ''), SITE + target, anchor, nofollow, status, new Date(now - days * 864e5), new Date(now - (status === 'lost' ? 9 : 2) * 864e5), status === 'unverified' ? null : new Date(now - 2 * 864e5), status === 'live' ? anchor : null, status === 'live' ? nofollow : null, status === 'lost' ? new Date(now - 9 * 864e5) : null, tStatus || null],
    );
  }
  await recommendBrokenTargets(ctx, pid);
  await raiseAlert(ctx, pid, { severity: 'medium', type: 'backlinks_lost', title: '1 backlink(s) lost from 1 site(s) (sample)', message: 'Sample alert: the link from events-coimbatore.example is no longer on the page.', fingerprint: `backlinks:lost:${pid}` });
  return links.length;
}

/** Demo databases seeded before the site profile existed get it added to their latest crawl (AI Readiness page). */
export async function seedDemoSiteProfile(ctx: AppContext, pid: string) {
  const profile = loadSampleCrawl().site.profile;
  if (!profile) return false;
  const r = await ctx.db.query(
    `UPDATE crawl_runs SET site_checks = site_checks || jsonb_build_object('profile', $2::jsonb)
     WHERE id = (SELECT cr.id FROM crawl_runs cr JOIN websites w ON w.id = cr.website_id WHERE w.project_id = $1 AND cr.status = 'completed' ORDER BY cr.started_at DESC LIMIT 1)
       AND NOT (site_checks ? 'profile') RETURNING id`,
    [pid, profile],
  );
  return r.length > 0;
}

function loadSampleCrawl(): CrawlOutput {
  const candidates = [process.env.DEMO_CRAWL_FILE, path.resolve(process.cwd(), 'database/seed/phoenixx-crawl-sample.json'), path.resolve(process.cwd(), '../../database/seed/phoenixx-crawl-sample.json')].filter(Boolean) as string[];
  const file = candidates.find((c) => existsSync(c));
  if (!file) throw new Error('database/seed/phoenixx-crawl-sample.json not found');
  return JSON.parse(readFileSync(file, 'utf8'));
}

export async function seedDemo(ctx: AppContext, opts: { log?: (m: string) => void } = {}) {
  const log = opts.log ?? (() => undefined);
  if (!ctx.cfg.DEMO_MODE && process.env.NODE_ENV !== 'test') throw new Error('Refusing to seed demo data: DEMO_MODE is not enabled. Demo data must never be mixed with production data.');
  const existing = await ctx.db.one<{ id: string }>(`SELECT id FROM projects WHERE is_demo LIMIT 1`);
  if (existing) {
    log(`Demo project already exists (${existing.id}). Delete the demo database directory to re-seed.`);
    const added = await seedDemoBacklinks(ctx, existing.id);
    if (added) log(`Added ${added} sample backlinks`);
    if (await seedDemoSiteProfile(ctx, existing.id)) log('Added site profile (stack + AI crawler access) to the latest demo crawl');
    await ensureDemoSite(ctx, loadSampleCrawl(), log);
    const hm = await seedDemoHeatmaps(ctx, existing.id);
    if (hm) log(`Added ${hm} sample heatmap events`);
    const recs = await seedDemoRecordings(ctx, existing.id);
    if (recs) log(`Added ${recs} sample session recordings`);
    return { projectId: existing.id, created: false };
  }
  const demoUser = await ctx.db.one<{ id: string; email: string }>(`INSERT INTO users(email, name, password_hash, role) VALUES ('demo@phoenixxit.local', 'Demo Admin', $1, 'admin') ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id, email`, [hashPassword(generateApiKey())]);
  const project = await createProject(ctx, { name: 'Phoenixx IT (DEMO – sample data)', siteUrl: SITE + '/', isDemo: true });
  const pid = project.id;
  log(`Created demo project ${pid}`);

  const crawl = loadSampleCrawl();
  await ensureDemoSite(ctx, crawl, log);
  const end = isoDate(addDays(new Date(), -3));
  await bulkInsert(ctx.db, 'search_console_data', sampleSearchConsoleRows(pid, end), { chunkSize: 1000 });
  await bulkInsert(ctx.db, 'analytics_data', sampleAnalyticsRows(pid, isoDate(addDays(new Date(), -1))), { chunkSize: 1000 });
  await ctx.db.query(`INSERT INTO integrations(project_id, provider, status, config, connected_at, last_sync_at) VALUES ($1,'google_search_console','connected','{"sample":true}',now(),now()), ($1,'google_analytics','connected','{"sample":true}',now(),now())`, [pid]);
  log('Inserted synthetic Search Console + GA4 data');

  // A "previous" crawl a week ago with a slightly different state, so health trends exist.
  await runCrawl(ctx, pid, { trigger: 'demo-seed', aiSummary: false }, crawl);
  await ctx.db.query(`UPDATE crawl_runs SET started_at = now() - interval '7 days', finished_at = now() - interval '7 days', health_score = GREATEST(0, health_score - 4) WHERE id = (SELECT id FROM crawl_runs ORDER BY started_at LIMIT 1)`);
  const crawlRes = await runCrawl(ctx, pid, { trigger: 'demo-seed', aiSummary: true }, crawl);
  log(`Crawl analysed: health ${crawlRes.healthScore.score}/100`);

  const kw = await runKeywordDiscovery(ctx, pid, { useAi: true });
  log(`Keywords: ${kw.keywords}, clusters: ${kw.clusters}`);

  // Structural sample for one fictional competitor (clearly labelled).
  const comp = await ctx.db.one<{ id: string }>(`INSERT INTO competitors(project_id, name, base_url, notes, last_crawled_at) VALUES ($1, 'Sample Competitor (fictional)', 'https://competitor.example/', 'Fictional demo competitor – add real competitor URLs in Competitors.', now()) RETURNING id`, [pid]);
  const cpages: [string, string, string, string[], number, string[]][] = [
    ['/', 'IT Company in Coimbatore | Software, Web & Marketing', 'IT Company in Coimbatore', ['Software Development', 'Website Design', 'Digital Marketing', 'SEO Services'], 1400, ['Organization', 'LocalBusiness']],
    ['/seo-services-coimbatore', 'SEO Services in Coimbatore | Local SEO Experts', 'SEO Services in Coimbatore', ['Local SEO', 'Technical SEO', 'SEO Audit', 'FAQs'], 1900, ['Service', 'FAQPage']],
    ['/blog/website-cost-india', 'How Much Does a Website Cost in India?', 'Website Cost in India', ['Cost factors', 'Hosting', 'Maintenance'], 2300, ['Article']],
    ['/blog/app-development-timeline', 'How Long Does It Take to Build an App?', 'App Development Timeline', ['Discovery', 'Design', 'Development', 'Testing'], 2100, ['Article']],
    ['/case-studies', 'Case Studies | Client Projects', 'Our Work', ['E-commerce', 'Healthcare', 'Education'], 900, []],
    ['/about', 'About Us', 'About the Company', ['Team', 'Process'], 800, []],
    ['/software-development', 'Custom Software Development Company', 'Custom Software Development', ['ERP', 'CRM', 'SaaS'], 1600, ['Service']],
  ];
  for (const [p, title, h1, h2s, words, schema] of cpages) {
    await ctx.db.query(`INSERT INTO competitor_pages(competitor_id, url, status_code, title, h1, h2s, word_count, schema_types, services, locations) VALUES ($1,$2,200,$3,$4,$5,$6,$7,'{}','{}')`, [comp!.id, 'https://competitor.example' + p, title, h1, JSON.stringify(h2s), words, schema]);
  }

  await runContentOpportunities(ctx, pid, { useAi: true });
  await runInternalLinks(ctx, pid, { useAi: true });
  await runLocalSeo(ctx, pid, { useAi: true });
  await seedDemoBacklinks(ctx, pid);
  await seedDemoHeatmaps(ctx, pid);
  await seedDemoRecordings(ctx, pid);
  log('Content, internal-link, local SEO and backlink analysis complete');

  // Sample governance history: two approved changes (one verified + monitored), one rejected.
  const actor = { type: 'user' as const, id: demoUser!.id, label: demoUser!.email, role: 'admin' as const };
  const pending = await ctx.db.query<{ id: string; type: string }>(`SELECT id, type FROM recommendations WHERE project_id = $1 AND status IN ('pending_approval','recommended') AND proposed_value IS NOT NULL ORDER BY priority_score DESC LIMIT 3`, [pid]);
  const decided: string[] = [];
  for (const [i, rec] of pending.entries()) {
    const res = await decideRecommendation(ctx, pid, rec.id, actor, i === 2 ? { decision: 'reject', comment: 'Demo: rejected to show the audit trail' } : { decision: 'approve', comment: 'Demo approval', previewConfirmed: true });
    if (res.changeId) decided.push(res.changeId);
  }
  if (decided[0]) {
    await ctx.db.query(`UPDATE seo_changes SET status = 'monitoring', adapter = 'manual', implemented_at = now() - interval '12 days', verified_at = now() - interval '11 days', verification = '{"live":true,"sample":true}' WHERE id = $1`, [decided[0]]);
    await ctx.db.query(`INSERT INTO change_events(change_id, from_status, to_status, actor, note, created_at) VALUES ($1,'approved','implemented','demo','Sample: deployed by developer', now() - interval '12 days'), ($1,'implemented','verified','system','Sample: confirmed live', now() - interval '11 days'), ($1,'verified','monitoring','system','Sample: 28-day experiment started', now() - interval '11 days')`, [decided[0]]);
    const ch = await ctx.db.one<{ page_url: string; change_type: string }>('SELECT page_url, change_type FROM seo_changes WHERE id = $1', [decided[0]]);
    await ctx.db.query(`INSERT INTO experiments(project_id, change_id, page_url, name, hypothesis, primary_metric, monitor_days, start_date, baseline, status) VALUES ($1,$2,$3,$4,$5,'ctr',28,$6,$7,'running')`, [pid, decided[0], ch!.page_url ?? SITE + '/', `${ch!.change_type} change (sample)`, 'Sample experiment for demo purposes.', isoDate(addDays(new Date(), -11)), { clicks: 41, impressions: 3120, ctr: 0.0131, position: 12.4, sample: true }]);
  }
  await raiseAlert(ctx, pid, { severity: 'high', type: 'ranking_loss', title: 'Important page losing visibility: /branding-pr (sample)', message: 'Sample alert: average position 15.6 → 18.9 and clicks down 50% (7 days vs prior 7).', fingerprint: 'demo:ranking_loss' });
  await raiseAlert(ctx, pid, { severity: 'medium', type: 'content', title: 'New content opportunities detected (sample)', message: 'Sample alert: 4 keyword clusters have demand without a matching page.', fingerprint: 'demo:content' });

  await generateInitialReport(ctx, pid);
  await generateWeeklyReport(ctx, pid, { send: false });
  await ctx.db.query(`UPDATE projects SET onboarding = onboarding || '{"demo": true}'::jsonb WHERE id = $1`, [pid]);
  log('Reports generated. Demo ready.');
  return { projectId: pid, created: true };
}
