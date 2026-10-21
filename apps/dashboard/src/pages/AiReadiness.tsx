import { CheckCircle2, XCircle } from 'lucide-react';
import type { AiCrawler, AiReadiness } from '../api/types';
import { useProjectApi } from '../hooks/useApi';
import { fmtRelative } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Card, ErrorBox, Loading, Stat } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pill } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';
import { DataLabel, IntegrationRequired } from '../components/DataLabel';

const PURPOSE: Record<AiCrawler['purpose'], string> = { search: 'Search / answers', user: 'Fetches for a user', training: 'Model training' };

export function AiReadinessPage() {
  const { data, error, loading, reload } = useProjectApi<AiReadiness>('/ai-readiness');

  const cols: Column<AiCrawler>[] = [
    { key: 'bot', header: 'Crawler', sort: (r) => r.token, render: (r) => (<div><div className="font-mono text-xs font-medium text-gray-900">{r.token}</div><div className="text-xs text-gray-500">{r.owner}</div></div>) },
    { key: 'product', header: 'Used for', render: (r) => <span className="text-sm text-gray-700">{r.product}</span> },
    { key: 'purpose', header: 'Type', sort: (r) => r.purpose, render: (r) => <Pill tone={r.purpose === 'training' ? 'gray' : 'blue'}>{PURPOSE[r.purpose]}</Pill> },
    { key: 'allowed', header: 'robots.txt', sort: (r) => String(r.allowed), render: (r) => (r.allowed ? <Pill tone="green">Allowed</Pill> : <Pill tone={r.purpose === 'training' ? 'gray' : 'red'}>Blocked</Pill>) },
    { key: 'group', header: 'Decided by', render: (r) => <span className="font-mono text-xs text-gray-500">{r.matchedGroup ? `User-agent: ${r.matchedGroup}` : 'no robots.txt rule'}</span> },
  ];

  return (
    <div>
      <PageHeader title="AI Readiness" description="Can AI search products (ChatGPT, Claude, Perplexity, Copilot, Google AI Overviews) reach and understand the site?" actions={<JobButton type="crawl" label="Re-crawl" onDone={reload} />} />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && !data.available && <Card><EmptyState title="No readiness data yet" description={data.reason} action={<JobButton type="crawl" label="Run crawl" variant="primary" onDone={reload} />} /></Card>}
      {data?.available && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Checks passed" value={`${data.checks.filter((c) => c.ok).length}/${data.checks.length}`} hint={<span className="inline-flex items-center gap-1">from crawl {fmtRelative(data.crawledAt)} <DataLabel label={data.dataLabel} /></span>} />
            <Stat label="AI search crawlers allowed" value={`${data.crawlers.filter((c) => c.purpose !== 'training' && c.allowed).length}/${data.crawlers.filter((c) => c.purpose !== 'training').length}`} />
            <Stat label="Training crawlers allowed" value={`${data.crawlers.filter((c) => c.purpose === 'training' && c.allowed).length}/${data.crawlers.filter((c) => c.purpose === 'training').length}`} hint="a business choice – not scored" />
            <Stat label="Rendering" value={data.stack.rendering.replace('-', ' ')} hint={data.stack.server ?? undefined} />
          </div>
          <Card title="Readiness checks" bodyClassName="p-0">
            <ul className="divide-y divide-gray-100">
              {data.checks.map((c) => (
                <li key={c.id} className="flex items-start gap-3 px-4 py-2.5">
                  {c.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-900">{c.label}</div>
                    <div className="text-xs text-gray-500">{c.detail}</div>
                  </div>
                </li>
              ))}
              <li className="flex items-start gap-3 px-4 py-2.5">
                <span className="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-gray-300" />
                <div className="text-sm"><span className="font-medium text-gray-900">/llms.txt {data.llmsTxt.found ? 'present' : 'not present'}</span> <span className="text-xs text-gray-500">– {data.llmsTxt.note}</span></div>
              </li>
            </ul>
          </Card>
          <Card title="AI & search crawler access" subtitle="From robots.txt. Blocking a search crawler removes the site from that product's answers; blocking a training crawler only opts out of model training." bodyClassName="p-0">
            <DataTable className="rounded-none border-0" dense columns={cols} rows={data.crawlers} rowKey={(r) => r.token} />
          </Card>
          <Card title="Detected stack">
            <div className="flex flex-wrap gap-1.5">
              {data.stack.technologies.map((t) => <Pill key={t.name} title={t.category}>{t.name}</Pill>)}
              {data.stack.analytics.ga4.map((id) => <Pill key={id} tone="blue">GA4 {id}</Pill>)}
              {data.stack.analytics.gtm.map((id) => <Pill key={id} tone="blue">{id}</Pill>)}
            </div>
          </Card>
          <IntegrationRequired what="Measuring actual AI visibility (mentions, citations, share of voice)" provider="the AI answer-engine integration" phase={5} />
        </div>
      )}
    </div>
  );
}
