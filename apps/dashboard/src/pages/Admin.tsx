import { useState } from 'react';
import { api } from '../api/client';
import type { AdminOverview } from '../api/types';
import { useAuth } from '../context/auth';
import { useApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { fmtDateTime, fmtNum, fmtUsd, humanize } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Loading, Stat } from '../components/ui';
import { Pill } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { DataTable, type Column } from '../components/DataTable';

const FLAG_STATES = ['disabled', 'internal', 'beta', 'orgs', 'public'] as const;

export function AdminPage() {
  const { isPlatformAdmin } = useAuth();
  const { busy, run } = useAction();
  const { data, error, loading, reload } = useApi<AdminOverview>(isPlatformAdmin ? '/api/admin/overview' : null);
  const [flag, setFlag] = useState({ key: '', state: 'beta' as (typeof FLAG_STATES)[number], description: '' });
  if (!isPlatformAdmin) return <EmptyState title="Platform administrators only" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return loading ? <Loading /> : null;
  const updateOrg = (id: string, body: Record<string, unknown>) => run(id, () => api(`/api/admin/orgs/${id}`, { method: 'PATCH', body }), 'Organization updated').then((r) => r && reload());
  const cols: Column<AdminOverview['orgs'][number]>[] = [
    { key: 'name', header: 'Organization', sort: (r) => r.name, render: (r) => (<span><span className="font-medium text-gray-900">{r.name}</span>{r.is_internal && <Pill tone="gray" className="ml-1">internal</Pill>}{r.is_demo && <Pill tone="violet" className="ml-1">demo</Pill>}</span>) },
    { key: 'plan', header: 'Plan', render: (r) => (<select className="input h-7 text-xs" value={r.plan_id} disabled={busy === r.id} onChange={(e) => updateOrg(r.id, { planId: e.target.value })}>{data.plans.map((p) => <option key={p} value={p}>{p}</option>)}</select>) },
    { key: 'billing', header: 'Billing', render: (r) => <span className="text-xs">{humanize(r.billing_status)}</span> },
    { key: 'status', header: 'Status', render: (r) => (<Button size="sm" variant={r.status === 'active' ? 'ghost' : 'danger'} onClick={() => updateOrg(r.id, { status: r.status === 'active' ? 'suspended' : 'active' })}>{r.status === 'active' ? 'Active' : 'Suspended'}</Button>) },
    { key: 'projects', header: 'Projects', align: 'right', sort: (r) => r.projects, render: (r) => r.projects },
    { key: 'users', header: 'Users', align: 'right', sort: (r) => r.users, render: (r) => r.users },
    { key: 'ai', header: 'AI cost (month)', align: 'right', sort: (r) => r.ai_cost_month, render: (r) => fmtUsd(r.ai_cost_month) },
    { key: 'pages', header: 'Pages crawled (month)', align: 'right', sort: (r) => r.pages_crawled_month, render: (r) => fmtNum(r.pages_crawled_month) },
    { key: 'created', header: 'Created', sort: (r) => r.created_at, render: (r) => <span className="text-xs">{fmtDateTime(r.created_at)}</span> },
  ];
  const t = data.totals;
  return (
    <div>
      <PageHeader title="Platform admin" description="Organizations, usage, costs, reliability and security across the whole installation." />
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Stat label="Organizations" value={t.organizations} />
          <Stat label="Users" value={t.users} />
          <Stat label="Projects" value={t.projects} />
          <Stat label="AI cost (month)" value={fmtUsd(t.ai_cost_month)} />
          <Stat label="Crawls (24h)" value={t.crawls_24h} />
          <Stat label="Failed jobs (24h)" value={t.failed_jobs_24h} />
          <Stat label="Deploy failures (7d)" value={t.deployment_failures_7d} />
          <Stat label="Failed logins (24h)" value={t.failed_logins_24h} />
        </div>
        <Card title="Organizations" bodyClassName="p-0">
          <DataTable className="rounded-none border-0" columns={cols} rows={data.orgs} rowKey={(r) => r.id} maxHeight="480px" />
        </Card>
        <div className="grid gap-5 xl:grid-cols-2">
          <Card title="Feature flags" subtitle="disabled · internal (internal orgs) · beta (internal + beta orgs) · orgs (selected) · public" bodyClassName="p-0">
            <form onSubmit={(e) => { e.preventDefault(); run('flag', () => api(`/api/admin/feature-flags/${flag.key}`, { method: 'PUT', body: { state: flag.state, description: flag.description || undefined } }), 'Flag saved').then((r) => { if (r) { setFlag({ key: '', state: 'beta', description: '' }); reload(); } }); }} className="flex flex-wrap items-end gap-2 border-b border-gray-100 px-4 py-3">
              <input className="input w-40" required pattern="[a-z0-9_.-]{2,60}" placeholder="flag-key" value={flag.key} onChange={(e) => setFlag({ ...flag, key: e.target.value })} />
              <select className="input" value={flag.state} onChange={(e) => setFlag({ ...flag, state: e.target.value as typeof flag.state })}>{FLAG_STATES.map((s) => <option key={s}>{s}</option>)}</select>
              <input className="input flex-1" placeholder="Description" value={flag.description} onChange={(e) => setFlag({ ...flag, description: e.target.value })} />
              <Button type="submit" size="sm" variant="primary" loading={busy === 'flag'}>Save</Button>
            </form>
            <ul className="divide-y divide-gray-100">
              {data.flags.map((f) => (
                <li key={f.key} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <code className="flex-1">{f.key}</code>
                  <span className="text-xs text-gray-500">{f.description}</span>
                  <select className="input h-7 text-xs" value={f.state} onChange={(e) => run(f.key, () => api(`/api/admin/feature-flags/${f.key}`, { method: 'PUT', body: { state: e.target.value, orgIds: f.org_ids } }), 'Flag updated').then((r) => r && reload())}>{FLAG_STATES.map((s) => <option key={s}>{s}</option>)}</select>
                </li>
              ))}
              {!data.flags.length && <li className="px-4 py-3 text-sm text-gray-500">No flags defined – features without a flag are on.</li>}
            </ul>
          </Card>
          <Card title="Security events" bodyClassName="p-0">
            <ul className="max-h-80 divide-y divide-gray-100 overflow-auto text-xs">
              {data.securityEvents.map((e, i) => <li key={i} className="flex gap-2 px-4 py-1.5"><code>{e.action}</code><span className="text-gray-600">{e.actor_label}</span><span className="text-gray-400">{e.ip}</span><span className="ml-auto text-gray-400">{fmtDateTime(e.created_at)}</span></li>)}
            </ul>
          </Card>
        </div>
        <Card title="Recent failed jobs" bodyClassName="p-0">
          <ul className="divide-y divide-gray-100 text-xs">
            {data.failedJobs.map((j) => <li key={j.id} className="flex gap-2 px-4 py-1.5"><code>{j.job_type}</code><span className="text-gray-600">{j.project}</span><span className="text-red-700">{j.error}</span><span className="ml-auto text-gray-400">{fmtDateTime(j.created_at)}</span></li>)}
            {!data.failedJobs.length && <li className="px-4 py-3 text-gray-500">No failures.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}
