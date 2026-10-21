import { useMemo, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { LocalResponse, MatrixCell } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { cx, fmtNum, fmtPos, humanize, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Card, ErrorBox, KeyValues, Loading } from '../components/ui';
import { Pill, SeverityBadge, type Tone } from '../components/Badges';
import { CodeBlock } from '../components/CodeBlock';
import { JobButton } from '../components/JobButton';
import { Modal } from '../components/Overlay';

const actionTone: Record<string, Tone> = {
  optimize_existing_page: 'blue',
  add_location_section: 'amber',
  create_location_page: 'brand',
  monitor: 'gray',
  no_action: 'gray',
};

export function LocalSeoPage() {
  const { data, error, loading, reload } = useProjectApi<LocalResponse>('/local');
  const [cell, setCell] = useState<MatrixCell | null>(null);

  const { services, locations, byKey, maxImpr } = useMemo(() => {
    const m = data?.matrix ?? [];
    const services = [...new Map(m.map((c) => [c.serviceId, c.serviceName])).entries()];
    const locations = [...new Map(m.map((c) => [c.locationId, c.locationName])).entries()];
    return { services, locations, byKey: new Map(m.map((c) => [`${c.serviceId}|${c.locationId}`, c])), maxImpr: Math.max(1, ...m.map((c) => c.impressions)) };
  }, [data]);

  return (
    <div>
      <PageHeader title="Local SEO" description="NAP consistency, LocalBusiness schema and demand by service × location." actions={<JobButton type="local-seo" label="Run local SEO analysis" onDone={reload} />} />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="NAP (name, address, phone)" subtitle="From the business profile – keep identical on the website and Google Business Profile">
              <KeyValues
                items={[
                  { label: 'Name', value: data.nap.name },
                  { label: 'Address', value: data.nap.address ? [data.nap.address.streetAddress, data.nap.address.addressLocality, data.nap.address.addressRegion, data.nap.address.postalCode, data.nap.address.addressCountry].filter(Boolean).join(', ') : <span className="text-red-600">Missing</span> },
                  { label: 'Phone', value: data.nap.phone ?? <span className="text-red-600">Missing</span> },
                  { label: 'Email', value: data.nap.email ?? '—' },
                  { label: 'Phones found on site', value: data.nap.phonesFoundOnSite.length ? data.nap.phonesFoundOnSite.join(', ') : 'None detected' },
                  { label: 'Target locations', value: data.targetLocations.join(', ') || '—' },
                ]}
              />
              <p className="mt-4 rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
                <strong>Google Business Profile:</strong> {humanize(data.googleBusinessProfile.status)}. {data.googleBusinessProfile.note}
              </p>
            </Card>
            <Card
              title="LocalBusiness schema"
              actions={data.localSchema.present ? <Pill tone="green"><CheckCircle2 className="h-3 w-3" /> Present on site</Pill> : <Pill tone="amber"><XCircle className="h-3 w-3" /> Not present – suggestion below</Pill>}
            >
              {data.localSchema.validation && (
                <div className="mb-3 text-xs">
                  {data.localSchema.validation.valid ? (
                    <span className="text-emerald-700">Suggested JSON-LD validates · types: {data.localSchema.validation.types.join(', ')}</span>
                  ) : (
                    <ul className="list-disc pl-4 text-red-700">
                      {data.localSchema.validation.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                  {data.localSchema.validation.warnings.length > 0 && (
                    <ul className="mt-1 list-disc pl-4 text-amber-700">
                      {data.localSchema.validation.warnings.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {data.localSchema.suggested ? (
                <CodeBlock title="Suggested JSON-LD (review before adding)" code={`<script type="application/ld+json">\n${JSON.stringify(data.localSchema.suggested, null, 2)}\n</script>`} maxHeight="300px" />
              ) : (
                <p className="text-sm text-gray-500">Add an address to the business profile to generate a suggestion.</p>
              )}
            </Card>
          </div>

          <Card title="Service × location demand" subtitle="Search Console impressions for queries combining a service and a location. Click a cell for rationale and queries." bodyClassName="p-0">
            {services.length ? (
              <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <thead>
                    <tr>
                      <th className="sticky left-0 z-10 border-b border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-medium text-gray-500">Service</th>
                      {locations.map(([id, name]) => (
                        <th key={id} className="border-b border-gray-200 bg-gray-50 px-3 py-2 text-left text-xs font-medium whitespace-nowrap text-gray-500">
                          {name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {services.map(([sid, sname]) => (
                      <tr key={sid}>
                        <th className="sticky left-0 z-10 border-b border-gray-100 bg-white px-3 py-2 text-left text-sm font-medium whitespace-nowrap text-gray-900">{sname}</th>
                        {locations.map(([lid]) => {
                          const c = byKey.get(`${sid}|${lid}`);
                          if (!c) return <td key={lid} className="border-b border-gray-100 px-3 py-2 text-xs text-gray-300">—</td>;
                          const intensity = c.impressions / maxImpr;
                          return (
                            <td key={lid} className="border-b border-gray-100 p-1">
                              <button onClick={() => setCell(c)} className={cx('w-full min-w-32 rounded-md border px-2 py-1.5 text-left transition-colors hover:border-brand-500')} style={{ background: `rgba(232,93,4,${(0.04 + intensity * 0.22).toFixed(3)})`, borderColor: 'transparent' }}>
                                <div className="text-sm font-semibold tabular text-gray-900">{fmtNum(c.impressions)}</div>
                                <div className="text-[11px] text-gray-600">impr. · pos {fmtPos(c.avgPosition)}</div>
                                <Pill tone={actionTone[c.action] ?? 'gray'} className="mt-1">{humanize(c.action)}</Pill>
                              </button>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="p-4 text-sm text-gray-500">No service + location demand found yet. Connect Search Console and run the local SEO analysis.</p>
            )}
          </Card>

          <Card title={`Local issues (${data.issues.length})`} bodyClassName="p-0">
            {data.issues.length ? (
              <ul className="divide-y divide-gray-100">
                {data.issues.map((i) => (
                  <li key={i.id} className="flex items-start gap-3 px-4 py-2.5">
                    <SeverityBadge severity={i.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-gray-900">{i.title}</div>
                      <div className="text-xs text-gray-500">{i.description}</div>
                    </div>
                    <span className="font-mono text-xs text-gray-500">{pathOf(i.url)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-4 text-sm text-gray-500">No local issues detected.</p>
            )}
          </Card>
        </div>
      )}
      <Modal open={!!cell} onClose={() => setCell(null)} title={cell ? `${cell.serviceName} × ${cell.locationName}` : ''}>
        {cell && (
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-2">
              <Pill tone={actionTone[cell.action] ?? 'gray'}>{humanize(cell.action)}</Pill>
              <Pill>Score {Math.round(cell.score)}</Pill>
            </div>
            <KeyValues
              items={[
                { label: 'Impressions', value: fmtNum(cell.impressions) },
                { label: 'Clicks', value: fmtNum(cell.clicks) },
                { label: 'Avg position', value: fmtPos(cell.avgPosition) },
                { label: 'Covering page', value: cell.coveringPage ? pathOf(cell.coveringPage) : 'None' },
              ]}
            />
            <div>
              <div className="mb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Rationale</div>
              <p className="text-gray-800">{cell.rationale}</p>
            </div>
            <div>
              <div className="mb-1 text-[11px] font-semibold tracking-wider text-gray-400 uppercase">Queries</div>
              <ul className="list-disc pl-4 text-gray-800">
                {cell.queries.map((q) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
