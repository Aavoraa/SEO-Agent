import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Link2, Plus, Save, Trash2, XCircle } from 'lucide-react';
import { api } from '../api/client';
import type { ApiKeyRow, AuditLog, AutomationSettings, BusinessProfile, ConnectionTestResult, DeploymentSettings, JobRunRow, LocationDef, ProjectMember, ProjectSettings, RuleInfo, ServiceDef, SetupStatus, Severity, User } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useApi, useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtDateTime, fmtRelative, humanize } from '../lib/format';
import { SEVERITIES } from '../lib/constants';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Field, Loading, Tabs, Toggle } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pill, StatusPill } from '../components/Badges';
import { CodeBlock } from '../components/CodeBlock';
import { JobButton } from '../components/JobButton';
import { JsonView } from '../components/JsonView';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Overlay';

type TabId = 'profile' | 'rules' | 'integrations' | 'deployment' | 'automation' | 'thresholds' | 'members' | 'users' | 'apikeys' | 'jobs' | 'audit';

function AdminNote() {
  const { isAdmin } = useAuth();
  if (isAdmin) return null;
  return <p className="mb-4 rounded-md border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">Read-only: only admins can change project settings.</p>;
}

/** Simple list editor: one string per line. */
function LinesField({ label, value, onChange, disabled, hint, rows = 4 }: { label: string; value: string[]; onChange: (v: string[]) => void; disabled?: boolean; hint?: ReactNode; rows?: number }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value]);
  return (
    <Field label={label} hint={hint}>
      <textarea className="input w-full" rows={rows} disabled={disabled} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onChange(text.split('\n').map((s) => s.trim()).filter(Boolean))} />
    </Field>
  );
}

function ProfileTab() {
  const { project, base, reloadProject } = useProject();
  const { isAdmin } = useAuth();
  const { busy, run } = useAction();
  const [p, setP] = useState<BusinessProfile | null>(project?.businessProfile ?? null);
  useEffect(() => setP(project?.businessProfile ?? null), [project]);
  if (!p) return <Loading />;
  const d = !isAdmin;
  const addr = p.address ?? { streetAddress: '', addressLocality: '', addressRegion: '', postalCode: '', addressCountry: 'IN' };
  const setAddr = (k: keyof typeof addr, v: string) => setP({ ...p, address: { ...addr, [k]: v } });
  const setSvc = (i: number, patch: Partial<ServiceDef>) => setP({ ...p, services: p.services.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const setLoc = (i: number, patch: Partial<LocationDef>) => setP({ ...p, locations: p.locations.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  const save = (e: FormEvent) => {
    e.preventDefault();
    const hasAddr = addr.streetAddress && addr.addressLocality && addr.addressRegion && addr.addressCountry;
    const businessProfile = {
      name: p.name,
      description: p.description,
      phone: p.phone || undefined,
      email: p.email || undefined,
      address: hasAddr ? { ...addr, postalCode: addr.postalCode || undefined } : undefined,
      facts: p.facts,
      ctas: p.ctas,
      services: p.services.map((s) => ({ id: s.id, name: s.name, path: s.path || undefined, terms: s.terms })),
      locations: p.locations,
    };
    run('save', () => api(base, { method: 'PATCH', body: { businessProfile } }), 'Business profile saved').then((r) => r && reloadProject());
  };

  return (
    <form onSubmit={save} className="space-y-5">
      <AdminNote />
      <Card title="Business" subtitle="Used for schema, local SEO and as the only facts the AI may cite">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Business name">
            <input className="input w-full" disabled={d} value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} />
          </Field>
          <Field label="Phone">
            <input className="input w-full" disabled={d} value={p.phone ?? ''} onChange={(e) => setP({ ...p, phone: e.target.value })} />
          </Field>
          <Field label="Email">
            <input className="input w-full" type="email" disabled={d} value={p.email ?? ''} onChange={(e) => setP({ ...p, email: e.target.value })} />
          </Field>
          <Field label="Website">
            <input className="input w-full" disabled value={p.url} readOnly />
          </Field>
          <Field label="Description" className="md:col-span-2">
            <textarea className="input w-full" rows={3} disabled={d} value={p.description} onChange={(e) => setP({ ...p, description: e.target.value })} />
          </Field>
        </div>
      </Card>
      <Card title="Address">
        <div className="grid gap-4 md:grid-cols-3">
          <Field label="Street address" className="md:col-span-3">
            <input className="input w-full" disabled={d} value={addr.streetAddress} onChange={(e) => setAddr('streetAddress', e.target.value)} />
          </Field>
          <Field label="City / locality">
            <input className="input w-full" disabled={d} value={addr.addressLocality} onChange={(e) => setAddr('addressLocality', e.target.value)} />
          </Field>
          <Field label="Region / state">
            <input className="input w-full" disabled={d} value={addr.addressRegion} onChange={(e) => setAddr('addressRegion', e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Postal code">
              <input className="input w-full" disabled={d} value={addr.postalCode ?? ''} onChange={(e) => setAddr('postalCode', e.target.value)} />
            </Field>
            <Field label="Country">
              <input className="input w-full" disabled={d} value={addr.addressCountry} onChange={(e) => setAddr('addressCountry', e.target.value)} />
            </Field>
          </div>
        </div>
      </Card>
      <div className="grid gap-5 md:grid-cols-2">
        <Card title="Verified facts" subtitle="One per line. Leave out anything you can't verify – the AI will ask for input instead of guessing.">
          <LinesField label="Facts" value={p.facts} disabled={d} onChange={(v) => setP({ ...p, facts: v })} rows={6} />
        </Card>
        <Card title="Calls to action" subtitle="One per line">
          <LinesField label="CTAs" value={p.ctas} disabled={d} onChange={(v) => setP({ ...p, ctas: v })} rows={6} />
        </Card>
      </div>
      <Card title="Services" subtitle="Terms are matched against search queries (comma separated)" actions={!d && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setP({ ...p, services: [...p.services, { id: '', name: '', path: '', terms: [] }] })}>Add service</Button>} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">ID</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Path</th>
                <th className="px-3 py-2 text-left font-medium">Terms</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.services.map((s, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-3 py-1.5"><input className="input w-36 font-mono text-xs" disabled={d} value={s.id} onChange={(e) => setSvc(i, { id: e.target.value })} aria-label="Service id" /></td>
                  <td className="px-3 py-1.5"><input className="input w-48" disabled={d} value={s.name} onChange={(e) => setSvc(i, { name: e.target.value })} aria-label="Service name" /></td>
                  <td className="px-3 py-1.5"><input className="input w-44 font-mono text-xs" disabled={d} value={s.path ?? ''} placeholder="(no page yet)" onChange={(e) => setSvc(i, { path: e.target.value })} aria-label="Service path" /></td>
                  <td className="px-3 py-1.5"><input className="input w-full min-w-72" disabled={d} defaultValue={s.terms.join(', ')} onBlur={(e) => setSvc(i, { terms: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} aria-label="Service terms" /></td>
                  <td className="px-3 py-1.5 text-right">{!d && <button type="button" className="text-gray-400 hover:text-red-600" onClick={() => setP({ ...p, services: p.services.filter((_, j) => j !== i) })} aria-label="Remove service"><Trash2 className="h-4 w-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <Card title="Locations" subtitle="Target locations drive local SEO recommendations" actions={!d && <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setP({ ...p, locations: [...p.locations, { id: '', name: '', level: 'city', aliases: [], target: false }] })}>Add location</Button>} bodyClassName="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">ID</th>
                <th className="px-3 py-2 text-left font-medium">Name</th>
                <th className="px-3 py-2 text-left font-medium">Level</th>
                <th className="px-3 py-2 text-left font-medium">Aliases</th>
                <th className="px-3 py-2 text-left font-medium">Target</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {p.locations.map((l, i) => (
                <tr key={i} className="border-t border-gray-100">
                  <td className="px-3 py-1.5"><input className="input w-32 font-mono text-xs" disabled={d} value={l.id} onChange={(e) => setLoc(i, { id: e.target.value })} aria-label="Location id" /></td>
                  <td className="px-3 py-1.5"><input className="input w-40" disabled={d} value={l.name} onChange={(e) => setLoc(i, { name: e.target.value })} aria-label="Location name" /></td>
                  <td className="px-3 py-1.5">
                    <select className="input" disabled={d} value={l.level} onChange={(e) => setLoc(i, { level: e.target.value as LocationDef['level'] })} aria-label="Level">
                      {['locality', 'city', 'region', 'country'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
                    </select>
                  </td>
                  <td className="px-3 py-1.5"><input className="input w-full min-w-56" disabled={d} defaultValue={l.aliases.join(', ')} onBlur={(e) => setLoc(i, { aliases: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} aria-label="Aliases" /></td>
                  <td className="px-3 py-1.5"><Toggle checked={l.target} disabled={d} onChange={(v) => setLoc(i, { target: v })} label={`Target ${l.name}`} /></td>
                  <td className="px-3 py-1.5 text-right">{!d && <button type="button" className="text-gray-400 hover:text-red-600" onClick={() => setP({ ...p, locations: p.locations.filter((_, j) => j !== i) })} aria-label="Remove location"><Trash2 className="h-4 w-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {!d && (
        <div className="sticky bottom-0 -mx-1 flex justify-end border-t border-gray-200 bg-gray-50/95 px-1 py-3">
          <Button type="submit" variant="primary" icon={<Save className="h-3.5 w-3.5" />} loading={busy === 'save'}>
            Save business profile
          </Button>
        </div>
      )}
    </form>
  );
}

function RulesTab() {
  const { project, base, reloadProject } = useProject();
  const { isAdmin } = useAuth();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useProjectApi<RuleInfo[]>('/rules');
  const [overrides, setOverrides] = useState<NonNullable<ProjectSettings['rules']>>(project?.settings?.rules ?? {});
  const [dirty, setDirty] = useState(false);
  useEffect(() => setOverrides(project?.settings?.rules ?? {}), [project]);

  const eff = (r: RuleInfo) => ({ enabled: overrides[r.id]?.enabled ?? r.effective.enabled, severity: overrides[r.id]?.severity ?? r.effective.severity, params: { ...r.effective.params, ...(overrides[r.id]?.params ?? {}) } });
  const patch = (id: string, p: Partial<{ enabled: boolean; severity: Severity; params: Record<string, number | string | boolean> }>) => {
    setOverrides((o) => ({ ...o, [id]: { ...o[id], ...p, params: p.params ? { ...(o[id]?.params ?? {}), ...p.params } : o[id]?.params } }));
    setDirty(true);
  };
  const save = () =>
    run('save', () => api(base, { method: 'PATCH', body: { settings: { rules: overrides } } }), 'Rule settings saved – they apply from the next crawl').then((r) => {
      if (r) {
        setDirty(false);
        reloadProject();
        reload();
      }
    });

  const cols: Column<RuleInfo>[] = [
    { key: 'enabled', header: 'On', render: (r) => <Toggle checked={eff(r).enabled} disabled={!isAdmin} onChange={(v) => patch(r.id, { enabled: v })} label={`Enable ${r.title}`} /> },
    {
      key: 'title',
      header: 'Rule',
      sort: (r) => r.title,
      render: (r) => (
        <div className="min-w-60 max-w-md">
          <div className="font-medium text-gray-900">{r.title}</div>
          <div className="text-xs text-gray-500">{r.rationale}</div>
          <div className="mt-0.5 font-mono text-[11px] text-gray-400">{r.id}</div>
        </div>
      ),
    },
    { key: 'cat', header: 'Category', sort: (r) => r.category, render: (r) => <span className="text-xs">{humanize(r.category)}</span> },
    {
      key: 'sev',
      header: 'Severity',
      sort: (r) => SEVERITIES.indexOf(eff(r).severity),
      render: (r) => (
        <select className="input" disabled={!isAdmin} value={eff(r).severity} onChange={(e) => patch(r.id, { severity: e.target.value as Severity })} aria-label={`Severity for ${r.title}`}>
          {SEVERITIES.map((s) => <option key={s} value={s}>{humanize(s)}{s === r.defaults.severity ? ' (default)' : ''}</option>)}
        </select>
      ),
    },
    {
      key: 'params',
      header: 'Parameters',
      render: (r) => {
        const params = eff(r).params;
        const keys = Object.keys(params);
        if (!keys.length) return <span className="text-xs text-gray-400">—</span>;
        return (
          <div className="flex flex-wrap gap-2">
            {keys.map((k) => {
              const v = params[k];
              return (
                <label key={k} className="flex items-center gap-1 text-xs text-gray-600">
                  {k}
                  {typeof v === 'boolean' ? (
                    <input type="checkbox" disabled={!isAdmin} checked={v} onChange={(e) => patch(r.id, { params: { [k]: e.target.checked } })} />
                  ) : (
                    <input className="input h-7 w-20" disabled={!isAdmin} value={String(v)} onChange={(e) => patch(r.id, { params: { [k]: typeof r.defaults.params[k] === 'number' && e.target.value !== '' && !Number.isNaN(Number(e.target.value)) ? Number(e.target.value) : e.target.value } })} />
                  )}
                </label>
              );
            })}
          </div>
        );
      },
    },
  ];

  return (
    <div>
      <AdminNote />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <div className="mb-3 flex items-center justify-between">
            <p className="text-xs text-gray-500">{data.length} rules · overrides are stored per project</p>
            {isAdmin && (
              <Button variant="primary" icon={<Save className="h-3.5 w-3.5" />} disabled={!dirty} loading={busy === 'save'} onClick={save}>
                Save rule changes
              </Button>
            )}
          </div>
          <DataTable columns={cols} rows={data} rowKey={(r) => r.id} dense />
        </>
      )}
    </div>
  );
}

function IntegrationsTab() {
  const { project, base, reloadProject } = useProject();
  const { isAdmin, status } = useAuth();
  const { busy, run } = useAction();
  const [params] = useSearchParams();
  const setup = useProjectApi<SetupStatus>('/setup-status');
  const [gsc, setGsc] = useState(project?.settings?.searchConsoleSiteUrl ?? '');
  const [ga4, setGa4] = useState(project?.settings?.ga4PropertyId ?? '');
  const google = params.get('google');

  const connect = () =>
    run('connect', async () => {
      const r = await api<{ url: string }>(`${base}/integrations/google/auth-url`);
      window.location.assign(r.url);
      return r;
    });
  const save = (e: FormEvent) => {
    e.preventDefault();
    const settings: ProjectSettings = {};
    if (gsc.trim()) settings.searchConsoleSiteUrl = gsc.trim();
    if (ga4.trim()) settings.ga4PropertyId = ga4.trim();
    run('save', () => api(base, { method: 'PATCH', body: { settings } }), 'Integration settings saved').then((r) => r && reloadProject());
  };

  return (
    <div className="space-y-5">
      {google && (
        <p className={cx('flex items-center gap-2 rounded-md border px-3 py-2 text-sm', google === 'connected' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800')}>
          {google === 'connected' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
          {google === 'connected' ? 'Google account connected. Run a Search Console and GA4 sync to load data.' : `Google connection failed (${google}). Check the OAuth client configuration and try again.`}
        </p>
      )}
      <Card title="Google" subtitle="Read-only access to Search Console and GA4">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              Service account: {status?.google.serviceAccount ? <Pill tone="green">Configured</Pill> : <Pill>Not configured</Pill>}
            </div>
            <div className="flex items-center gap-2">
              OAuth client: {status?.google.oauthClient ? <Pill tone="green">Configured</Pill> : <Pill>Not configured</Pill>}
            </div>
            {(setup.data?.integrations ?? []).map((i) => (
              <div key={i.provider} className="flex flex-wrap items-center gap-2">
                {humanize(i.provider)}: <StatusPill status={i.status} />
                <span className="text-xs text-gray-500">last sync {fmtRelative(i.last_sync_at)}</span>
                {i.last_error && <span className="text-xs text-red-700">{i.last_error}</span>}
              </div>
            ))}
            {isAdmin && (
              <div className="pt-2">
                <Button variant="primary" icon={<Link2 className="h-3.5 w-3.5" />} loading={busy === 'connect'} onClick={connect}>
                  Connect Google
                </Button>
                <p className="mt-1 text-xs text-gray-500">Requires GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET on the API, or use a service account instead.</p>
              </div>
            )}
          </div>
          <div className="space-y-3">
            {setup.data && (
              <ul className="space-y-1.5 text-sm">
                {setup.data.steps.map((s) => (
                  <li key={s.id} className="flex items-start gap-2">
                    {s.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 text-gray-300" />}
                    <span>
                      {s.label}
                      {s.detail && <span className="block text-xs text-gray-500">{s.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <JobButton type="gsc-sync" label="Run Search Console sync" size="sm" onDone={setup.reload} />
              <JobButton type="ga4-sync" label="Run GA4 sync" size="sm" onDone={setup.reload} />
            </div>
          </div>
        </div>
      </Card>
      <Card title="Properties">
        <form onSubmit={save} className="grid gap-4 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <Field label="Search Console site URL" hint={`e.g. sc-domain:phoenixxit.com or https://www.phoenixxit.com/ ${status?.google.searchConsoleSiteUrl ? `(env: ${status.google.searchConsoleSiteUrl})` : ''}`}>
            <input className="input w-full" disabled={!isAdmin} value={gsc} onChange={(e) => setGsc(e.target.value)} />
          </Field>
          <Field label="GA4 property ID" hint={`Numeric property ID, not the G- measurement ID ${status?.google.ga4PropertyId ? `(env: ${status.google.ga4PropertyId})` : ''}`}>
            <input className="input w-full" disabled={!isAdmin} inputMode="numeric" value={ga4} onChange={(e) => setGa4(e.target.value)} />
          </Field>
          {isAdmin && (
            <Button type="submit" variant="primary" loading={busy === 'save'} className="mb-5">
              Save
            </Button>
          )}
        </form>
      </Card>
      <Card title="Other integrations">
        <div className="grid gap-2 text-sm md:grid-cols-3">
          <div>AI provider: <strong>{status?.ai.provider}</strong> ({status?.ai.model})</div>
          <div>Website adapter: <strong>{status?.websiteAdapter}</strong></div>
          <div>Notifications: <strong>{status?.notifications.length ? status.notifications.join(', ') : 'none configured'}</strong></div>
        </div>
      </Card>
    </div>
  );
}

function ThresholdsTab() {
  const { project, base, reloadProject } = useProject();
  const { isAdmin, status } = useAuth();
  const { busy, run } = useAction();
  const s = project?.settings ?? {};
  const [drop, setDrop] = useState(String(s.thresholds?.trafficDropPct ?? 30));
  const [minImpr, setMinImpr] = useState(String(s.thresholds?.minImpressionsForLocationPage ?? 100));
  const channels = useMemo(() => [...new Set(['email', 'slack', 'teams', 'telegram', ...(status?.notifications ?? [])])], [status]);
  const [sev, setSev] = useState<Record<string, Severity>>(s.alertMinSeverity ?? {});

  const save = (e: FormEvent) => {
    e.preventDefault();
    run('save', () => api(base, { method: 'PATCH', body: { settings: { thresholds: { ...(s.thresholds ?? {}), trafficDropPct: Number(drop), minImpressionsForLocationPage: Number(minImpr) }, alertMinSeverity: sev } } }), 'Thresholds saved').then((r) => r && reloadProject());
  };
  return (
    <form onSubmit={save} className="space-y-5">
      <AdminNote />
      <Card title="Thresholds">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Traffic drop alert (%)" hint="Alert when organic clicks drop by at least this much week-over-week (5–95).">
            <input className="input w-32" type="number" min={5} max={95} disabled={!isAdmin} value={drop} onChange={(e) => setDrop(e.target.value)} />
          </Field>
          <Field label="Min. impressions for a location page" hint="Below this, the tool recommends a section on an existing page instead of a new thin page.">
            <input className="input w-32" type="number" min={0} disabled={!isAdmin} value={minImpr} onChange={(e) => setMinImpr(e.target.value)} />
          </Field>
        </div>
      </Card>
      <Card title="Alert minimum severity per channel" subtitle="Only alerts at or above this severity are sent to the channel">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {channels.map((c) => (
            <Field key={c} label={humanize(c)} hint={status?.notifications.includes(c) ? 'Configured' : 'Not configured on the server'}>
              <select className="input w-full" disabled={!isAdmin} value={sev[c] ?? ''} onChange={(e) => setSev((x) => ({ ...x, [c]: e.target.value as Severity }))}>
                <option value="">Default</option>
                {SEVERITIES.map((v) => <option key={v} value={v}>{humanize(v)}</option>)}
              </select>
            </Field>
          ))}
        </div>
      </Card>
      {isAdmin && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" icon={<Save className="h-3.5 w-3.5" />} loading={busy === 'save'}>
            Save thresholds
          </Button>
        </div>
      )}
    </form>
  );
}

const AUTOMATION_LEVELS: { level: 0 | 1 | 2 | 3 | 4; title: string; text: string }[] = [
  { level: 0, title: 'Analyze only', text: 'Audits, scores and opportunities. No approvals, no AI-generated fixes.' },
  { level: 1, title: 'Recommend', text: 'Recommendations and human approvals. No AI-generated fixes.' },
  { level: 2, title: 'Generate, human approves', text: 'AI prepares fixes with a before/after preview; every change needs a human approval. (Default)' },
  { level: 3, title: 'Autopilot: low risk', text: 'Low-risk fixes (titles, meta descriptions, schema…) with high confidence are approved and deployed automatically, up to the daily limit.' },
  { level: 4, title: 'Autopilot: bounded', text: 'Level 3 plus the medium-risk change types you allow below. High-risk and critical changes are never automatic.' },
];

function AutomationTab() {
  const { isAdmin } = useAuth();
  const { base } = useProject();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useProjectApi<AutomationSettings>('/automation');
  const [draft, setDraft] = useState<AutomationSettings | null>(null);
  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!draft) return loading ? <Loading /> : null;
  const save = () => run('save', () => api(`${base}/automation`, { method: 'PUT', body: draft }), 'Automation level saved').then((r) => r && reload());
  return (
    <div className="space-y-5">
      <Card title="Automation level" subtitle="How much the platform may do on its own for this project. Your plan sets the maximum.">
        <div className="space-y-2">
          {AUTOMATION_LEVELS.map((l) => (
            <label key={l.level} className={cx('flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5', draft.level === l.level ? 'border-brand-300 bg-brand-50/50' : 'border-gray-200')}>
              <input type="radio" name="level" className="mt-1" disabled={!isAdmin} checked={draft.level === l.level} onChange={() => setDraft({ ...draft, level: l.level })} />
              <span>
                <span className="text-sm font-semibold text-gray-900">Level {l.level} · {l.title}</span>
                <span className="block text-xs text-gray-600">{l.text}</span>
              </span>
            </label>
          ))}
        </div>
        {draft.level >= 3 && (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <Field label="Daily limit (automatic approvals)">
              <input className="input w-28" type="number" min={1} max={100} disabled={!isAdmin} value={draft.dailyLimit} onChange={(e) => setDraft({ ...draft, dailyLimit: Number(e.target.value) })} />
            </Field>
            {draft.level === 4 && (
              <Field label="Medium-risk change types allowed">
                <div className="flex flex-wrap gap-3 pt-1">
                  {['h1', 'headings', 'content', 'faq', 'cta'].map((t) => (
                    <label key={t} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" disabled={!isAdmin} checked={draft.allowedMediumTypes.includes(t)} onChange={(e) => setDraft({ ...draft, allowedMediumTypes: e.target.checked ? [...draft.allowedMediumTypes, t] : draft.allowedMediumTypes.filter((x) => x !== t) })} />
                      {humanize(t)}
                    </label>
                  ))}
                </div>
              </Field>
            )}
          </div>
        )}
        {isAdmin ? (
          <div className="mt-4 flex items-center gap-2">
            <Button variant="primary" icon={<Save className="h-3.5 w-3.5" />} loading={busy === 'save'} onClick={save}>Save</Button>
            <span className="text-xs text-gray-500">Autopilot runs through the same approval, backup, verification and rollback pipeline, and every automatic decision is in the audit log.</span>
          </div>
        ) : (
          <p className="mt-3 text-xs text-gray-500">Only project admins can change the automation level.</p>
        )}
      </Card>
    </div>
  );
}

function DeploymentTab() {
  const { isAdmin } = useAuth();
  const { base, project } = useProject();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useProjectApi<DeploymentSettings>('/deployment');
  const [form, setForm] = useState<Record<string, string>>({});
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const [confirmDomain, setConfirmDomain] = useState('');
  const domain = project?.websites?.[0]?.base_url ? new URL(project.websites[0].base_url).hostname.replace(/^www\./, '') : '';
  useEffect(() => {
    if (!data) return;
    const c = data.connection;
    setForm({
      provider: c.provider ?? (['ftp', 'sftp', 'git', 'wordpress', 'api', 'manual'].includes(data.provider) ? data.provider : 'ftp'),
      host: c.host ?? '',
      port: c.port ? String(c.port) : '',
      username: c.username ?? '',
      password: '',
      privateKey: '',
      passphrase: '',
      remoteRoot: c.remoteRoot ?? '/public_html',
      secure: c.secure ?? 'true',
      allowInsecure: c.allowInsecure ? 'true' : 'false',
      tlsServername: c.tlsServername ?? '',
      hostFingerprint: c.hostFingerprint ?? '',
      verifyBaseUrl: c.verifyBaseUrl ?? '',
    });
  }, [data]);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return loading ? <Loading /> : null;
  const f = (k: string) => form[k] ?? '';
  const set = (k: string) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const save = (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = { provider: f('provider') };
    for (const k of ['host', 'username', 'password', 'privateKey', 'passphrase', 'remoteRoot', 'tlsServername', 'hostFingerprint', 'verifyBaseUrl']) if (f(k).trim()) body[k] = f(k).trim();
    if (f('port')) body.port = Number(f('port'));
    if (f('provider') === 'ftp') {
      body.secure = f('secure');
      body.allowInsecure = f('allowInsecure') === 'true';
    }
    run('save', () => api(`${base}/deployment/connection`, { method: 'PUT', body }), 'Connection saved (password encrypted). Run a connection test next.').then((r) => {
      if (r) {
        setTest(null);
        reload();
      }
    });
  };
  const fileProvider = ['ftp', 'sftp'].includes(f('provider'));
  const connectedLabel = data.mode === 'demo' ? 'DEMO' : !data.configured ? 'NOT CONNECTED' : !data.fileBased ? 'ADAPTER' : data.connected ? 'CONNECTED' : 'NOT TESTED';
  return (
    <div className="space-y-5">
      <Card title="Website deployment" subtitle="How approved SEO changes reach the website">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={data.mode === 'demo' ? 'violet' : 'dark'}>{data.mode === 'demo' ? 'DEMO MODE' : 'LIVE PROJECT'}</Pill>
          <Pill tone={connectedLabel === 'CONNECTED' || connectedLabel === 'DEMO' || connectedLabel === 'ADAPTER' ? 'green' : 'red'}>{connectedLabel}</Pill>
          {data.mode === 'live' && data.fileBased && <Pill tone={data.liveEnabled ? 'green' : 'amber'}>Live deployment {data.liveEnabled ? 'ON' : 'OFF'}</Pill>}
          <span className="text-sm text-gray-700">{data.description}</span>
        </div>
        {data.missing.length > 0 && <p className="mt-2 text-sm text-red-700">Required: {data.missing.join(', ')}.</p>}
        <dl className="mt-3 grid grid-cols-[150px_1fr] gap-x-3 gap-y-1 text-xs text-gray-600">
          <dt>Provider</dt><dd>{data.provider} <span className="text-gray-400">(from {data.source === 'env' ? 'environment variables' : data.source === 'project' ? 'project settings' : 'demo'})</span></dd>
          <dt>Verification URL</dt><dd className="font-mono">{data.verifyBaseUrl}</dd>
          <dt>Deployable changes</dt><dd>{data.deployableChangeTypes.length ? data.deployableChangeTypes.map(humanize).join(', ') : 'none – changes are exported or sent to the adapter'}</dd>
          {data.lastTest && (<><dt>Last connection test</dt><dd>{data.lastTest.status} {fmtRelative(data.lastTest.at)} {data.lastTest.error && <span className="text-red-700">– {data.lastTest.error}</span>}</dd></>)}
          {data.liveEnabledBy && (<><dt>Live enabled by</dt><dd>{data.liveEnabledBy} {fmtRelative(data.liveEnabledAt)}</dd></>)}
        </dl>
        {data.mode === 'demo' && <p className="mt-3 text-xs text-violet-800">In demo mode every deployment writes to a local copy of the site served by the API. Configure the real connection in a live (non-demo) project.</p>}
      </Card>

      {data.mode === 'live' && isAdmin && (
        <>
          <Card title="Connection" subtitle="Credentials are encrypted at rest (AES-256-GCM), never shown again, never logged and never sent to the AI.">
            <form onSubmit={save} className="grid gap-3 md:grid-cols-3">
              <Field label="Provider">
                <select className="input w-full" value={f('provider')} onChange={set('provider')}>
                  <option value="sftp">SFTP (SSH) – recommended</option>
                  <option value="ftp">FTP / FTPS</option>
                  <option value="git">Git repository</option>
                  <option value="wordpress">WordPress REST API</option>
                  <option value="api">Custom website API</option>
                  <option value="manual">Manual export (no connection)</option>
                </select>
              </Field>
              {fileProvider && (
                <>
                  <Field label="Host"><input className="input w-full" value={f('host')} onChange={set('host')} placeholder="ftp.phoenixxit.com" /></Field>
                  <Field label="Port"><input className="input w-full" inputMode="numeric" value={f('port')} onChange={set('port')} placeholder={f('provider') === 'sftp' ? '22' : '21'} /></Field>
                  <Field label="Username"><input className="input w-full" autoComplete="off" value={f('username')} onChange={set('username')} /></Field>
                  <Field label={`Password${data.connection.hasPassword ? ' (stored – leave empty to keep)' : ''}`}><input className="input w-full" type="password" autoComplete="new-password" value={f('password')} onChange={set('password')} placeholder={data.connection.hasPassword ? '••••••••' : ''} /></Field>
                  <Field label="Remote web root"><input className="input w-full font-mono" value={f('remoteRoot')} onChange={set('remoteRoot')} /></Field>
                </>
              )}
              {f('provider') === 'ftp' && (
                <>
                  <Field label="Encryption">
                    <select className="input w-full" value={f('secure')} onChange={set('secure')}>
                      <option value="true">FTPS – explicit TLS (recommended)</option>
                      <option value="implicit">FTPS – implicit TLS (port 990)</option>
                      <option value="false">Plain FTP (unencrypted)</option>
                    </select>
                  </Field>
                  <Field label="TLS certificate name (optional)"><input className="input w-full" value={f('tlsServername')} onChange={set('tlsServername')} placeholder="if the certificate is for your host provider" /></Field>
                  {f('secure') === 'false' && (
                    <label className="flex items-center gap-2 text-xs text-red-700 md:col-span-3">
                      <input type="checkbox" checked={f('allowInsecure') === 'true'} onChange={(e) => setForm({ ...form, allowInsecure: e.target.checked ? 'true' : 'false' })} />
                      I accept that plain FTP sends the password unencrypted
                    </label>
                  )}
                </>
              )}
              {f('provider') === 'sftp' && (
                <>
                  <Field label="Host key fingerprint"><input className="input w-full font-mono" value={f('hostFingerprint')} onChange={set('hostFingerprint')} placeholder="SHA256:… (shown by Test connection)" /></Field>
                  <Field label={`Private key (optional)${data.connection.hasPrivateKey ? ' – stored' : ''}`} className="md:col-span-2"><textarea className="input w-full font-mono text-xs" rows={2} value={f('privateKey')} onChange={set('privateKey')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></Field>
                  <Field label="Key passphrase"><input className="input w-full" type="password" autoComplete="new-password" value={f('passphrase')} onChange={set('passphrase')} /></Field>
                </>
              )}
              <Field label="Verification URL (optional)" className="md:col-span-2"><input className="input w-full" value={f('verifyBaseUrl')} onChange={set('verifyBaseUrl')} placeholder={data.verifyBaseUrl} /></Field>
              <div className="flex items-end gap-2 md:col-span-3">
                <Button type="submit" variant="primary" icon={<Save className="h-3.5 w-3.5" />} loading={busy === 'save'}>Save connection</Button>
                <Button type="button" loading={busy === 'test'} onClick={() => run('test', () => api<ConnectionTestResult>(`${base}/deployment/test`, { method: 'POST' })).then((r) => { if (r) { setTest(r); reload(); } })}>
                  Test connection (read-only)
                </Button>
              </div>
            </form>
            {test && (
              <div className={cx('mt-3 rounded-md border px-3 py-2 text-sm', test.ok ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50')}>
                <div className="font-medium">{test.message}</div>
                <ul className="mt-1 space-y-0.5 text-xs">
                  {test.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-1.5">{s.ok ? <CheckCircle2 className="mt-px h-3.5 w-3.5 text-emerald-600" /> : <XCircle className="mt-px h-3.5 w-3.5 text-red-600" />}<strong>{s.step}:</strong> {s.detail}</li>
                  ))}
                </ul>
                {test.fingerprint && <p className="mt-1 text-xs">Server host key: <code className="font-mono">{test.fingerprint}</code> – verify it with your host, then paste it above.</p>}
              </div>
            )}
          </Card>

          {data.fileBased && (
            <Card title="Live deployment switch" subtitle="Nothing is written to the real website until an admin switches this on. Switching it on requires a successful connection test.">
              {data.liveEnabled ? (
                <Button variant="danger" loading={busy === 'live'} onClick={() => run('live', () => api(`${base}/deployment/live`, { body: { enabled: false } }), 'Live deployment switched off').then((r) => r && reload())}>
                  Switch live deployment off
                </Button>
              ) : (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={`Type ${domain} to confirm`}>
                    <input className="input w-60" value={confirmDomain} onChange={(e) => setConfirmDomain(e.target.value)} placeholder={domain} />
                  </Field>
                  <Button variant="primary" disabled={!data.connected || confirmDomain.trim().replace(/^www\./, '') !== domain} loading={busy === 'live'} onClick={() => run('live', () => api(`${base}/deployment/live`, { body: { enabled: true, confirmDomain } }), 'Live deployment enabled').then((r) => r && reload())}>
                    Enable live deployment
                  </Button>
                  {!data.connected && <span className="text-xs text-amber-700">Run a successful connection test first.</span>}
                </div>
              )}
            </Card>
          )}

          <Card title="Connecting a GoDaddy-hosted site">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
              <li>GoDaddy → My Products → Web Hosting → <strong>Manage</strong> → cPanel Admin.</li>
              <li><strong>SFTP (recommended):</strong> cPanel → Security → <em>SSH Access</em> (enable SSH if needed). Host = your server hostname or IP, port 22, your cPanel username and password.</li>
              <li><strong>FTPS:</strong> cPanel → Files → <em>FTP Accounts</em>. Create an account limited to the website folder; use explicit TLS on port 21.</li>
              <li>The web root is usually <code>/public_html</code> – but check where <code>index.html</code> lives; <em>Test connection</em> confirms it matches the live homepage.</li>
              <li>Save → Test connection → type the domain → Enable live deployment. Only HTML files can be changed; backups are taken before every change.</li>
            </ol>
          </Card>
        </>
      )}
      {data.mode === 'live' && !isAdmin && <EmptyState title="Admins only" description="Ask a project admin to configure the website connection." />}
    </div>
  );
}

const ROLE_HELP ='Viewers read; editors run jobs and approve low/medium-risk changes; admins also approve high-risk changes, roll back and manage settings and members.';

function MembersTab() {
  const { isAdmin, user: me } = useAuth();
  const { base, project } = useProject();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useProjectApi<ProjectMember[]>(isAdmin ? '/members' : null);
  const [form, setForm] = useState({ email: '', role: 'viewer' });
  if (!isAdmin) return <EmptyState title="Project admins only" description="Ask an admin of this project to manage who has access." />;
  const add = (e: FormEvent) => {
    e.preventDefault();
    run('add', () => api(`${base}/members`, { body: form }), 'Member added').then((r) => {
      if (r) {
        setForm({ email: '', role: 'viewer' });
        reload();
      }
    });
  };
  const setRole = (m: ProjectMember, role: string) => run(m.userId, () => api(`${base}/members/${m.userId}`, { method: 'PUT', body: { role } }), 'Role updated').then((r) => r && reload());
  const remove = (m: ProjectMember) => window.confirm(`Remove ${m.email} from ${project?.name ?? 'this project'}?`) && run(m.userId, () => api(`${base}/members/${m.userId}`, { method: 'DELETE' }), 'Member removed').then((r) => r && reload());
  const cols: Column<ProjectMember>[] = [
    { key: 'user', header: 'Member', sort: (r) => r.email, render: (r) => (<div><div className="font-medium text-gray-900">{r.name}</div><div className="text-xs text-gray-500">{r.email}{!r.isActive && ' · disabled'}</div></div>) },
    {
      key: 'role',
      header: 'Role on this project',
      render: (r) => (
        <select className="input" value={r.role} disabled={r.userId === me?.id || busy === r.userId} onChange={(e) => setRole(r, e.target.value)} aria-label={`Role for ${r.email}`}>
          {['viewer', 'editor', 'admin'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
        </select>
      ),
    },
    { key: 'added', header: 'Added', sort: (r) => r.addedAt, render: (r) => <span className="text-xs">{fmtDateTime(r.addedAt)}</span> },
    { key: 'a', header: '', align: 'right', render: (r) => r.userId !== me?.id && <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} loading={busy === r.userId} onClick={() => remove(r)}>Remove</Button> },
  ];
  return (
    <div className="space-y-5">
      <Card title={`Add a member to ${project?.name ?? 'this project'}`} subtitle={`Only members can see this project. Platform admins always have access. ${ROLE_HELP}`}>
        <form onSubmit={add} className="flex flex-wrap items-end gap-3">
          <Field label="Email of an existing user"><input className="input w-64" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role">
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {['viewer', 'editor', 'admin'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
            </select>
          </Field>
          <Button type="submit" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={busy === 'add'}>Add member</Button>
        </form>
      </Card>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && <DataTable columns={cols} rows={data} rowKey={(r) => r.userId} empty={<EmptyState compact title="No members yet" description="Only platform admins can see this project." />} />}
    </div>
  );
}

function UsersTab() {
  const { isPlatformAdmin, user: me } = useAuth();
  const { projectId, project, projects } = useProject();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useApi<User[]>(isPlatformAdmin ? '/api/auth/users' : null);
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'viewer', projectRole: 'viewer' });
  if (!isPlatformAdmin) return <EmptyState title="Platform admins only" description="Ask a platform admin to create accounts. Project admins can add existing users under Members." />;
  const create = (e: FormEvent) => {
    e.preventDefault();
    const { projectRole, ...user } = form;
    const body = { ...user, projects: user.role !== 'admin' && projectId && projectRole !== 'none' ? [{ projectId, role: projectRole }] : [] };
    run('create', () => api('/api/auth/users', { body }), 'User created').then((r) => {
      if (r) {
        setForm({ email: '', name: '', password: '', role: 'viewer', projectRole: 'viewer' });
        reload();
      }
    });
  };
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const update = (u: User, body: { role?: string; isActive?: boolean }) => run(u.id, () => api(`/api/auth/users/${u.id}`, { method: 'PATCH', body }), 'User updated').then((r) => r && reload());
  const cols: Column<User>[] = [
    { key: 'name', header: 'User', sort: (r) => r.email, render: (r) => (<div><div className="font-medium text-gray-900">{r.name}</div><div className="text-xs text-gray-500">{r.email}</div></div>) },
    {
      key: 'role',
      header: 'Platform access',
      render: (r) => (
        <select className="input" value={r.role === 'admin' ? 'admin' : 'viewer'} disabled={r.id === me?.id || busy === r.id} onChange={(e) => update(r, { role: e.target.value })} aria-label={`Platform access for ${r.email}`}>
          <option value="viewer">Project members only</option>
          <option value="admin">Platform admin (all projects)</option>
        </select>
      ),
    },
    {
      key: 'projects',
      header: 'Projects',
      render: (r) =>
        r.role === 'admin' ? (
          <span className="text-xs text-gray-500">All</span>
        ) : r.memberships?.length ? (
          <span className="flex flex-wrap gap-1">{r.memberships.map((m) => <Pill key={m.projectId} tone={m.projectId === projectId ? 'brand' : 'gray'}>{projectName(m.projectId)} · {m.role}</Pill>)}</span>
        ) : (
          <span className="text-xs text-amber-700">None – add under Members</span>
        ),
    },
    { key: 'active', header: 'Active', render: (r) => <Toggle checked={!!r.is_active} disabled={r.id === me?.id} onChange={(v) => update(r, { isActive: v })} label={`Active ${r.email}`} /> },
    { key: 'last', header: 'Last login', sort: (r) => r.last_login_at, render: (r) => <span className="text-xs">{fmtRelative(r.last_login_at)}</span> },
    { key: 'created', header: 'Created', render: (r) => <span className="text-xs">{fmtDateTime(r.created_at)}</span> },
  ];
  return (
    <div className="space-y-5">
      <Card title="Add user" subtitle={`Users only see the projects they are members of. ${ROLE_HELP}`}>
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <Field label="Name"><input className="input w-44" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><input className="input w-56" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Temporary password"><input className="input w-44" type="password" minLength={10} required autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Platform access">
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="viewer">Project members only</option>
              <option value="admin">Platform admin (all projects)</option>
            </select>
          </Field>
          {form.role !== 'admin' && (
            <Field label={`Role on ${project?.name ?? 'this project'}`}>
              <select className="input" value={form.projectRole} onChange={(e) => setForm({ ...form, projectRole: e.target.value })}>
                <option value="none">No access</option>
                {['viewer', 'editor', 'admin'].map((x) => <option key={x} value={x}>{humanize(x)}</option>)}
              </select>
            </Field>
          )}
          <Button type="submit" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={busy === 'create'} className="mb-0">Create user</Button>
        </form>
      </Card>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && <DataTable columns={cols} rows={data} rowKey={(r) => r.id} />}
    </div>
  );
}

function ApiKeysTab() {
  const { isPlatformAdmin } = useAuth();
  const { projectId, project, projects } = useProject();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useApi<ApiKeyRow[]>(isPlatformAdmin ? '/api/auth/api-keys' : null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('service');
  const [scoped, setScoped] = useState(true);
  const [created, setCreated] = useState<{ key: string; name: string; note: string } | null>(null);
  if (!isPlatformAdmin) return <EmptyState title="Platform admins only" description="Ask a platform admin to manage API keys." />;
  const create = (e: FormEvent) => {
    e.preventDefault();
    run('create', () => api<{ key: string; name: string; note: string }>('/api/auth/api-keys', { body: { name, role, ...(scoped && projectId ? { projectId } : {}) } })).then((r) => {
      if (r) {
        setCreated(r);
        setName('');
        reload();
      }
    });
  };
  const cols: Column<ApiKeyRow>[] = [
    { key: 'name', header: 'Name', sort: (r) => r.name, render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'role', header: 'Role', render: (r) => <Pill>{humanize(r.role)}</Pill> },
    { key: 'scope', header: 'Projects', render: (r) => <span className="text-xs">{r.project_id ? projects.find((p) => p.id === r.project_id)?.name ?? r.project_id.slice(0, 8) : 'All'}</span> },
    { key: 'created', header: 'Created', sort: (r) => r.created_at, render: (r) => <span className="text-xs">{fmtDateTime(r.created_at)}</span> },
    { key: 'used', header: 'Last used', render: (r) => <span className="text-xs">{fmtRelative(r.last_used_at)}</span> },
    { key: 'status', header: 'Status', render: (r) => (r.revoked_at ? <Pill tone="red">Revoked {fmtRelative(r.revoked_at)}</Pill> : <Pill tone="green">Active</Pill>) },
    {
      key: 'a',
      header: '',
      align: 'right',
      render: (r) =>
        !r.revoked_at && (
          <Button size="sm" variant="danger" loading={busy === r.id} onClick={() => window.confirm(`Revoke "${r.name}"? Integrations using it will stop working.`) && run(r.id, () => api(`/api/auth/api-keys/${r.id}`, { method: 'DELETE' }), 'API key revoked').then((x) => x && reload())}>
            Revoke
          </Button>
        ),
    },
  ];
  return (
    <div className="space-y-5">
      <Card title="Create API key" subtitle="For n8n and other automations. Service keys can read and run jobs but can never approve changes.">
        <form onSubmit={create} className="flex flex-wrap items-end gap-3">
          <Field label="Name"><input className="input w-56" required value={name} onChange={(e) => setName(e.target.value)} placeholder="n8n production" /></Field>
          <Field label="Role">
            <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="service">Service</option>
              <option value="viewer">Viewer</option>
            </select>
          </Field>
          <label className="mb-2 flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={scoped} onChange={(e) => setScoped(e.target.checked)} />
            Only {project?.name ?? 'this project'}
          </label>
          <Button type="submit" variant="primary" loading={busy === 'create'}>Create key</Button>
        </form>
      </Card>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && <DataTable columns={cols} rows={data} rowKey={(r) => r.id} empty={<EmptyState compact title="No API keys" />} />}
      <Modal open={!!created} onClose={() => setCreated(null)} title={`API key “${created?.name ?? ''}”`} footer={<Button variant="primary" onClick={() => setCreated(null)}>I have stored the key</Button>}>
        {created && (
          <div className="space-y-3">
            <p className="text-sm text-amber-800">{created.note}</p>
            <CodeBlock code={created.key} />
            <p className="text-xs text-gray-500">Send it as the <code className="font-mono">x-api-key</code> header.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}

function JobsTab() {
  const { data, error, loading, reload } = useProjectApi<JobRunRow[]>('/jobs');
  const cols: Column<JobRunRow>[] = [
    { key: 'type', header: 'Job', sort: (r) => r.job_type, render: (r) => <span className="font-mono text-xs">{r.job_type}</span> },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusPill status={r.status} /> },
    { key: 'trigger', header: 'Trigger', render: (r) => <span className="text-xs">{r.trigger}</span> },
    { key: 'started', header: 'Started', sort: (r) => r.started_at ?? r.created_at, render: (r) => <span className="text-xs whitespace-nowrap">{fmtDateTime(r.started_at ?? r.created_at)}</span> },
    { key: 'dur', header: 'Duration', align: 'right', sort: (r) => r.seconds, render: (r) => (r.seconds != null ? `${r.seconds.toFixed(1)} s` : r.status === 'running' ? 'running…' : '—') },
    { key: 'err', header: 'Error', render: (r) => (r.error ? <span className="block max-w-md text-xs text-red-700">{r.error}</span> : null) },
  ];
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <Button size="sm" onClick={reload}>Refresh</Button>
      </div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && <DataTable columns={cols} rows={data} rowKey={(r) => r.id} empty={<EmptyState title="No job runs yet" description="Jobs started from the dashboard or n8n appear here." />} />}
    </div>
  );
}

function AuditTab() {
  const { data, error, loading, reload } = useProjectApi<AuditLog[]>('/audit-logs', { limit: 200 });
  const cols: Column<AuditLog>[] = [
    { key: 'at', header: 'Time', sort: (r) => r.created_at, render: (r) => <span className="text-xs whitespace-nowrap">{fmtDateTime(r.created_at)}</span> },
    { key: 'actor', header: 'Actor', sort: (r) => r.actor_label, render: (r) => <span className="text-xs">{r.actor_label ?? r.actor_type}</span> },
    { key: 'action', header: 'Action', sort: (r) => r.action, render: (r) => <span className="font-mono text-xs">{r.action}</span> },
    { key: 'entity', header: 'Entity', render: (r) => <span className="text-xs text-gray-600">{r.entity_type ? `${r.entity_type} ${r.entity_id?.slice(0, 8) ?? ''}` : '—'}</span> },
    { key: 'ip', header: 'IP', render: (r) => <span className="text-xs text-gray-500">{r.ip ?? '—'}</span> },
  ];
  return (
    <div>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && <DataTable columns={cols} rows={data} rowKey={(r) => String(r.id)} dense expand={(r) => <JsonView value={r.details} />} empty={<EmptyState title="No audit entries" />} />}
    </div>
  );
}

const TABS: { id: TabId; label: string }[] = [
  { id: 'profile', label: 'Business profile' },
  { id: 'rules', label: 'SEO rules' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'deployment', label: 'Deployment' },
  { id: 'automation', label: 'Automation' },
  { id: 'thresholds', label: 'Thresholds & alerts' },
  { id: 'members', label: 'Members' },
  { id: 'users', label: 'Users' },
  { id: 'apikeys', label: 'API keys' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'audit', label: 'Audit log' },
];

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const initial = (params.get('tab') as TabId | null) ?? (params.get('google') ? 'integrations' : 'profile');
  const [tab, setTab] = useState<TabId>(TABS.some((t) => t.id === initial) ? initial : 'profile');
  const change = (t: TabId) => {
    setTab(t);
    const next = new URLSearchParams(params);
    next.set('tab', t);
    next.delete('google');
    setParams(next, { replace: true });
  };
  return (
    <div>
      <PageHeader title="Settings" description="Project configuration, integrations, access control and operational logs." />
      <Tabs tabs={TABS} value={tab} onChange={change} />
      {tab === 'profile' && <ProfileTab />}
      {tab === 'rules' && <RulesTab />}
      {tab === 'integrations' && <IntegrationsTab />}
      {tab === 'deployment' && <DeploymentTab />}
      {tab === 'automation' && <AutomationTab />}
      {tab === 'thresholds' && <ThresholdsTab />}
      {tab === 'members' && <MembersTab />}
      {tab === 'users' && <UsersTab />}
      {tab === 'apikeys' && <ApiKeysTab />}
      {tab === 'jobs' && <JobsTab />}
      {tab === 'audit' && <AuditTab />}
    </div>
  );
}
