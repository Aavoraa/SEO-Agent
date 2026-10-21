import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertOctagon, ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, FileText, Flame, Monitor, MousePointerClick, Play, Smartphone, Star, Tablet, Trash2, Zap } from 'lucide-react';
import { api } from '../api/client';
import type { DataLabelValue } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtDateTime, fmtNum, fmtRelative } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Field, Loading, Segmented, Stat, Toggle } from '../components/ui';
import { Pill } from '../components/Badges';
import { DataLabel } from '../components/DataLabel';
import { EmptyState } from '../components/EmptyState';
import { MARKER_COLORS, RecordingPlayer, type PlayerHandle, type RrEvent } from '../components/RecordingPlayer';

type Device = 'desktop' | 'tablet' | 'mobile';
interface RecordingRow {
  id: string;
  started_at: string;
  ended_at: string;
  duration_ms: number;
  device: Device;
  browser: string | null;
  os: string | null;
  country: string | null;
  viewport_w: number | null;
  viewport_h: number | null;
  entry_path: string;
  exit_path: string;
  pages: { v: string; path: string; title: string | null; ts: number }[];
  page_count: number;
  click_count: number;
  rage_clicks: number;
  dead_clicks: number;
  error_count: number;
  event_count: number;
  bytes: number;
  is_demo: boolean;
  favorite: boolean;
  viewed_at: string | null;
}
interface ListResponse {
  items: RecordingRow[];
  total: number;
  summary: { sessions: number; avgDurationMs: number | null; withRageClicks: number; withDeadClicks: number; withErrors: number };
  dataLabel: DataLabelValue;
}
interface Settings { enabled: boolean; sampleRate: number; masking: 'balanced' | 'strict'; retentionDays: number; maxMbPerSession: number; clarityRecordingsUrl: string | null }

const DAY_OPTIONS = [
  { value: 1, label: 'Last day' },
  { value: 3, label: 'Last 3 days' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
];
const DEVICE_OPTIONS: { value: Device | 'all'; label: string }[] = [
  { value: 'all', label: 'All devices' },
  { value: 'desktop', label: 'Desktop' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'mobile', label: 'Mobile' },
];
const FLAGS = [
  { key: 'rage', label: 'Rage clicks' },
  { key: 'dead', label: 'Dead clicks' },
  { key: 'errors', label: 'JS errors' },
  { key: 'favorites', label: 'Favorites' },
  { key: 'unviewed', label: 'Not viewed' },
] as const;
const FILTER_KEYS = ['days', 'device', 'minDurationSec', 'page', 'sort', ...FLAGS.map((f) => f.key)];

export const fmtDuration = (ms: number | null | undefined) => {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const DeviceIcon = ({ d, className = 'h-4 w-4' }: { d: Device; className?: string }) => (d === 'mobile' ? <Smartphone className={className} /> : d === 'tablet' ? <Tablet className={className} /> : <Monitor className={className} />);

export function RecordingsPage() {
  const [params, setParams] = useSearchParams();
  const id = params.get('id');
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? next.delete(k) : next.set(k, v));
    setParams(next);
  };
  const filters = Object.fromEntries(FILTER_KEYS.filter((k) => params.get(k)).map((k) => [k, params.get(k)!]));
  return id ? <RecordingDetail id={id} filters={filters} open={(x) => set({ id: x })} back={() => set({ id: null })} /> : <RecordingList params={params} set={set} filters={filters} />;
}

/* ── list ── */

function RecordingList({ params, set, filters }: { params: URLSearchParams; set: (p: Record<string, string | null>) => void; filters: Record<string, string> }) {
  const { base } = useProject();
  const { canEdit } = useAuth();
  const days = Number(params.get('days') ?? 3) || 3;
  const device = (params.get('device') as Device | null) ?? 'all';
  const [limit, setLimit] = useState(50);
  const list = useProjectApi<ListResponse>('/recordings', { ...filters, days, limit });
  const settings = useProjectApi<Settings>('/recordings/settings');
  const [page, setPage] = useState(params.get('page') ?? '');
  useEffect(() => setPage(params.get('page') ?? ''), [params]);
  const star = async (r: RecordingRow) => {
    await api(`${base}/recordings/${r.id}`, { method: 'PATCH', body: { favorite: !r.favorite } }).catch(() => undefined);
    list.setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === r.id ? { ...x, favorite: !r.favorite } : x)) } : d));
  };
  const s = list.data?.summary;
  return (
    <div>
      <PageHeader
        title="Recordings"
        description="Watch real visits: mouse movement, clicks, scrolling and page changes. Inputs are always masked."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Device" value={device} onChange={(v) => set({ device: v === 'all' ? null : v })} options={DEVICE_OPTIONS} />
            <Segmented label="Date range" value={days} onChange={(v) => set({ days: String(v) })} options={DAY_OPTIONS} />
          </div>
        }
      />
      <div className="space-y-5">
        {s && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Sessions recorded" value={fmtNum(s.sessions)} />
            <Stat label="Avg. duration" value={fmtDuration(s.avgDurationMs)} />
            <Stat label="With rage clicks" value={fmtNum(s.withRageClicks)} />
            <Stat label="With dead clicks" value={fmtNum(s.withDeadClicks)} />
            <Stat label="With JS errors" value={fmtNum(s.withErrors)} />
          </div>
        )}

        <Card bodyClassName="flex flex-wrap items-end gap-3">
          {FLAGS.map((f) => {
            const on = params.get(f.key) === '1';
            return (
              <button key={f.key} aria-pressed={on} onClick={() => set({ [f.key]: on ? null : '1' })} className={cx('h-8 rounded-full border px-3 text-sm font-medium', on ? 'border-brand-600 bg-brand-50 text-brand-800' : 'border-gray-300 bg-white text-gray-700 hover:bg-gray-50')}>
                {f.label}
              </button>
            );
          })}
          <Field label="Min. duration">
            <select className="input" value={params.get('minDurationSec') ?? ''} onChange={(e) => set({ minDurationSec: e.target.value || null })}>
              <option value="">Any</option>
              <option value="10">10 s+</option>
              <option value="30">30 s+</option>
              <option value="60">1 min+</option>
              <option value="180">3 min+</option>
            </select>
          </Field>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              set({ page: page.trim() || null });
            }}
          >
            <Field label="Visited page contains">
              <input className="input w-52" placeholder="/services" value={page} onChange={(e) => setPage(e.target.value)} onBlur={() => set({ page: page.trim() || null })} />
            </Field>
          </form>
          <Field label="Sort by">
            <select className="input" value={params.get('sort') ?? 'newest'} onChange={(e) => set({ sort: e.target.value === 'newest' ? null : e.target.value })}>
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
              <option value="longest">Longest</option>
              <option value="clicks">Most clicks</option>
              <option value="pages">Most pages</option>
            </select>
          </Field>
        </Card>

        <Card
          title={<span className="flex items-center gap-2">Sessions {list.data && <DataLabel label={list.data.dataLabel} />}</span>}
          subtitle={list.data ? `${fmtNum(list.data.total)} matching the filters` : undefined}
          bodyClassName="p-0"
        >
          {list.error ? (
            <ErrorBox error={list.error} onRetry={list.reload} />
          ) : !list.data ? (
            <Loading />
          ) : list.data.items.length ? (
            <ul className="divide-y divide-gray-100">
              {list.data.items.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                  <button onClick={() => set({ id: r.id })} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white hover:bg-brand-700" aria-label="Play recording">
                    <Play className="h-4 w-4 fill-current" />
                  </button>
                  <button onClick={() => set({ id: r.id })} className="min-w-0 flex-1 text-left">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <span className="font-medium text-gray-900">{fmtDateTime(r.started_at)}</span>
                      {!r.viewed_at && <span className="h-2 w-2 rounded-full bg-brand-600" title="Not viewed yet" />}
                      <span className="tabular-nums text-gray-700">{fmtDuration(r.duration_ms)}</span>
                      <span className="flex items-center gap-1 text-gray-600"><FileText className="h-3.5 w-3.5" />{r.page_count} page{r.page_count === 1 ? '' : 's'}</span>
                      <span className="flex items-center gap-1 text-gray-600"><MousePointerClick className="h-3.5 w-3.5" />{r.click_count}</span>
                      <span className="flex items-center gap-1 text-gray-600"><DeviceIcon d={r.device} className="h-3.5 w-3.5" />{[r.browser, r.os, r.country].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-gray-500">
                      {r.entry_path}
                      {r.page_count > 1 && <> → … → {r.exit_path}</>}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    {r.rage_clicks > 0 && <Pill tone="red">{r.rage_clicks} rage</Pill>}
                    {r.dead_clicks > 0 && <Pill tone="amber">{r.dead_clicks} dead</Pill>}
                    {r.error_count > 0 && <Pill tone="violet">{r.error_count} error{r.error_count === 1 ? '' : 's'}</Pill>}
                    {canEdit && (
                      <button onClick={() => star(r)} className="rounded p-1.5 hover:bg-gray-100" aria-label={r.favorite ? 'Remove from favorites' : 'Add to favorites'}>
                        <Star className={cx('h-4 w-4', r.favorite ? 'fill-amber-400 text-amber-500' : 'text-gray-400')} />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title="No recordings match" description={settings.data && !settings.data.enabled ? 'Recording is switched off for this project – turn it on below.' : 'Widen the date range or clear filters. New sessions appear a few seconds after a visitor leaves or goes idle.'} />
          )}
          {list.data && list.data.items.length < list.data.total && (
            <div className="border-t border-gray-100 px-4 py-2 text-center">
              <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + 50)} loading={list.loading}>Show more</Button>
            </div>
          )}
        </Card>

        {settings.data && <RecordingSettingsCard settings={settings.data} reload={settings.reload} />}
      </div>
    </div>
  );
}

function RecordingSettingsCard({ settings, reload }: { settings: Settings; reload: () => void }) {
  const { base } = useProject();
  const { isAdmin } = useAuth();
  const { busy, run } = useAction();
  const save = (patch: Partial<Settings>) => run('save', () => api(`${base}/recordings/settings`, { method: 'PUT', body: { enabled: settings.enabled, sampleRate: settings.sampleRate, masking: settings.masking, ...patch } }), 'Recording settings saved').then((r) => r && reload());
  return (
    <Card
      title="Recording settings"
      subtitle="Recording uses the same tracking code as Heatmaps. Nothing else needs to be installed."
      actions={
        settings.clarityRecordingsUrl ? (
          <a className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50" href={settings.clarityRecordingsUrl} target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" /> Open Clarity recordings
          </a>
        ) : null
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Record sessions" hint={isAdmin ? undefined : 'Admins can change this.'}>
          <Toggle checked={settings.enabled} disabled={!isAdmin || busy === 'save'} onChange={(v) => save({ enabled: v })} label={settings.enabled ? 'On' : 'Off'} />
        </Field>
        <Field label="Masking" hint={settings.masking === 'strict' ? 'All text and every input is masked.' : 'Every input is masked; page text is visible. Add data-hm-mask to hide more text, or data-hm-block to leave an element out.'}>
          <select className="input w-full" value={settings.masking} disabled={!isAdmin} onChange={(e) => save({ masking: e.target.value as Settings['masking'] })}>
            <option value="balanced">Balanced (inputs masked)</option>
            <option value="strict">Strict (all text masked)</option>
          </select>
        </Field>
        <Field label="Sessions recorded" hint={`Kept ${settings.retentionDays} days · max ${settings.maxMbPerSession} MB per session`}>
          <select className="input w-full" value={String(settings.sampleRate)} disabled={!isAdmin} onChange={(e) => save({ sampleRate: Number(e.target.value) })}>
            {[1, 0.5, 0.25, 0.1].map((v) => (
              <option key={v} value={String(v)}>{v * 100}% of sessions</option>
            ))}
          </select>
        </Field>
      </div>
      <p className="mt-3 text-xs text-gray-500">No cookies: the session id lives in the tab's sessionStorage and ends after 30 minutes of inactivity. No IP addresses are stored. Do Not Track and Global Privacy Control are respected, and bots are ignored. Tell visitors in your privacy policy that visits may be recorded.</p>
    </Card>
  );
}

/* ── player ── */

interface Detail extends RecordingRow { previousId: string | null; nextId: string | null; masking: string }
interface TimelineItem { at: number; kind: 'page' | 'click' | 'rage-click' | 'dead-click' | 'error'; label: string }

function buildTimeline(events: RrEvent[]): TimelineItem[] {
  if (!events.length) return [];
  const t0 = events[0]!.timestamp;
  const out: TimelineItem[] = [];
  for (const e of events) {
    const at = e.timestamp - t0;
    if (e.type === 4 && e.data?.href) {
      let path = e.data.href;
      try {
        path = new URL(e.data.href).pathname;
      } catch {
        /* keep */
      }
      out.push({ at, kind: 'page', label: `Viewed ${path}` });
    } else if (e.type === 3 && e.data?.source === 2 && e.data?.type === 2) out.push({ at, kind: 'click', label: 'Click' });
    else if (e.type === 5 && e.data?.tag && e.data.tag in MARKER_COLORS) {
      const kind = e.data.tag as TimelineItem['kind'];
      out.push({ at, kind, label: kind === 'error' ? `Error: ${e.data.payload?.message ?? ''}` : `${kind === 'rage-click' ? 'Rage click' : 'Dead click'}${e.data.payload?.label ? ` on "${e.data.payload.label}"` : ''}` });
    }
  }
  // A rage click is three clicks: keep the rage marker, drop the plain clicks just before it.
  return out.filter((x, i) => !(x.kind === 'click' && out.slice(i + 1, i + 4).some((y) => y.kind === 'rage-click' && y.at - x.at < 1200)));
}

const KIND_STYLE: Record<TimelineItem['kind'], { icon: ReactNode; cls: string }> = {
  page: { icon: <FileText className="h-3.5 w-3.5" />, cls: 'text-gray-700' },
  click: { icon: <MousePointerClick className="h-3.5 w-3.5" />, cls: 'text-gray-600' },
  'rage-click': { icon: <Zap className="h-3.5 w-3.5" />, cls: 'text-red-700' },
  'dead-click': { icon: <MousePointerClick className="h-3.5 w-3.5" />, cls: 'text-amber-700' },
  error: { icon: <AlertOctagon className="h-3.5 w-3.5" />, cls: 'text-violet-700' },
};

function RecordingDetail({ id, filters, open, back }: { id: string; filters: Record<string, string>; open: (id: string) => void; back: () => void }) {
  const { base } = useProject();
  const { isAdmin, canEdit } = useAuth();
  const { busy, run } = useAction();
  const detail = useProjectApi<Detail>(`/recordings/${id}`, filters);
  const events = useProjectApi<{ events: RrEvent[] }>(`/recordings/${id}/events`);
  const player = useRef<PlayerHandle>(null);
  const [now, setNow] = useState(0);
  const [tab, setTab] = useState<'timeline' | 'session'>('timeline');
  const onTime = useCallback((t: number) => setNow(t), []);
  const timeline = useMemo(() => buildTimeline(events.data?.events ?? []), [events.data]);
  const pageStarts = useMemo(() => timeline.filter((x) => x.kind === 'page'), [timeline]);
  const d = detail.data;
  const currentPage = [...pageStarts].reverse().find((p) => p.at <= now + 50)?.label.replace(/^Viewed /, '') ?? d?.entry_path;
  const listRef = useRef<HTMLOListElement>(null);
  let activeIdx = -1;
  for (let i = 0; i < timeline.length; i++) if (timeline[i]!.at <= now + 50) activeIdx = i;
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (detail.error) return <ErrorBox error={detail.error} onRetry={detail.reload} />;
  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <button onClick={back} className="rounded p-1 text-gray-500 hover:bg-gray-100" aria-label="Back to recordings">
              <ArrowLeft className="h-5 w-5" />
            </button>
            Recording
            {d?.is_demo && <DataLabel label="demo" />}
          </span>
        }
        description={d ? `${fmtDateTime(d.started_at)} · ${fmtDuration(d.duration_ms)} · ${d.page_count} page${d.page_count === 1 ? '' : 's'} · ${[d.browser, d.os].filter(Boolean).join(' on ')}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            {d && canEdit && (
              <Button size="sm" variant="ghost" onClick={() => run('fav', () => api(`${base}/recordings/${id}`, { method: 'PATCH', body: { favorite: !d.favorite } })).then(() => detail.reload())} icon={<Star className={cx('h-4 w-4', d.favorite ? 'fill-amber-400 text-amber-500' : '')} />}>
                {d.favorite ? 'Favorite' : 'Add to favorites'}
              </Button>
            )}
            {d && isAdmin && (
              <Button size="sm" variant="ghost" loading={busy === 'del'} icon={<Trash2 className="h-4 w-4" />} onClick={() => confirm('Delete this recording permanently?') && run('del', () => api(`${base}/recordings/${id}`, { method: 'DELETE' }), 'Recording deleted').then((r) => r && back())}>
                Delete
              </Button>
            )}
            <Button size="sm" disabled={!d?.previousId} onClick={() => d?.previousId && open(d.previousId)} icon={<ChevronLeft className="h-4 w-4" />}>Newer</Button>
            <Button size="sm" disabled={!d?.nextId} onClick={() => d?.nextId && open(d.nextId)}>Older <ChevronRight className="h-4 w-4" /></Button>
          </div>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="min-w-0" bodyClassName="p-3">
          {currentPage && (
            <div className="mb-2 flex items-center justify-between gap-2 text-sm">
              <span className="truncate text-gray-700">
                Page: <span className="font-medium text-gray-900">{currentPage}</span>
              </span>
              <Link to={`/heatmaps?path=${encodeURIComponent(currentPage)}`} className="inline-flex shrink-0 items-center gap-1 text-brand-700 hover:underline">
                <Flame className="h-3.5 w-3.5" /> Heatmap of this page
              </Link>
            </div>
          )}
          {events.error ? (
            <ErrorBox error={events.error} onRetry={events.reload} />
          ) : !events.data ? (
            <Loading label="Loading recording…" />
          ) : events.data.events.length < 2 ? (
            <EmptyState compact title="This recording has no playable content yet" />
          ) : (
            <RecordingPlayer key={id} ref={player} events={events.data.events} onTime={onTime} />
          )}
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: MARKER_COLORS['rage-click'] }} /> rage click</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: MARKER_COLORS['dead-click'] }} /> dead click</span>
            <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: MARKER_COLORS.error }} /> JS error</span>
            <span>Idle time is skipped automatically. Masked text shows as ****.</span>
          </div>
        </Card>

        <Card
          bodyClassName="p-0"
          title={
            <div className="inline-flex rounded-md border border-gray-300 bg-white p-0.5">
              {(['timeline', 'session'] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)} className={cx('h-7 rounded px-3 text-sm font-medium', tab === t ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}>
                  {t === 'timeline' ? 'Timeline' : 'Session'}
                </button>
              ))}
            </div>
          }
        >
          {tab === 'timeline' ? (
            <ol ref={listRef} className="max-h-[70vh] divide-y divide-gray-100 overflow-auto text-sm">
              {timeline.map((x, i) => (
                <li key={i} data-idx={i}>
                  <button onClick={() => player.current?.goto(Math.max(0, x.at - 1500))} className={cx('flex w-full items-center gap-2 px-4 py-1.5 text-left hover:bg-gray-50', i === activeIdx && 'bg-brand-50', KIND_STYLE[x.kind].cls, x.kind === 'page' && 'font-medium')}>
                    <span className="w-11 shrink-0 text-xs tabular-nums text-gray-400">{fmtDuration(x.at)}</span>
                    {KIND_STYLE[x.kind].icon}
                    <span className="min-w-0 flex-1 truncate">{x.label}</span>
                  </button>
                </li>
              ))}
              {!timeline.length && <li className="px-4 py-3 text-gray-500">{events.data ? 'No events.' : 'Loading…'}</li>}
            </ol>
          ) : d ? (
            <dl className="divide-y divide-gray-100 text-sm">
              {[
                ['Date', fmtDateTime(d.started_at)],
                ['Duration', fmtDuration(d.duration_ms)],
                ['Pages', d.page_count],
                ['Clicks', d.click_count],
                ['Rage / dead clicks', `${d.rage_clicks} / ${d.dead_clicks}`],
                ['JS errors', d.error_count],
                ['Device', <span key="d" className="inline-flex items-center gap-1 capitalize"><DeviceIcon d={d.device} className="h-3.5 w-3.5" /> {d.device}</span>],
                ['Browser', d.browser ?? '—'],
                ['Operating system', d.os ?? '—'],
                ['Country', d.country ?? '—'],
                ['Screen', d.viewport_w ? `${d.viewport_w} × ${d.viewport_h}` : '—'],
                ['Entry page', d.entry_path],
                ['Exit page', d.exit_path],
                ['Masking', d.masking === 'strict' ? 'Strict (all text)' : 'Balanced (inputs)'],
                ['Viewed', d.viewed_at ? fmtRelative(d.viewed_at) : 'now'],
              ].map(([k, v]) => (
                <div key={String(k)} className="flex justify-between gap-3 px-4 py-1.5">
                  <dt className="text-gray-500">{k}</dt>
                  <dd className="truncate text-right text-gray-900">{v}</dd>
                </div>
              ))}
              <div className="px-4 py-2">
                <div className="mb-1 text-gray-500">Pages visited</div>
                <ol className="space-y-1">
                  {d.pages.map((p, i) => (
                    <li key={p.v + i}>
                      <button className="w-full truncate text-left text-brand-700 hover:underline" onClick={() => player.current?.goto(pageStarts[i]?.at ?? 0)}>
                        {i + 1}. {p.title ?? p.path} <span className="text-gray-400">{p.path}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            </dl>
          ) : (
            <Loading />
          )}
        </Card>
      </div>
    </div>
  );
}
