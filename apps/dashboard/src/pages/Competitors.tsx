import { useMemo, useState, type FormEvent } from 'react';
import { Info, Plus, Trash2 } from 'lucide-react';
import { api } from '../api/client';
import type { ComparisonResponse, Competitor } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { fmtNum, fmtRelative, humanize } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Field, Loading } from '../components/ui';
import { JobButton } from '../components/JobButton';
import { EmptyState } from '../components/EmptyState';
import { Pill } from '../components/Badges';

function AddCompetitor({ onAdded }: { onAdded: () => void }) {
  const { base } = useProject();
  const { busy, run } = useAction();
  const [form, setForm] = useState({ name: '', baseUrl: '', maxPages: 40 });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run('add', () => api(`${base}/competitors`, { body: { name: form.name, baseUrl: form.baseUrl, maxPages: Number(form.maxPages) } }), 'Competitor added – run Analyze to crawl its structure');
    if (r) {
      setForm({ name: '', baseUrl: '', maxPages: 40 });
      onAdded();
    }
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <Field label="Name" className="min-w-40 flex-1">
        <input className="input w-full" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Competitor name" />
      </Field>
      <Field label="Website URL" className="min-w-56 flex-[2]">
        <input className="input w-full" required value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} placeholder="https://example.com" />
      </Field>
      <Field label="Max pages" className="w-24">
        <input className="input w-full" type="number" min={1} max={200} value={form.maxPages} onChange={(e) => setForm({ ...form, maxPages: Number(e.target.value) })} />
      </Field>
      <Button type="submit" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={busy === 'add'}>
        Add competitor
      </Button>
    </form>
  );
}

export function CompetitorsPage() {
  const { canEdit } = useAuth();
  const { base } = useProject();
  const { busy, run } = useAction();
  const list = useProjectApi<Competitor[]>('/competitors');
  const cmp = useProjectApi<ComparisonResponse>('/competitors/comparison');
  const reloadAll = () => {
    list.reload();
    cmp.reload();
  };
  const grouped = useMemo(() => {
    const m = new Map<string, ComparisonResponse['rows']>();
    for (const r of cmp.data?.rows ?? []) m.set(r.dimension, [...(m.get(r.dimension) ?? []), r]);
    return [...m.entries()];
  }, [cmp.data]);

  return (
    <div>
      <PageHeader title="Competitors" description="Competitors you configure are crawled for structure only (titles, headings, page types) to find coverage gaps." actions={<JobButton type="competitor-analyze" label="Analyze all" onDone={reloadAll} />} />
      <div className="space-y-5">
        {canEdit && (
          <Card title="Add a competitor">
            <AddCompetitor onAdded={list.reload} />
          </Card>
        )}
        <Card title="Tracked competitors" bodyClassName="p-0">
          {list.error && <div className="p-4"><ErrorBox error={list.error} onRetry={list.reload} /></div>}
          {!list.data && list.loading && <Loading />}
          {list.data && !list.data.length && <div className="p-4"><EmptyState compact title="No competitors yet" description="Add the websites you compete with for the same services and locations." /></div>}
          {list.data && list.data.length > 0 && (
            <ul className="divide-y divide-gray-100">
              {list.data.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 font-medium text-gray-900">
                      {c.name} {!c.is_active && <Pill>Inactive</Pill>}
                    </div>
                    <div className="text-xs text-gray-500">
                      <a href={c.base_url} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">{c.base_url}</a> · {fmtNum(c.pages)} pages crawled (max {c.max_pages}) · last crawled {fmtRelative(c.last_crawled_at)}
                    </div>
                    {c.notes && <div className="text-xs text-gray-500">{c.notes}</div>}
                    {c.last_error && <div className="mt-1 text-xs text-red-700">Last error: {c.last_error}</div>}
                  </div>
                  <JobButton type="competitor-analyze" body={{ competitorId: c.id }} label="Analyze" size="sm" onDone={reloadAll} />
                  {canEdit && (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      loading={busy === c.id}
                      onClick={() => {
                        if (window.confirm(`Remove ${c.name} and its crawled structure?`)) run(c.id, () => api(`${base}/competitors/${c.id}`, { method: 'DELETE' }), 'Competitor removed').then((r) => r && reloadAll());
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Coverage comparison" subtitle={cmp.data ? `Phoenixx IT: ${cmp.data.phoenixx.pages} pages, avg ${fmtNum(cmp.data.phoenixx.avgWords)} words · ${cmp.data.competitors.map((c) => `${c.name}: ${c.pages} pages, avg ${fmtNum(c.avgWords)} words`).join(' · ')}` : undefined} bodyClassName="p-0">
          {cmp.data?.note && (
            <p className="flex items-center gap-1.5 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-600">
              <Info className="h-3.5 w-3.5" /> {cmp.data.note}
            </p>
          )}
          {cmp.error && <div className="p-4"><ErrorBox error={cmp.error} onRetry={cmp.reload} /></div>}
          {!cmp.data && cmp.loading && <Loading />}
          {cmp.data && !cmp.data.rows.length && <p className="p-4 text-sm text-gray-500">No comparison yet – analyze at least one competitor.</p>}
          {grouped.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50 text-xs text-gray-500">
                    <th className="px-4 py-2 text-left font-medium">Item</th>
                    <th className="px-4 py-2 text-left font-medium">Phoenixx IT has</th>
                    <th className="px-4 py-2 text-left font-medium">Competitor has</th>
                    <th className="px-4 py-2 text-left font-medium">Opportunity</th>
                  </tr>
                </thead>
                {grouped.map(([dim, rows]) => (
                  <tbody key={dim}>
                    <tr>
                      <td colSpan={4} className="border-b border-gray-200 bg-gray-50/60 px-4 py-1.5 text-[11px] font-semibold tracking-wider text-gray-500 uppercase">
                        {humanize(dim)}
                      </td>
                    </tr>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-b border-gray-100 align-top">
                        <td className="px-4 py-2.5 font-medium text-gray-900">{r.item}</td>
                        <td className="px-4 py-2.5">{r.phoenixxHas === 'Not covered' ? <Pill tone="amber">Not covered</Pill> : <span className="text-gray-700">{r.phoenixxHas}</span>}</td>
                        <td className="px-4 py-2.5 text-xs text-gray-700">
                          {r.competitorsHave.map((c, j) => (
                            <div key={j}>
                              <span className="font-medium">{c.name}:</span> {c.evidence}
                            </div>
                          ))}
                        </td>
                        <td className="px-4 py-2.5 text-xs text-gray-700">{r.opportunity}</td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
