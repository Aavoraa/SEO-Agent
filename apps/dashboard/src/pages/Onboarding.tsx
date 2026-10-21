import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Circle, Globe, PlugZap, Search } from 'lucide-react';
import { api } from '../api/client';
import type { Detection, OnboardingStatus, Opportunity } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, humanize } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, Field, Loading } from '../components/ui';
import { Pill } from '../components/Badges';
import { JobButton } from '../components/JobButton';
import { OpportunityCard } from '../components/Opportunity';

const PROJECT_KEY = 'phoenixx.seo.project';

export function DetectionSummary({ d }: { d: Detection }) {
  const row = (label: string, value: React.ReactNode) => (
    <div className="contents">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-1.5 text-sm">
        {row('Website', <a href={d.url} target="_blank" rel="noopener noreferrer" className="hover:underline">{d.url}</a>)}
        {row('CMS', d.cms ?? 'None detected')}
        {row('Framework', d.framework ?? (d.rendering === 'static-html' ? 'Static HTML' : '—'))}
        {row('Rendering', `${humanize(d.rendering)} – ${d.renderingNote}`)}
        {row('Server', d.server ?? 'Not disclosed')}
        {row('CDN', d.cdn.length ? d.cdn.join(', ') : 'None visible')}
        {row('SEO plugins', d.seoPlugins.length ? d.seoPlugins.join(', ') : 'None detected')}
        {row('Analytics', [...d.analytics.ga4, ...d.analytics.gtm].join(', ') || 'None detected')}
        {row('robots.txt', d.robots.found ? (d.robots.blocksAll ? <span className="text-red-700">Blocks all crawlers</span> : 'Found') : 'Missing')}
        {row('Sitemap', d.sitemap.found ? d.sitemap.url : 'Not found')}
        {row('Structured data', d.schemaTypes.join(', ') || 'None valid')}
      </dl>
      <div>
        <div className="mb-1.5 text-xs font-semibold tracking-wide text-gray-500 uppercase">How to connect this site</div>
        <ul className="space-y-1.5">
          {d.connectionOptions.map((o, i) => (
            <li key={`${o.method}-${i}`} className={cx('rounded-md border px-3 py-2 text-sm', i === 0 ? 'border-brand-200 bg-brand-50/50' : 'border-gray-200')}>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="text-gray-900">{o.label}</strong>
                {i === 0 && <Pill tone="brand">Recommended</Pill>}
                {!o.available && <Pill tone="gray">Coming soon</Pill>}
                <span className="text-xs text-gray-500">{o.handles.join(' + ')} changes</span>
              </div>
              <p className="text-xs text-gray-600">{o.reason}</p>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11px] text-gray-400">{d.hostingNote}</p>
      </div>
    </div>
  );
}

function Checklist({ projectId }: { projectId: string }) {
  const s = useApi<OnboardingStatus>(`/api/projects/${projectId}/onboarding`);
  const opps = useApi<{ items: Opportunity[] }>(`/api/projects/${projectId}/opportunities`, { limit: 10 });
  const reload = () => {
    s.reload();
    opps.reload();
  };
  if (!s.data) return <Loading />;
  return (
    <div className="space-y-5">
      <Card title="Set-up checklist" bodyClassName="p-0">
        <ul className="divide-y divide-gray-100">
          {s.data.steps.map((st) => (
            <li key={st.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              {st.done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <Circle className="h-4 w-4 text-gray-300" />}
              <span className={cx('flex-1', st.done ? 'text-gray-500' : 'text-gray-900')}>
                {st.label} {st.optional && <span className="text-xs text-gray-400">(optional)</span>}
              </span>
              {!st.done && st.id === 'audit' && <JobButton type="seo-audit" body={{ device: 'desktop' }} label="Run baseline audit" variant="primary" size="sm" onDone={reload} />}
              {!st.done && st.href && st.id !== 'audit' && <Link to={st.href} className="text-xs font-medium text-brand-700 hover:underline">Set up →</Link>}
            </li>
          ))}
        </ul>
      </Card>
      {opps.data && opps.data.items.length > 0 && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-900">Your first {Math.min(10, opps.data.items.length)} opportunities</h2>
            <Link to="/" className="ml-auto text-xs font-medium text-brand-700 hover:underline">Go to Command Center →</Link>
          </div>
          <div className="space-y-2">{opps.data.items.map((o) => <OpportunityCard key={o.id} o={o} compact />)}</div>
        </section>
      )}
    </div>
  );
}

export function OnboardingPage() {
  const { organizations, isPlatformAdmin } = useAuth();
  const { projectId } = useProject();
  const { busy, run } = useAction();
  const creatable = organizations.filter((o) => ['owner', 'admin', 'manager'].includes(o.role));
  const [orgId, setOrgId] = useState(creatable[0]?.id ?? '');
  const [url, setUrl] = useState('');
  const [detection, setDetection] = useState<Detection | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const detect = (e: FormEvent) => {
    e.preventDefault();
    setDetection(null);
    run('detect', () => api<Detection>('/api/onboarding/detect', { body: { url } })).then((d) => d && setDetection(d));
  };
  const create = () =>
    run('create', () => api<{ project: { id: string } }>('/api/onboarding/projects', { body: { organizationId: orgId, url: detection?.url ?? url } }), 'Website added').then((r) => {
      if (!r) return;
      try {
        localStorage.setItem(PROJECT_KEY, r.project.id);
      } catch {
        /* ignore */
      }
      setCreated(r.project.id);
      // Reload so the project switcher and permissions pick up the new project.
      window.location.assign('/onboarding?done=1');
    });

  const done = new URLSearchParams(window.location.search).get('done') === '1';
  return (
    <div>
      <PageHeader title="Add a website" description="We detect the technology, recommend how to connect it, run a baseline audit and show your first opportunities." />
      <div className="space-y-5">
        {done && projectId && !created ? (
          <Checklist projectId={projectId} />
        ) : (
          <>
            {!creatable.length && !isPlatformAdmin ? (
              <Card><p className="text-sm text-gray-600">Your role can't add websites. Ask an owner or admin of your organization.</p></Card>
            ) : (
              <Card title={<span className="flex items-center gap-2"><Globe className="h-4 w-4 text-gray-400" /> Website</span>}>
                <form onSubmit={detect} className="flex flex-wrap items-end gap-3">
                  {creatable.length > 1 && (
                    <Field label="Organization">
                      <select className="input" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                        {creatable.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </Field>
                  )}
                  <Field label="Website address" className="min-w-72 flex-1">
                    <input className="input w-full" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
                  </Field>
                  <Button type="submit" icon={<Search className="h-3.5 w-3.5" />} loading={busy === 'detect'}>Detect</Button>
                </form>
                <p className="mt-2 text-xs text-gray-500">Read-only: we load your homepage, robots.txt and sitemap like a search engine would. Nothing is changed.</p>
              </Card>
            )}
            {detection && (
              <Card title="What we found" actions={<Button variant="primary" icon={<PlugZap className="h-3.5 w-3.5" />} loading={busy === 'create'} disabled={!orgId} onClick={create}>Add this website</Button>}>
                <DetectionSummary d={detection} />
              </Card>
            )}
          </>
        )}
      </div>
    </div>
  );
}
