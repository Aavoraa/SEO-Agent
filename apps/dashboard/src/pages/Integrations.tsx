import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { CatalogEntry, IntegrationCatalog, IntegrationStatusValue } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { Card, ErrorBox, Loading, Stat } from '../components/ui';
import { Pill, type Tone } from '../components/Badges';
import { DataLabel } from '../components/DataLabel';

const STATUS: Record<IntegrationStatusValue, { text: string; tone: Tone }> = {
  connected: { text: 'Connected', tone: 'green' },
  configured: { text: 'Configured', tone: 'green' },
  manual: { text: 'Manual / file import', tone: 'blue' },
  integration_required: { text: 'Integration required', tone: 'amber' },
  planned: { text: 'Planned', tone: 'gray' },
};

const GROUPS: { id: string; title: string; categories: string[] }[] = [
  { id: 'now', title: 'Data & actions', categories: ['search_data', 'ai', 'links', 'implementation', 'notifications'] },
  { id: 'next', title: 'Additional data sources', categories: ['performance', 'keywords_serp', 'ai_visibility', 'local', 'social_market'] },
];

function Row({ e }: { e: CatalogEntry }) {
  const s = STATUS[e.status];
  return (
    <li className="grid gap-2 px-4 py-3 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_auto] md:items-start">
      <div>
        <div className="font-medium text-gray-900">{e.name}</div>
        <div className="mt-1 flex flex-wrap gap-1">
          {e.powers.map((p) => (
            <span key={p} className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">{p}</span>
          ))}
        </div>
      </div>
      <div className="text-sm text-gray-600">
        <p>{e.detail}</p>
        {e.status !== 'connected' && e.status !== 'configured' && <p className="mt-1 text-xs text-gray-500">Setup: {e.setup}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 md:justify-end">
        <Pill tone={s.tone}>{e.status === 'planned' && e.phase ? `Planned · phase ${e.phase}` : s.text}</Pill>
        {e.status !== 'planned' && <DataLabel label={e.dataLabel} />}
      </div>
    </li>
  );
}

export function IntegrationsPage() {
  const { data, error, loading, reload } = useProjectApi<IntegrationCatalog>('/integrations/catalog');
  const counts = useMemo(() => {
    const e = data?.entries ?? [];
    return { live: e.filter((x) => x.status === 'connected' || x.status === 'configured').length, manual: e.filter((x) => x.status === 'manual').length, required: e.filter((x) => x.status === 'integration_required').length, planned: e.filter((x) => x.status === 'planned').length };
  }, [data]);
  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Every data source and action provider, with its real status. Features whose provider isn't connected show “Integration required” instead of numbers."
        actions={<Link to="/settings?tab=integrations" className="text-sm font-medium text-brand-700 hover:underline">Google connection settings</Link>}
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Connected / configured" value={counts.live} />
            <Stat label="Manual (file import / export)" value={counts.manual} />
            <Stat label="Integration required" value={counts.required} hint="configure to unlock features" />
            <Stat label="Planned adapters" value={counts.planned} hint="see roadmap" />
          </div>
          <Card title="What the labels mean" bodyClassName="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-xs text-gray-600">
            <span className="flex items-center gap-1.5"><DataLabel label="verified" /> first-party (GSC, GA4, crawler)</span>
            <span className="flex items-center gap-1.5"><DataLabel label="estimated" /> third-party provider</span>
            <span className="flex items-center gap-1.5"><DataLabel label="modeled" /> calculated by Phoenixx</span>
            <span className="flex items-center gap-1.5"><DataLabel label="unavailable" /> provider not connected</span>
            <span className="flex items-center gap-1.5"><DataLabel label="demo" /> sample data</span>
          </Card>
          {GROUPS.map((g) => {
            const rows = data.entries.filter((e) => g.categories.includes(e.category));
            return (
              <Card key={g.id} title={g.title} bodyClassName="p-0">
                <ul className="divide-y divide-gray-100">{rows.map((e) => <Row key={e.id} e={e} />)}</ul>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
