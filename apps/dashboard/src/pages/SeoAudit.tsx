import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Download, Eye, GitCompareArrows, Share2, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { api, download } from '../api/client';
import type { AuditComparison, AuditGroup, AuditReport } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtDateTime, fmtNum, fmtRelative, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Loading, Segmented } from '../components/ui';
import { Pill, PriorityBadge, SeverityBadge } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';
import { Modal } from '../components/Overlay';
import { CopyButton } from '../components/CodeBlock';
import { SingleLineChart } from '../components/charts';
import { DataTable, type Column } from '../components/DataTable';
import { DataLabel, IntegrationRequired } from '../components/DataLabel';
import { CategoryCard, CategoryRadar, ChecksList, GRADE_LABEL, gradeTone, RecommendationDrawer, ScoreRing, SitePreview, Trend } from '../components/AuditParts';

type Device = 'desktop' | 'mobile';

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-wide text-gray-500 uppercase">{label}</div>
      <div className="text-base font-semibold tabular text-gray-900">{value}</div>
      {hint && <div className="text-[11px] text-gray-500">{hint}</div>}
    </div>
  );
}

function Bar({ value, max = 5, tone = 'bg-brand-500' }: { value: number | null; max?: number; tone?: string }) {
  if (value === null) return <span className="text-xs text-gray-400">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-gray-100">
        <span className={cx('block h-full rounded-full', tone)} style={{ width: `${(value / max) * 100}%` }} />
      </span>
      <span className="text-[11px] tabular text-gray-500">{value}</span>
    </span>
  );
}

function CompareView({ from, to }: { from: string; to: string }) {
  const { data, error, loading } = useProjectApi<AuditComparison>('/audits/compare', { from, to });
  if (error) return <ErrorBox error={error} />;
  if (!data) return loading ? <Loading /> : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <span>
          {fmtDateTime(data.from.createdAt)} <strong>{data.from.overall}</strong> → {fmtDateTime(data.to.createdAt)} <strong>{data.to.overall}</strong>
        </span>
        <Trend value={data.scoreDelta} suffix=" pts" />
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {data.categories.map((c) => (
          <div key={c.id} className="rounded-md border border-gray-200 px-3 py-2">
            <div className="text-[11px] text-gray-500">{c.label}</div>
            <div className="text-sm font-semibold tabular">
              {c.before ?? '—'} → {c.after ?? '—'} <Trend value={c.delta} />
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h4 className="mb-1 text-xs font-semibold text-emerald-700">Resolved issues ({data.resolvedIssues.length})</h4>
          <ul className="max-h-60 space-y-1 overflow-auto text-xs">{data.resolvedIssues.map((i) => <li key={i.fingerprint} className="flex gap-2"><SeverityBadge severity={i.severity} /><span>{i.title}{i.url ? ` · ${pathOf(i.url)}` : ''}</span></li>)}</ul>
        </div>
        <div>
          <h4 className="mb-1 text-xs font-semibold text-red-700">New issues ({data.newIssues.length})</h4>
          <ul className="max-h-60 space-y-1 overflow-auto text-xs">{data.newIssues.map((i) => <li key={i.fingerprint} className="flex gap-2"><SeverityBadge severity={i.severity} /><span>{i.title}{i.url ? ` · ${pathOf(i.url)}` : ''}</span></li>)}</ul>
        </div>
      </div>
      <div className="grid gap-4 text-xs md:grid-cols-3">
        <div><strong>New pages:</strong> {data.newPages.length ? data.newPages.join(', ') : 'none'}</div>
        <div><strong>Removed pages:</strong> {data.removedPages.length ? <span className="text-red-700">{data.removedPages.join(', ')}</span> : 'none'}</div>
        <div><strong>Content / technical changes:</strong> {data.pageChanges.length}</div>
      </div>
      {data.pageChanges.length > 0 && (
        <ul className="max-h-72 divide-y divide-gray-100 overflow-auto rounded-md border border-gray-200 text-xs">
          {data.pageChanges.map((c, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)_100px_minmax(0,2fr)] gap-2 px-3 py-1.5">
              <span className="font-mono">{c.path}</span>
              <span className="text-gray-500">{humanize(c.field)}</span>
              <span className="min-w-0 break-words">
                <del className="bg-red-50 text-red-800">{String(c.before ?? '—')}</del> → <ins className="bg-emerald-50 text-emerald-900 no-underline">{String(c.after ?? '—')}</ins>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SECTION_ORDER = ['technical', 'onpage', 'content', 'performance', 'links', 'local', 'ai_search', 'structured_data', 'security', 'usability'] as const;

export function SeoAuditPage() {
  const { canEdit } = useAuth();
  const { base, project } = useProject();
  const { busy, run } = useAction();
  const [params, setParams] = useSearchParams();
  const device = (params.get('device') === 'mobile' ? 'mobile' : 'desktop') as Device;
  const auditId = params.get('audit') ?? undefined;
  const { data, error, loading, reload } = useProjectApi<AuditReport>('/audits', { device, auditId });
  const [drawer, setDrawer] = useState<{ group: AuditGroup; tab: 'pages' | 'all' } | null>(null);
  const [share, setShare] = useState<{ url: string; expiresAt: string } | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [showCompare, setShowCompare] = useState(false);

  const setDevice = (d: Device) => {
    const next = new URLSearchParams(params);
    next.set('device', d);
    next.delete('audit');
    setParams(next, { replace: true });
  };
  const openAudit = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('audit', id);
    setParams(next, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const a = data?.audit ?? null;
  const issuesOpen = a ? a.issuesBySeverity.critical + a.issuesBySeverity.high + a.issuesBySeverity.medium + a.issuesBySeverity.low : 0;
  const historyAsc = useMemo(() => [...(data?.history ?? [])].reverse().map((h) => ({ date: h.created_at.slice(0, 16).replace('T', ' '), score: h.overall_score })), [data]);
  const scrollTo = (id: string) => document.getElementById(`cat-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const recCols: Column<AuditGroup>[] = [
    { key: 'title', header: 'Recommendation', sort: (r) => r.title, render: (r) => <span className="font-medium text-gray-900">{r.title}</span> },
    { key: 'cat', header: 'Category', sort: (r) => r.category, render: (r) => <span className="text-xs">{humanize(r.category)}</span> },
    { key: 'priority', header: 'Priority', sort: (r) => ['critical', 'high', 'medium', 'low'].indexOf(r.priority ?? 'low'), render: (r) => (r.priority ? <PriorityBadge priority={r.priority} /> : <span className="text-xs text-gray-400">—</span>) },
    { key: 'sev', header: 'Severity', sort: (r) => ['critical', 'high', 'medium', 'low', 'info'].indexOf(r.severity), render: (r) => <SeverityBadge severity={r.severity} /> },
    { key: 'pages', header: 'Affected', align: 'right', sort: (r) => r.affected, render: (r) => <span className="tabular">{r.affected}</span> },
    { key: 'impact', header: 'Impact', sort: (r) => r.impact ?? 0, render: (r) => <Bar value={r.impact} /> },
    { key: 'effort', header: 'Effort', sort: (r) => r.effort ?? 9, render: (r) => <Bar value={r.effort} tone="bg-gray-400" /> },
    { key: 'conf', header: 'Confidence', render: (r) => <span className="text-xs">{r.confidence ? humanize(r.confidence) : '—'}</span> },
    { key: 'bv', header: 'Business value', sort: (r) => r.businessValue ?? 0, render: (r) => <Bar value={r.businessValue} tone="bg-violet-500" /> },
  ];

  return (
    <div>
      <PageHeader
        title="SEO Audit"
        description={
          <span className="inline-flex flex-wrap items-center gap-x-2">
            <strong className="text-gray-800">{project?.name}</strong>
            <a className="text-gray-500 hover:underline" href={data?.project.siteUrl} target="_blank" rel="noopener noreferrer">{data?.project.siteUrl}</a>
          </span>
        }
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Segmented options={[{ value: 'desktop', label: 'Desktop' }, { value: 'mobile', label: 'Mobile' }]} value={device} onChange={(v) => setDevice(v as Device)} label="Device" />
            <JobButton type="seo-audit" body={{ device }} label="Run new audit" variant="primary" onDone={() => { const n = new URLSearchParams(params); n.delete('audit'); setParams(n, { replace: true }); reload(); }} hideStatus />
            {a && canEdit && (
              <Button icon={<Share2 className="h-3.5 w-3.5" />} loading={busy === 'share'} onClick={() => run('share', () => api<{ url: string; expiresAt: string }>(`${base}/audits/${a.id}/share`, { method: 'POST' })).then((r) => r && setShare(r))}>
                Share report
              </Button>
            )}
            {a && (
              <Button icon={<Download className="h-3.5 w-3.5" />} loading={busy === 'pdf'} onClick={() => run('pdf', () => download(`${base}/audits/${a.id}/pdf`, 'seo-audit.pdf'))}>
                Download PDF
              </Button>
            )}
          </span>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && !a && (
        <Card>
          <EmptyState title={`No ${device} audit yet`} description="Run an audit to crawl the site and score it across 10 categories. Scores are calculated only from what the crawler finds." action={<JobButton type="seo-audit" body={{ device }} label="Run audit" variant="primary" onDone={reload} />} />
        </Card>
      )}
      {data && a && data.categories && (
        <div className="space-y-5">
          {auditId && (
            <div className="flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
              Viewing audit from {fmtDateTime(a.createdAt)}. Recommendations below always reflect the current open findings.
              <button className="ml-auto font-medium underline" onClick={() => { const n = new URLSearchParams(params); n.delete('audit'); setParams(n, { replace: true }); }}>Show latest</button>
            </div>
          )}

          {/* ── Header stats ── */}
          <div className="card grid grid-cols-2 gap-4 px-4 py-3 md:grid-cols-5">
            <Stat label="Last audited" value={fmtRelative(a.createdAt)} hint={fmtDateTime(a.createdAt)} />
            <Stat label="Pages crawled" value={fmtNum(a.pagesCrawled)} hint={humanize(a.device)} />
            <Stat label="Issues found" value={fmtNum(issuesOpen)} hint={`+ ${a.issuesBySeverity.info} info`} />
            <Stat label="Passed checks" value={`${fmtNum(a.checksPassed)} / ${fmtNum(a.checksTotal)}`} hint={`${Math.round((a.checksPassed / Math.max(1, a.checksTotal)) * 100)}%`} />
            <Stat label="Data" value={<DataLabel label={data.dataLabel ?? 'verified'} />} hint={a.createdBy ? `by ${a.createdBy}` : humanize(a.trigger)} />
          </div>

          {/* ── Overall score ── */}
          <div className="card flex flex-wrap items-center gap-6 px-5 py-5">
            <ScoreRing score={a.overall} />
            <div className="min-w-60 flex-1 space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-gray-900">{GRADE_LABEL[a.grade]}</h2>
                <Pill tone={gradeTone(a.grade)}>{a.overall}/100</Pill>
                {a.isDemo && <Pill tone="violet">DEMO MODE</Pill>}
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-600">
                {data.previous ? (
                  <>
                    <Trend value={data.previous.delta} suffix=" pts" /> since the previous {device} audit ({fmtRelative(data.previous.createdAt)})
                  </>
                ) : (
                  'First audit for this device – trends appear from the next one.'
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {(['critical', 'high', 'medium', 'low'] as const).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2 py-1 text-xs">
                    <SeverityBadge severity={s} /> <strong className="tabular">{a.issuesBySeverity[s]}</strong>
                  </span>
                ))}
              </div>
              <p className="text-[11px] text-gray-400">Internal diagnostic: the severity-weighted share of passed checks across the categories below. Not a Google metric and not a ranking prediction.</p>
            </div>
          </div>

          {/* ── Category scores ── */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            {data.categories.map((c) => <CategoryCard key={c.id} c={c} onOpen={() => scrollTo(c.id)} />)}
          </div>

          {/* ── Preview + radar ── */}
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card title="Website preview" subtitle="Rendered in an isolated sandbox">{data.preview && <SitePreview {...data.preview} />}</Card>
            <Card title="Health by category">
              <CategoryRadar categories={data.categories} />
            </Card>
          </div>

          {/* ── Quick wins ── */}
          <Card title="Quick wins" subtitle="Low-effort fixes with real impact, from the current open findings" bodyClassName="p-0">
            {!data.quickWins?.length ? (
              <p className="px-4 py-4 text-sm text-gray-500">No quick wins open – nice.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {data.quickWins.map((q) => (
                  <li key={q.ruleId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-60 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-900">{q.title}</span>
                        <SeverityBadge severity={q.severity} />
                        <Pill tone="gray">{humanize(q.category)}</Pill>
                      </div>
                      <div className="mt-0.5 text-xs text-gray-500">{q.action}</div>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-gray-600">
                      <span><strong className="tabular">{q.affected}</strong> page(s)</span>
                      <span className="flex items-center gap-1">Impact <Bar value={q.impact} /></span>
                      <span className="flex items-center gap-1">Effort <Bar value={q.effort} tone="bg-gray-400" /></span>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => setDrawer({ group: q, tab: 'pages' })}>View pages</Button>
                      {q.canFixWithAi && <Button size="sm" icon={<Wand2 className="h-3.5 w-3.5" />} onClick={() => setDrawer({ group: q, tab: 'pages' })}>Fix with AI</Button>}
                      <Button size="sm" variant="ghost" onClick={() => setDrawer({ group: q, tab: 'all' })}>View recommendation</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* ── Recommendations ── */}
          <Card title="Recommendations" subtitle="Grouped by finding · click a row for the explanation, affected pages, AI fix, preview and approval" bodyClassName="p-0">
            <DataTable className="rounded-none border-0" columns={recCols} rows={data.recommendations ?? []} rowKey={(r) => r.ruleId} onRowClick={(r) => setDrawer({ group: r, tab: 'all' })} maxHeight="560px" empty={<p className="p-4 text-sm text-gray-500">No open findings.</p>} />
          </Card>

          {/* ── Category sections ── */}
          {SECTION_ORDER.map((id) => {
            const cat = data.categories!.find((c) => c.id === id)!;
            const checks = (data.checks ?? []).filter((c) => c.category === id);
            const groups = (data.recommendations ?? []).filter((g) => g.category === id);
            return (
              <div key={id} id={`cat-${id}`} className="scroll-mt-20">
                <Card
                  title={
                    <span className="flex items-center gap-2">
                      {cat.label}
                      <Pill tone={gradeTone(cat.status)}>{cat.score ?? 'n/a'}</Pill>
                      <Trend value={cat.trend} />
                    </span>
                  }
                  subtitle={cat.note ?? `${cat.passed} of ${cat.checks} checks passed`}
                  bodyClassName="p-0"
                >
                  <ChecksList checks={checks} />
                  {groups.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 border-t border-gray-100 px-4 py-2.5">
                      {groups.map((g) => (
                        <button key={g.ruleId} onClick={() => setDrawer({ group: g, tab: 'all' })} className="rounded-md border border-gray-200 px-2 py-1 text-xs hover:border-gray-300">
                          {g.title} · {g.affected}
                        </button>
                      ))}
                    </div>
                  )}
                  {id === 'performance' && <div className="border-t border-gray-100 p-3"><IntegrationRequired what="Core Web Vitals (LCP, INP, CLS)" provider="the PageSpeed Insights integration" phase={2} /></div>}
                  {id === 'ai_search' && data.siteProfile && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 px-4 py-2.5 text-xs text-gray-600">
                      AI crawlers: {data.siteProfile.aiCrawlers.filter((c) => c.purpose !== 'training' && c.allowed).length}/{data.siteProfile.aiCrawlers.filter((c) => c.purpose !== 'training').length} search bots allowed ·
                      llms.txt {data.siteProfile.llmsTxt.found ? 'present' : 'absent (optional)'} · <Link to="/ai-readiness" className="font-medium text-brand-700 hover:underline">AI Readiness</Link>
                      <span className="ml-auto"><IntegrationRequired what="AI mentions & citations" provider="the AI answer-engine integration" phase={5} /></span>
                    </div>
                  )}
                </Card>
              </div>
            );
          })}

          {/* ── Migration / change protection ── */}
          <Card title={<span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-gray-500" /> Migration &amp; change protection</span>}>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="text-sm">
                <div className="text-xs font-medium text-gray-500">Pre-migration baseline</div>
                {data.protection?.baseline ? (
                  <span>{data.protection.baseline.label} · {data.protection.baseline.page_count} URLs · {fmtRelative(data.protection.baseline.created_at)}</span>
                ) : (
                  <span className="text-amber-700">No baseline yet – capture one before the redesign.</span>
                )}
                <div><Link to="/migration" className="text-xs font-medium text-brand-700 hover:underline">Migration monitor →</Link></div>
              </div>
              <div className="text-sm">
                <div className="text-xs font-medium text-gray-500">Last comparison</div>
                {data.protection?.lastComparison ? <span>{data.protection.lastComparison.summary}</span> : <span className="text-gray-500">None yet</span>}
              </div>
              <div className="text-sm">
                <div className="text-xs font-medium text-gray-500">Website changes</div>
                <span>
                  {data.protection?.changes.verified ?? 0} verified · {data.protection?.changes.awaiting ?? 0} awaiting deployment · <span className={data.protection?.changes.failing ? 'text-red-700' : ''}>{data.protection?.changes.failing ?? 0} failing</span> · {data.protection?.changes.rolled_back ?? 0} rolled back
                </span>
                <div><Link to="/changes" className="text-xs font-medium text-brand-700 hover:underline">Changes →</Link></div>
              </div>
            </div>
          </Card>

          {/* ── Audit history ── */}
          <Card
            title="Audit history"
            subtitle={`${data.history.length} ${device} audit(s) · select two to compare`}
            actions={
              <Button size="sm" icon={<GitCompareArrows className="h-3.5 w-3.5" />} disabled={compare.length !== 2} onClick={() => setShowCompare(true)}>
                Compare audits
              </Button>
            }
            bodyClassName="p-0"
          >
            {historyAsc.length > 1 && <div className="px-4 pt-3"><SingleLineChart data={historyAsc} dataKey="score" name="Score" height={160} domain={[0, 100]} /></div>}
            <ul className="divide-y divide-gray-100">
              {data.history.map((h, i) => (
                <li key={h.id} className={cx('flex items-center gap-3 px-4 py-2 text-sm', h.id === a.id && 'bg-brand-50/40')}>
                  <input type="checkbox" aria-label="Select for comparison" checked={compare.includes(h.id)} onChange={(e) => setCompare((c) => (e.target.checked ? [...c, h.id].slice(-2) : c.filter((x) => x !== h.id)))} />
                  <span className="w-20 text-xs text-gray-500">Audit #{data.history.length - i}</span>
                  <strong className="w-10 tabular">{h.overall_score}</strong>
                  <Pill tone={gradeTone(h.grade)}>{GRADE_LABEL[h.grade] ?? h.grade}</Pill>
                  <span className="text-xs text-gray-500">{fmtDateTime(h.created_at)} · {humanize(h.trigger)} · {h.pages_crawled} URLs</span>
                  {h.is_demo && <Pill tone="violet">DEMO</Pill>}
                  <button className="ml-auto text-xs font-medium text-brand-700 hover:underline" onClick={() => openAudit(h.id)}>Open</button>
                </li>
              ))}
            </ul>
          </Card>
          <p className="flex items-center gap-1 text-[11px] text-gray-400"><Sparkles className="h-3 w-3" /> AI is used only to explain findings and draft copy from the recorded evidence; every score and metric comes from the crawler or connected Google data.</p>
        </div>
      )}

      <RecommendationDrawer group={drawer?.group ?? null} tab={drawer?.tab} onClose={() => setDrawer(null)} onChanged={reload} />

      <Modal open={!!share} onClose={() => setShare(null)} title="Share report" footer={<Button variant="primary" onClick={() => setShare(null)}>Done</Button>}>
        {share && (
          <div className="space-y-2 text-sm">
            <p>Anyone with this link can open the PDF report until {fmtDateTime(share.expiresAt)}. It contains no credentials and can't change anything.</p>
            <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-gray-50 px-2 py-1.5 font-mono text-xs break-all">{share.url}</div>
            <CopyButton text={share.url} label="Copy link" />
          </div>
        )}
      </Modal>
      <Modal open={showCompare && compare.length === 2} onClose={() => setShowCompare(false)} title="Compare audits" width="max-w-4xl">
        {compare.length === 2 && (() => {
          const [x, y] = [...compare].sort((p, q) => (data?.history.findIndex((h) => h.id === q) ?? 0) - (data?.history.findIndex((h) => h.id === p) ?? 0));
          return <CompareView from={x!} to={y!} />;
        })()}
      </Modal>
    </div>
  );
}
