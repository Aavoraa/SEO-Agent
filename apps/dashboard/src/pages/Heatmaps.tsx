import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Flame, MousePointerClick, RefreshCw, ScrollText } from 'lucide-react';
import { api } from '../api/client';
import type { DataLabelValue } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtDateTime, fmtNum, fmtRelative } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Field, Loading, Segmented, Stat } from '../components/ui';
import { Pill } from '../components/Badges';
import { DataLabel } from '../components/DataLabel';
import { EmptyState } from '../components/EmptyState';
import { CopyButton } from '../components/CodeBlock';
import { HeatmapViewer, type HeatPoint, type ScrollReach, type ViewDevice } from '../components/HeatmapViewer';

const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);

interface ClarityPage { url: string; path: string; sessions: number | null; scrollDepth: number | null; engagementSec: number | null; deadClicks: number | null; rageClicks: number | null; quickbacks: number | null; excessiveScroll: number | null; scriptErrors: number | null; errorClicks: number | null }
interface ClarityStatus { connected: boolean; status: string; clarityProjectId: string | null; lastSyncAt: string | null; lastError: string | null; callsLast24h: number; dailyLimit: number; dashboardUrl: string | null }
interface Setup { siteKey: string; snippet: string; isDemo: boolean; lastEventAt: string | null; liveViews7d: number; retentionDays: number; clarity: ClarityStatus }
interface PagesResponse {
  siteUrl: string;
  dataLabel: DataLabelValue;
  items: { path: string; title: string | null; views: number; clicks: number; avgScrollDepth: number | null; rageClicks: number; deadClicks: number }[];
  clarity: { fetchedAt: string; numDays: number; pages: ClarityPage[] } | null;
}
interface HeatmapResponse {
  path: string;
  title: string | null;
  dataLabel: DataLabelValue;
  totals: { views: number; clicks: number; rageClicks: number; deadClicks: number; avgScrollDepth: number | null; avgFold: number | null };
  points: HeatPoint[];
  elements: { selector: string | null; label: string | null; clicks: number; share: number; rageClicks: number; deadClicks: number }[];
  scroll: ScrollReach[];
}

const DAY_OPTIONS = [
  { value: 1, label: 'Last day' },
  { value: 3, label: 'Last 3 days' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
];
const DEVICE_OPTIONS: { value: ViewDevice; label: string }[] = [
  { value: 'all', label: 'All devices' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'mobile', label: 'Mobile' },
];

function toPath(input: string, siteUrl?: string) {
  const v = input.trim();
  if (!v) return '';
  try {
    const u = new URL(v, siteUrl ?? 'https://example.com');
    return u.pathname || '/';
  } catch {
    return v.startsWith('/') ? v : `/${v}`;
  }
}

export function HeatmapsPage() {
  const [params, setParams] = useSearchParams();
  const path = params.get('path');
  const days = Number(params.get('days') ?? 3) || 3;
  const device = (params.get('device') as ViewDevice | null) ?? 'all';
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null ? next.delete(k) : next.set(k, v));
    setParams(next);
  };
  const filters = (
    <div className="flex flex-wrap items-center gap-2">
      <Segmented label="Device" value={device} onChange={(v) => set({ device: v === 'all' ? null : v })} options={DEVICE_OPTIONS} />
      <Segmented label="Date range" value={days} onChange={(v) => set({ days: String(v) })} options={DAY_OPTIONS} />
    </div>
  );
  return path ? <HeatmapDetail path={path} days={days} device={device} filters={filters} onBack={() => set({ path: null, mode: null })} mode={params.get('mode') === 'scroll' ? 'scroll' : 'click'} setMode={(m) => set({ mode: m === 'click' ? null : m })} /> : <HeatmapList days={days} device={device} filters={filters} open={(p) => set({ path: p })} />;
}

/* ── list: "Enter a URL" + popular pages (like Clarity's heatmaps home) ── */

function HeatmapList({ days, device, filters, open }: { days: number; device: ViewDevice; filters: React.ReactNode; open: (path: string) => void }) {
  const pages = useProjectApi<PagesResponse>('/heatmaps/pages', { days, device });
  const setup = useProjectApi<Setup>('/heatmaps/setup');
  const [url, setUrl] = useState('');
  if (pages.error) return <ErrorBox error={pages.error} onRetry={pages.reload} />;
  if (!pages.data || !setup.data) return <Loading />;
  const site = pages.data.siteUrl.replace(/\/$/, '');
  return (
    <div>
      <PageHeader title="Heatmaps" description="Where visitors click and how far they scroll, drawn over the page. First-party tracking plus Microsoft Clarity page insights." actions={filters} />
      <div className="space-y-5">
        <Card>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const p = toPath(url, pages.data!.siteUrl);
              if (p) open(p);
            }}
          >
            <Field label="Enter a URL" className="min-w-[280px] flex-1">
              <input className="input w-full" placeholder={`${site}/services  or  /services`} value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Button type="submit" variant="primary" icon={<Flame className="h-4 w-4" />} disabled={!url.trim()}>
              View heatmap
            </Button>
          </form>
        </Card>

        <Card
          title={<span className="flex items-center gap-2">Popular pages <DataLabel label={pages.data.dataLabel} /></span>}
          subtitle={`Based on the selected filters · ${DAY_OPTIONS.find((d) => d.value === days)?.label.toLowerCase() ?? `${days} days`}${device !== 'all' ? ` · ${device}` : ''}`}
          bodyClassName="p-0"
        >
          {pages.data.items.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold text-gray-600">
                  <tr>
                    <th className="w-10 px-4 py-2">#</th>
                    <th className="px-2 py-2">Page title</th>
                    <th className="px-2 py-2">URL</th>
                    <th className="px-2 py-2 text-right">Page views</th>
                    <th className="px-2 py-2 text-right">Clicks</th>
                    <th className="px-2 py-2 text-right">Avg. scroll</th>
                    <th className="px-2 py-2 text-right">Rage / dead</th>
                    <th className="w-12 px-4 py-2" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pages.data.items.map((p, i) => (
                    <tr key={p.path} className="cursor-pointer hover:bg-brand-50/40" onClick={() => open(p.path)}>
                      <td className="px-4 py-2.5 text-gray-500">{i + 1}</td>
                      <td className="max-w-[320px] truncate px-2 py-2.5 text-gray-900">{p.title ?? '—'}</td>
                      <td className="max-w-[320px] truncate px-2 py-2.5 text-gray-700">{site}{p.path}</td>
                      <td className="px-2 py-2.5 text-right font-medium tabular-nums">{fmtNum(p.views)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{fmtNum(p.clicks)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums">{p.avgScrollDepth == null ? '—' : pct(p.avgScrollDepth)}</td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-gray-600">{p.rageClicks} / {p.deadClicks}</td>
                      <td className="px-4 py-2.5 text-right">
                        <Flame className="inline h-4 w-4 text-gray-800" aria-label="View heatmap" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState compact title="No heatmap data yet" description="Add the tracking code below to the website. Pages appear here as soon as visitors load them." />
          )}
        </Card>

        <ClarityCard setup={setup.data} clarity={pages.data.clarity} site={site} open={open} reload={() => { setup.reload(); pages.reload(); }} />
        <TrackingCard setup={setup.data} />
      </div>
    </div>
  );
}

function ClarityCard({ setup, clarity, site, open, reload }: { setup: Setup; clarity: PagesResponse['clarity']; site: string; open: (p: string) => void; reload: () => void }) {
  const { base } = useProject();
  const { isAdmin, canEdit } = useAuth();
  const { busy, run } = useAction();
  const c = setup.clarity;
  const [form, setForm] = useState({ clarityProjectId: c.clarityProjectId ?? '', apiToken: '' });
  const [editing, setEditing] = useState(!c.connected);
  const save = () =>
    run('save', () => api(`${base}/heatmaps/clarity`, { method: 'PUT', body: { clarityProjectId: form.clarityProjectId.trim(), ...(form.apiToken.trim() ? { apiToken: form.apiToken.trim() } : {}) } }), 'Clarity settings saved').then((r) => {
      if (r) {
        setEditing(false);
        setForm((f) => ({ ...f, apiToken: '' }));
        reload();
      }
    });
  const sync = () => run('sync', () => api<{ pages: number }>(`${base}/heatmaps/clarity/sync`, { body: { numOfDays: 3 } }), (r) => `Clarity: ${r.pages} page(s) fetched`).then((r) => r && reload());
  return (
    <Card
      title={<span className="flex items-center gap-2">Microsoft Clarity {c.connected && <Pill tone={c.status === 'error' ? 'red' : 'green'}>{c.status === 'error' ? 'Error' : 'Connected'}</Pill>}</span>}
      subtitle="Page-level insights from the Clarity Data Export API: sessions, scroll depth, dead, rage and quick-back clicks. Clarity's own heatmap images are not available through its API. Open them in Clarity."
      actions={
        <div className="flex gap-2">
          {c.dashboardUrl && (
            <a className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50" href={c.dashboardUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="h-4 w-4" /> Open Clarity heatmaps
            </a>
          )}
          {c.connected && canEdit && (
            <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={busy === 'sync'} disabled={c.callsLast24h >= c.dailyLimit} onClick={sync} title={`${c.callsLast24h}/${c.dailyLimit} Clarity API calls used in the last 24 h`}>
              Refresh from Clarity
            </Button>
          )}
        </div>
      }
      bodyClassName="p-0"
    >
      {c.lastError && <div className="border-b border-red-100 bg-red-50 px-4 py-2 text-sm text-red-800">{c.lastError}</div>}
      {clarity?.pages.length ? (
        <div className="overflow-x-auto">
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-4 py-2 text-xs text-gray-500">
            <DataLabel label="verified" /> Last {clarity.numDays} day(s) · fetched {fmtRelative(clarity.fetchedAt)} · {c.callsLast24h}/{c.dailyLimit} API calls used today
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-left text-xs font-semibold text-gray-600">
              <tr>
                <th className="px-4 py-2">URL</th>
                <th className="px-2 py-2 text-right">Sessions</th>
                <th className="px-2 py-2 text-right">Scroll depth</th>
                <th className="px-2 py-2 text-right">Dead clicks</th>
                <th className="px-2 py-2 text-right">Rage clicks</th>
                <th className="px-2 py-2 text-right">Quick-backs</th>
                <th className="px-2 py-2 text-right">Active time</th>
                <th className="w-12 px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {clarity.pages.slice(0, 50).map((p) => (
                <tr key={p.url} className="hover:bg-gray-50">
                  <td className="max-w-[420px] truncate px-4 py-2 text-gray-800" title={p.url}>{p.url}</td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">{fmtNum(p.sessions)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{p.scrollDepth == null ? '—' : `${Math.round(p.scrollDepth)}%`}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtNum(p.deadClicks)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtNum(p.rageClicks)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{fmtNum(p.quickbacks)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{p.engagementSec == null ? '—' : `${Math.round(p.engagementSec)} s`}</td>
                  <td className="px-4 py-2 text-right">
                    {p.url.startsWith(site) || p.path.startsWith('/') ? (
                      <button onClick={() => open(p.path.split('#')[0] || '/')} title="Our heatmap for this page">
                        <Flame className="h-4 w-4 text-gray-700" />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : c.connected && !editing ? (
        <div className="px-4 py-4 text-sm text-gray-600">Connected to Clarity project <code>{c.clarityProjectId}</code>. Click <b>Refresh from Clarity</b> to load page insights (Clarity allows {c.dailyLimit} calls a day and the last 1–3 days).</div>
      ) : null}
      {isAdmin && (editing || !c.connected) ? (
        <form
          className="grid gap-3 border-t border-gray-100 px-4 py-4 md:grid-cols-[220px_1fr_auto] md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <Field label="Clarity project ID" hint="From the Clarity URL: …/projects/view/<id>/">
            <input className="input w-full" required placeholder="yj3dehirsu" value={form.clarityProjectId} onChange={(e) => setForm({ ...form, clarityProjectId: e.target.value })} />
          </Field>
          <Field label="Data Export API token" hint={c.connected ? 'Leave empty to keep the saved token. Stored encrypted, never shown again.' : 'Clarity → Settings → Data Export → Generate new API token. Stored encrypted.'}>
            <input className="input w-full" type="password" autoComplete="off" placeholder={c.connected ? '•••••••• (saved)' : 'eyJhbGciOi…'} value={form.apiToken} onChange={(e) => setForm({ ...form, apiToken: e.target.value })} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" loading={busy === 'save'}>Save</Button>
            {c.connected && <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
          </div>
        </form>
      ) : isAdmin && c.connected ? (
        <div className="flex gap-2 border-t border-gray-100 px-4 py-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Change settings</Button>
          <Button size="sm" variant="ghost" loading={busy === 'disconnect'} onClick={() => run('disconnect', () => api(`${base}/heatmaps/clarity`, { method: 'DELETE' }), 'Clarity disconnected').then((r) => r && reload())}>Disconnect</Button>
        </div>
      ) : !c.connected ? (
        <div className="px-4 py-3 text-sm text-gray-500">An admin can connect Clarity here.</div>
      ) : null}
    </Card>
  );
}

function TrackingCard({ setup }: { setup: Setup }) {
  return (
    <Card title="Tracking code" subtitle="Add once before </body> on every page, or deploy it as an approved change. No cookies, no form values or IP addresses; Do Not Track and Global Privacy Control are respected.">
      <div className="space-y-3 text-sm">
        <div className="flex items-start gap-2">
          <code className="block flex-1 overflow-x-auto rounded bg-gray-900 px-3 py-2 text-xs whitespace-nowrap text-gray-100">{setup.snippet}</code>
          <CopyButton text={setup.snippet} />
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-gray-600">
          <span>Status: {setup.liveViews7d > 0 ? <Pill tone="green">Receiving data</Pill> : <Pill tone="gray">No live data yet</Pill>}</span>
          <span>Last event: {setup.lastEventAt ? fmtDateTime(setup.lastEventAt) : '—'}</span>
          <span>Page views (7 days, live): {fmtNum(setup.liveViews7d)}</span>
          <span>Retention: {setup.retentionDays} days</span>
        </div>
        {setup.isDemo && (
          <div className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-violet-900">
            Demo: the sample heatmap data is labelled <b>Demo</b>. The tracker is already on the local demo copy of the site. Open{' '}
            <a className="font-medium underline" href="http://127.0.0.1:4001/" target="_blank" rel="noreferrer">http://127.0.0.1:4001/</a>, click and scroll around, then reload this page to see your own clicks. The demo copy has the real site's Clarity/Google tags removed so it doesn't add visits to your real analytics.
          </div>
        )}
      </div>
    </Card>
  );
}

/* ── one page: click map / scroll map ── */

function HeatmapDetail({ path, days, device, filters, onBack, mode, setMode }: { path: string; days: number; device: ViewDevice; filters: React.ReactNode; onBack: () => void; mode: 'click' | 'scroll'; setMode: (m: 'click' | 'scroll') => void }) {
  const data = useProjectApi<HeatmapResponse>('/heatmaps', { path, days, device });
  const snap = useProjectApi<{ html: string; url: string; fetchedAt: string }>('/heatmaps/snapshot', { path });
  const setup = useProjectApi<Setup>('/heatmaps/setup');
  const [match, setMatch] = useState<number | null>(null);
  const onMatchRate = useCallback((r: number) => setMatch(r), []);
  const t = data.data?.totals;
  const reachRows = useMemo(() => (data.data?.scroll ?? []).filter((_, i) => i % 2 === 0), [data.data]);
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <button onClick={onBack} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Back to pages">
              <ArrowLeft className="h-5 w-5" />
            </button>
            Heatmap
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-gray-900">{data.data?.title ?? path}</span>
            {snap.data && (
              <a className="inline-flex items-center gap-1 text-brand-700 hover:underline" href={snap.data.url} target="_blank" rel="noreferrer">
                {snap.data.url} <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {data.data && <DataLabel label={data.data.dataLabel} />}
          </span>
        }
        actions={filters}
      />
      {data.error && <ErrorBox error={data.error} onRetry={data.reload} />}
      {t && (
        <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Page views" value={fmtNum(t.views)} />
          <Stat label="Clicks" value={fmtNum(t.clicks)} />
          <Stat label="Avg. scroll depth" value={t.avgScrollDepth == null ? '—' : pct(t.avgScrollDepth)} />
          <Stat label="Average fold" value={t.avgFold == null ? '—' : pct(t.avgFold)} hint="share of the page visible without scrolling" />
          <Stat label="Rage clicks" value={fmtNum(t.rageClicks)} hint="3+ rapid clicks on one spot" />
          <Stat label="Dead clicks" value={fmtNum(t.deadClicks)} hint="clicks with no reaction" />
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <Card
          className="min-w-0"
          bodyClassName="p-3"
          title={
            <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5">
              {(['click', 'scroll'] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={cx('flex h-7 items-center gap-1.5 rounded px-3 text-sm font-medium', mode === m ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}>
                  {m === 'click' ? <MousePointerClick className="h-4 w-4" /> : <ScrollText className="h-4 w-4" />}
                  {m === 'click' ? 'Click map' : 'Scroll map'}
                </button>
              ))}
            </div>
          }
          actions={
            setup.data?.clarity.dashboardUrl ? (
              <a className="inline-flex items-center gap-1 text-sm text-brand-700 hover:underline" href={setup.data.clarity.dashboardUrl} target="_blank" rel="noreferrer">
                Compare in Clarity <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : null
          }
        >
          {snap.error ? (
            <ErrorBox error={snap.error} onRetry={snap.reload} />
          ) : !snap.data || !data.data ? (
            <Loading label="Loading page snapshot…" />
          ) : (
            <>
              <HeatmapViewer html={snap.data.html} mode={mode} points={data.data.points} scroll={data.data.scroll} fold={t?.avgFold ?? null} device={device} onMatchRate={onMatchRate} />
              <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-gray-500">
                <span>
                  Page snapshot {fmtRelative(snap.data.fetchedAt)} (scripts disabled). Scroll inside the page to see the whole map.
                  {mode === 'click' && match != null && data.data.points.length > 0 && match < 0.8 && ` ${Math.round((1 - match) * 100)}% of click spots are placed by page position because the element has changed since.`}
                </span>
                <span className="flex items-center gap-1">
                  fewer <span className="h-2 w-24 rounded" style={{ background: 'linear-gradient(90deg,#0000ff,#00c8ff,#00e63c,#ffe600,#ff1400)' }} /> more
                </span>
              </div>
              {!data.data.totals.views && <div className="mt-3"><EmptyState compact title="No visits recorded for this page in this period" description="Try a longer date range or another device, or check that the tracking code is on this page." /></div>}
            </>
          )}
        </Card>

        {mode === 'click' ? (
          <Card title="Top clicked elements" bodyClassName="p-0">
            <ol className="max-h-[70vh] divide-y divide-gray-100 overflow-auto">
              {(data.data?.elements ?? []).map((e, i) => (
                <li key={`${e.selector}-${i}`} className="px-4 py-2 text-sm">
                  <div className="flex items-baseline gap-2">
                    <span className="w-5 shrink-0 text-xs text-gray-400">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-gray-900" title={e.selector ?? ''}>{e.label ?? shortSelector(e.selector)}</span>
                    <span className="tabular-nums text-gray-700">{fmtNum(e.clicks)}</span>
                    <span className="w-12 text-right text-xs tabular-nums text-gray-500">{pct(e.share)}</span>
                  </div>
                  {(e.rageClicks > 0 || e.deadClicks > 0) && (
                    <div className="mt-1 flex gap-1 pl-7">
                      {e.rageClicks > 0 && <Pill tone="red">{e.rageClicks} rage</Pill>}
                      {e.deadClicks > 0 && <Pill tone="amber">{e.deadClicks} dead</Pill>}
                    </div>
                  )}
                </li>
              ))}
              {!data.data?.elements.length && <li className="px-4 py-3 text-sm text-gray-500">No clicks in this period.</li>}
            </ol>
          </Card>
        ) : (
          <Card title="Scroll reach" subtitle="Share of page views that reached each depth" bodyClassName="p-0">
            <ul className="divide-y divide-gray-100 text-sm">
              {reachRows.map((r) => (
                <li key={r.depth} className="flex items-center gap-3 px-4 py-1.5">
                  <span className="w-12 text-gray-500 tabular-nums">{Math.round(r.depth * 100)}%</span>
                  <span className="h-2 flex-1 overflow-hidden rounded bg-gray-100">
                    <span className="block h-full rounded bg-brand-600" style={{ width: `${r.reach * 100}%` }} />
                  </span>
                  <span className="w-12 text-right tabular-nums text-gray-800">{pct(r.reach)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
      <p className="mt-4 text-xs text-gray-500">
        <Link to={`/recordings?page=${encodeURIComponent(path)}`} className="text-brand-700 hover:underline">Watch recordings of this page</Link> · <Link to="/pages" className="text-brand-700 hover:underline">SEO data for this page</Link> ·Heatmaps show how people use the page. Use them with the audit to decide what to change.
      </p>
    </div>
  );
}

function shortSelector(s: string | null) {
  if (!s) return '(unknown element)';
  const last = s.split('>').pop() ?? s;
  return last.replace(/:nth-of-type\(\d+\)/g, '');
}
