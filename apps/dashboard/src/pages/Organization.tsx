import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Send, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import { ORG_ROLE_LABEL, type ApiKeyRow, type OrgDetail, type OrgInvitation, type OrgMember, type OrgRole, type WebhookDelivery, type WebhookEndpoint } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { cx, fmtDateTime, fmtRelative, humanize } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Field, Loading, Tabs } from '../components/ui';
import { Pill } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { Modal } from '../components/Overlay';
import { CodeBlock, CopyButton } from '../components/CodeBlock';

type Tab = 'overview' | 'members' | 'webhooks' | 'apikeys' | 'branding';
const ROLES = Object.keys(ORG_ROLE_LABEL) as OrgRole[];
const ROLE_HELP: Record<OrgRole, string> = {
  owner: 'Everything, including billing and owners',
  admin: 'Members, projects, settings, high-risk approvals',
  manager: 'Projects and high-risk approvals',
  seo_specialist: 'Run analyses, approve low/medium changes',
  content_editor: 'Content work, approve low/medium changes',
  developer: 'Deployments, webhooks, API keys',
  viewer: 'Read-only',
  client: 'Read-only client view',
};

function Usage({ org }: { org: OrgDetail }) {
  if (!org.usage) return <p className="text-sm text-gray-500">Your role can't see usage.</p>;
  return (
    <div className="space-y-2">
      {org.usage.items.map((i) => {
        const pct = i.limit ? Math.min(100, (i.used / i.limit) * 100) : 0;
        return (
          <div key={i.key} className="grid grid-cols-[minmax(160px,220px)_1fr_120px] items-center gap-3 text-sm">
            <span className="text-gray-700">{i.label}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-gray-100">{i.limit !== null && <span className={cx('block h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-brand-500')} style={{ width: `${Math.max(2, pct)}%` }} />}</span>
            <span className="text-right text-xs tabular text-gray-600">{i.used}{i.limit !== null ? ` / ${i.limit}` : ' · unlimited'}</span>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1.5 pt-2">
        {Object.entries(org.entitlements.features).map(([k, v]) => <Pill key={k} tone={v ? 'green' : 'gray'}>{humanize(k.replace(/([A-Z])/g, ' $1'))}{v ? '' : ' – not in plan'}</Pill>)}
      </div>
    </div>
  );
}

function Members({ orgId }: { orgId: string }) {
  const { user } = useAuth();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useApi<{ members: OrgMember[]; invitations: OrgInvitation[] }>(`/api/orgs/${orgId}/members`);
  const [form, setForm] = useState({ email: '', role: 'seo_specialist' as OrgRole });
  const [link, setLink] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return loading ? <Loading /> : null;
  const invite = (e: FormEvent) => {
    e.preventDefault();
    run('invite', () => api<{ url: string }>(`/api/orgs/${orgId}/invitations`, { body: form })).then((r) => {
      if (r) {
        setLink(r.url);
        setForm({ ...form, email: '' });
        reload();
      }
    });
  };
  return (
    <div className="space-y-5">
      <Card title="Invite a teammate or client" subtitle="Invitations are valid for 7 days. Share the link with the person you invite.">
        <form onSubmit={invite} className="flex flex-wrap items-end gap-3">
          <Field label="Email"><input className="input w-64" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Role">
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as OrgRole })}>
              {ROLES.map((r) => <option key={r} value={r}>{ORG_ROLE_LABEL[r]} – {ROLE_HELP[r]}</option>)}
            </select>
          </Field>
          <Button type="submit" variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={busy === 'invite'}>Create invitation</Button>
        </form>
        {link && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs">
            <span className="font-mono break-all">{link}</span>
            <CopyButton text={link} label="Copy link" />
          </div>
        )}
      </Card>
      <Card title="Members" bodyClassName="p-0">
        <ul className="divide-y divide-gray-100">
          {data.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
              <span className="min-w-0 flex-1"><span className="font-medium text-gray-900">{m.name}</span> <span className="text-gray-500">{m.email}</span></span>
              <select className="input h-8" value={m.role} disabled={m.userId === user?.id || busy === m.userId} onChange={(e) => run(m.userId, () => api(`/api/orgs/${orgId}/members/${m.userId}`, { method: 'PATCH', body: { role: e.target.value } }), 'Role updated').then((r) => r && reload())} aria-label={`Role for ${m.email}`}>
                {ROLES.map((r) => <option key={r} value={r}>{ORG_ROLE_LABEL[r]}</option>)}
              </select>
              {m.userId !== user?.id && (
                <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => window.confirm(`Remove ${m.email} from the organization?`) && run(`rm-${m.userId}`, () => api(`/api/orgs/${orgId}/members/${m.userId}`, { method: 'DELETE' }), 'Member removed').then((r) => r && reload())}>
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {data.invitations.length > 0 && (
        <Card title="Pending invitations" bodyClassName="p-0">
          <ul className="divide-y divide-gray-100">
            {data.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                <span className="flex-1">{i.email} · {ORG_ROLE_LABEL[i.role]}</span>
                <span className="text-xs text-gray-500">expires {fmtRelative(i.expiresAt)}</span>
                <Button size="sm" variant="ghost" onClick={() => run(`inv-${i.id}`, () => api(`/api/orgs/${orgId}/invitations/${i.id}`, { method: 'DELETE' }), 'Invitation revoked').then((r) => r && reload())}>Revoke</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Webhooks({ orgId, enabled }: { orgId: string; enabled: boolean }) {
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useApi<{ endpoints: WebhookEndpoint[]; deliveries: WebhookDelivery[]; events: string[] }>(enabled ? `/api/orgs/${orgId}/webhooks` : null);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['audit.completed', 'approval.required', 'deployment.failed', 'alert.created']);
  const [secret, setSecret] = useState<string | null>(null);
  if (!enabled) return <EmptyState title="Webhooks are not included in your plan" description="Upgrade to send signed events to your own systems (Slack bots, BI, CRMs)." />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return loading ? <Loading /> : null;
  const create = (e: FormEvent) => {
    e.preventDefault();
    run('create', () => api<{ secret: string }>(`/api/orgs/${orgId}/webhooks`, { body: { url, events } })).then((r) => {
      if (r) {
        setSecret(r.secret);
        setUrl('');
        reload();
      }
    });
  };
  return (
    <div className="space-y-5">
      <Card title="Add endpoint" subtitle="Each delivery is signed: x-webhook-signature: t=<unix>,v1=HMAC-SHA256(secret, '<t>.<body>'). Reject signatures older than 5 minutes.">
        <form onSubmit={create} className="space-y-3">
          <Field label="HTTPS URL"><input className="input w-full" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/seo" /></Field>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {data.events.map((ev) => (
              <label key={ev} className="flex items-center gap-1.5 text-xs text-gray-700">
                <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
                <code>{ev}</code>
              </label>
            ))}
          </div>
          <Button type="submit" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={busy === 'create'} disabled={!events.length}>Add endpoint</Button>
        </form>
      </Card>
      <Card title="Endpoints" bodyClassName="p-0">
        {!data.endpoints.length ? (
          <p className="px-4 py-3 text-sm text-gray-500">No endpoints yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {data.endpoints.map((w) => (
              <li key={w.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs">{w.url}</span>
                  <span className="text-[11px] text-gray-500">{w.events.join(', ')}</span>
                </span>
                <Pill tone={w.active ? 'green' : 'red'}>{w.active ? 'Active' : `Disabled after ${w.failures} failures`}</Pill>
                <span className="text-xs text-gray-500">{w.last_delivery_at ? `last ${fmtRelative(w.last_delivery_at)}` : 'no deliveries'}</span>
                <Button size="sm" onClick={() => run(`t-${w.id}`, () => api<{ success: boolean; error: string | null }>(`/api/orgs/${orgId}/webhooks/${w.id}/test`, { method: 'POST' }), (r) => (r.success ? 'Test delivered' : `Test failed: ${r.error}`)).then(() => reload())}>Send test</Button>
                <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => window.confirm('Delete this endpoint?') && run(`d-${w.id}`, () => api(`/api/orgs/${orgId}/webhooks/${w.id}`, { method: 'DELETE' }), 'Endpoint deleted').then((r) => r && reload())} />
              </li>
            ))}
          </ul>
        )}
      </Card>
      {data.deliveries.length > 0 && (
        <Card title="Recent deliveries" bodyClassName="p-0">
          <ul className="max-h-80 divide-y divide-gray-100 overflow-auto text-xs">
            {data.deliveries.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-4 py-1.5">
                <Pill tone={d.success ? 'green' : 'red'}>{d.status_code ?? 'ERR'}</Pill>
                <code>{d.event}</code>
                <span className="text-gray-500">{d.error}</span>
                <span className="ml-auto text-gray-400">{d.duration_ms} ms · {fmtDateTime(d.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Modal open={!!secret} onClose={() => setSecret(null)} title="Signing secret" footer={<Button variant="primary" onClick={() => setSecret(null)}>I have stored it</Button>}>
        {secret && (<div className="space-y-2 text-sm"><p className="text-amber-800">Shown only once. Store it in your receiver's configuration.</p><CodeBlock code={secret} /></div>)}
      </Modal>
    </div>
  );
}

function ApiKeys({ orgId, enabled }: { orgId: string; enabled: boolean }) {
  const { busy, run } = useAction();
  const { projects } = useProject();
  const { data, reload } = useApi<ApiKeyRow[]>(enabled ? `/api/orgs/${orgId}/api-keys` : null);
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [key, setKey] = useState<string | null>(null);
  if (!enabled) return <EmptyState title="API access is not included in your plan" />;
  return (
    <div className="space-y-5">
      <Card title="Create API key" subtitle="Keys only reach this organization (optionally one project). Service keys can run jobs but never approve changes.">
        <form onSubmit={(e) => { e.preventDefault(); run('create', () => api<{ key: string }>(`/api/orgs/${orgId}/api-keys`, { body: { name, role: 'service', ...(projectId ? { projectId } : {}) } })).then((r) => { if (r) { setKey(r.key); setName(''); reload(); } }); }} className="flex flex-wrap items-end gap-3">
          <Field label="Name"><input className="input w-56" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Reporting pipeline" /></Field>
          <Field label="Project">
            <select className="input" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects in the organization</option>
              {projects.filter((p) => p.organization_id === orgId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Button type="submit" variant="primary" loading={busy === 'create'}>Create key</Button>
        </form>
      </Card>
      <Card title="Keys" bodyClassName="p-0">
        <ul className="divide-y divide-gray-100">
          {(data ?? []).map((k) => (
            <li key={k.id} className="flex items-center gap-3 px-4 py-2 text-sm">
              <span className="flex-1 font-medium">{k.name}</span>
              <span className="text-xs text-gray-500">{k.project_id ? projects.find((p) => p.id === k.project_id)?.name ?? 'one project' : 'all projects'} · used {fmtRelative(k.last_used_at)}</span>
              {k.revoked_at ? <Pill tone="red">Revoked</Pill> : <Button size="sm" variant="danger" onClick={() => run(k.id, () => api(`/api/orgs/${orgId}/api-keys/${k.id}`, { method: 'DELETE' }), 'Key revoked').then((r) => r && reload())}>Revoke</Button>}
            </li>
          ))}
          {!data?.length && <li className="px-4 py-3 text-sm text-gray-500">No keys yet.</li>}
        </ul>
      </Card>
      <Modal open={!!key} onClose={() => setKey(null)} title="API key" footer={<Button variant="primary" onClick={() => setKey(null)}>I have stored the key</Button>}>
        {key && <div className="space-y-2 text-sm"><p className="text-amber-800">Shown only once. Send it as the x-api-key header.</p><CodeBlock code={key} /></div>}
      </Modal>
    </div>
  );
}

function Branding({ org, onSaved }: { org: OrgDetail; onSaved: () => void }) {
  const { busy, run } = useAction();
  const [b, setB] = useState({ name: '', logoUrl: '', primaryColor: '', reportFooter: '', ...org.branding });
  const enabled = !!org.entitlements.features.whiteLabel;
  const save = (e: FormEvent) => {
    e.preventDefault();
    const branding = Object.fromEntries(Object.entries(b).filter(([, v]) => v));
    run('save', () => api(`/api/orgs/${org.id}`, { method: 'PATCH', body: { branding } }), 'Branding saved').then((r) => r && onSaved());
  };
  return (
    <Card title="White-label branding" subtitle={enabled ? 'Shown to your team and clients in the app and on reports.' : 'Not included in your plan (Agency and above).'}>
      <form onSubmit={save} className="grid gap-3 md:grid-cols-2">
        <Field label="Product name"><input className="input w-full" disabled={!enabled} value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></Field>
        <Field label="Logo URL (https)"><input className="input w-full" disabled={!enabled} value={b.logoUrl} onChange={(e) => setB({ ...b, logoUrl: e.target.value })} /></Field>
        <Field label="Primary colour"><input className="input w-full" disabled={!enabled} value={b.primaryColor} onChange={(e) => setB({ ...b, primaryColor: e.target.value })} placeholder="#1f2937" /></Field>
        <Field label="Report footer"><input className="input w-full" disabled={!enabled} value={b.reportFooter} onChange={(e) => setB({ ...b, reportFooter: e.target.value })} /></Field>
        <div><Button type="submit" variant="primary" disabled={!enabled} loading={busy === 'save'}>Save branding</Button></div>
      </form>
    </Card>
  );
}

export function OrganizationPage() {
  const { organizations, reloadMe } = useAuth();
  const { projects, projectId } = useProject();
  const currentOrg = projects.find((p) => p.id === projectId)?.organization_id ?? organizations[0]?.id ?? '';
  const [orgId, setOrgId] = useState(currentOrg);
  useEffect(() => {
    if (!orgId && currentOrg) setOrgId(currentOrg);
  }, [orgId, currentOrg]);
  const [tab, setTab] = useState<Tab>('overview');
  const { data, error, loading, reload } = useApi<OrgDetail>(orgId ? `/api/orgs/${orgId}` : null);
  const myRole = organizations.find((o) => o.id === orgId)?.role;
  const [newOrg, setNewOrg] = useState('');
  const { busy, run } = useAction();
  return (
    <div>
      <PageHeader
        title="Organization"
        description="Your team, plan, integrations for developers and white-label settings."
        actions={
          organizations.length > 1 && (
            <select className="input" value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Organization">
              {organizations.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )
        }
      />
      {!orgId && (
        <Card title="Create an organization">
          <form onSubmit={(e) => { e.preventDefault(); run('org', () => api<{ id: string }>('/api/orgs', { body: { name: newOrg } }), 'Organization created').then(async (r) => { if (r) { await reloadMe(); setOrgId(r.id); } }); }} className="flex gap-2">
            <input className="input w-64" required value={newOrg} onChange={(e) => setNewOrg(e.target.value)} placeholder="Company or agency name" />
            <Button type="submit" variant="primary" loading={busy === 'org'}>Create</Button>
          </form>
        </Card>
      )}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Plan & usage' }, { id: 'members', label: 'Members' }, { id: 'webhooks', label: 'Webhooks' }, { id: 'apikeys', label: 'API keys' }, { id: 'branding', label: 'Branding' }]} />
          {tab === 'overview' && (
            <div className="space-y-5">
              <Card title={`${data.name}`} subtitle={`${data.entitlements.planName} plan · ${humanize(data.billingStatus)}${myRole ? ` · you are ${ORG_ROLE_LABEL[myRole]}` : ''}`}>
                <Usage org={data} />
              </Card>
              <Card title={`Websites (${data.projects.length})`} actions={<Link to="/onboarding" className="text-sm font-medium text-brand-700 hover:underline">Add website</Link>} bodyClassName="p-0">
                <ul className="divide-y divide-gray-100">
                  {data.projects.map((p) => <li key={p.id} className="flex items-center gap-2 px-4 py-2 text-sm"><span className="flex-1 font-medium">{p.name}</span><span className="text-xs text-gray-500">{p.base_url}</span>{p.is_demo && <Pill tone="violet">DEMO</Pill>}</li>)}
                </ul>
              </Card>
              <p className="text-xs text-gray-500">Plans are changed by the platform team. Subscription billing (payment provider) is not connected in this installation.</p>
            </div>
          )}
          {tab === 'members' && <Members orgId={data.id} />}
          {tab === 'webhooks' && <Webhooks orgId={data.id} enabled={!!data.entitlements.features.webhooks} />}
          {tab === 'apikeys' && <ApiKeys orgId={data.id} enabled={!!data.entitlements.features.apiAccess} />}
          {tab === 'branding' && <Branding org={data} onSaved={reload} />}
        </>
      )}
    </div>
  );
}
