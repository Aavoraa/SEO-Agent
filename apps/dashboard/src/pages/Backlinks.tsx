import { useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ExternalLink, Info, Upload } from 'lucide-react';
import { api } from '../api/client';
import type { Backlink, BacklinkImportResult, BacklinksResponse, BacklinkStatus, ReferringDomain } from '../api/types';
import { useAuth } from '../context/auth';
import { useProject } from '../context/project';
import { useProjectApi } from '../hooks/useApi';
import { useAction } from '../hooks/useAction';
import { fmtDate, fmtNum, fmtRelative, pathOf } from '../lib/format';
import { PageHeader } from '../components/PageHeader';
import { Button, Card, ErrorBox, Loading, Stat, Tabs } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { Pill, type Tone } from '../components/Badges';
import { EmptyState } from '../components/EmptyState';
import { JobButton } from '../components/JobButton';

const STATUS_TONE: Record<BacklinkStatus, Tone> = { live: 'green', lost: 'red', error: 'amber', unverified: 'gray' };

function StatusBadge({ b }: { b: Backlink }) {
  const title = b.check_error ?? (b.last_checked_at ? `Checked ${fmtRelative(b.last_checked_at)}` : 'Not checked yet');
  return (
    <Pill tone={STATUS_TONE[b.status]} title={title}>
      {b.status}
    </Pill>
  );
}

function ImportCard({ onImported }: { onImported: () => void }) {
  const { base } = useProject();
  const { busy, run } = useAction();
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<BacklinkImportResult | null>(null);
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const csv = await file.text();
    const r = await run('import', () => api<BacklinkImportResult>(`${base}/backlinks/import`, { body: { csv, fileName: file.name } }), (x) => `${x.inserted} new, ${x.updated} updated – run "Check links now" to verify them`);
    if (r) {
      setResult(r);
      onImported();
    }
  };
  return (
    <Card title="Import backlinks" subtitle="Google's API doesn't provide links, so export them from Search Console (free) or any SEO tool">
      <div className="flex flex-wrap items-start gap-4">
        <ol className="min-w-64 flex-1 list-decimal space-y-1 pl-5 text-sm text-gray-600">
          <li>Search Console → <strong>Links</strong> → <strong>Export external links</strong> → <strong>Latest links</strong>.</li>
          <li>Download as CSV and upload it here. Ahrefs, Semrush, Moz, Majestic and DataForSEO exports, or a plain list of URLs, also work.</li>
          <li>Re-import monthly – existing links are updated, not duplicated.</li>
        </ol>
        <div className="flex flex-col items-start gap-2">
          <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="hidden" onChange={onFile} />
          <Button variant="primary" icon={<Upload className="h-3.5 w-3.5" />} loading={busy === 'import'} onClick={() => input.current?.click()}>
            Upload CSV
          </Button>
          {result && (
            <p className="max-w-xs text-xs text-gray-500">
              Last import: {result.rows} link(s) read{result.columns.source ? ` from “${result.columns.source}”` : ''}, {result.skipped} skipped{result.skippedSample[0] ? ` (e.g. line ${result.skippedSample[0].line}: ${result.skippedSample[0].reason})` : ''}.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}

type Filter = 'all' | BacklinkStatus;

export function BacklinksPage() {
  const { canEdit } = useAuth();
  const { data, error, loading, reload } = useProjectApi<BacklinksResponse>('/backlinks');
  const [filter, setFilter] = useState<Filter>('all');
  const rows = useMemo(() => (data?.backlinks ?? []).filter((b) => filter === 'all' || b.status === filter), [data, filter]);
  const count = (s: BacklinkStatus) => (data?.backlinks ?? []).filter((b) => b.status === s).length;

  const linkCols: Column<Backlink>[] = [
    {
      key: 'source',
      header: 'Linking page',
      sort: (r) => r.source_url,
      render: (r) => (
        <a href={r.source_url} target="_blank" rel="noopener noreferrer nofollow" className="group inline-flex max-w-sm flex-col">
          <span className="text-sm font-medium text-gray-900 group-hover:underline">{r.source_domain}</span>
          <span className="truncate font-mono text-[11px] text-gray-500">{pathOf(r.source_url)}</span>
        </a>
      ),
    },
    {
      key: 'target',
      header: 'Links to',
      sort: (r) => r.target_url || r.target_final_url,
      render: (r) => {
        const t = r.target_url || r.target_final_url;
        return (
          <span className="inline-flex items-center gap-1.5 font-mono text-xs">
            {t ? pathOf(t) : <span className="text-gray-400">any page</span>}
            {r.target_status && r.target_status >= 400 && <Pill tone="red">{r.target_status}</Pill>}
          </span>
        );
      },
    },
    { key: 'anchor', header: 'Anchor', render: (r) => <span className="text-sm">{r.found_anchor ?? r.anchor ? `“${r.found_anchor ?? r.anchor}”` : '—'}</span> },
    { key: 'follow', header: 'Follow', sort: (r) => String(r.found_nofollow ?? r.nofollow), render: (r) => ((r.found_nofollow ?? r.nofollow) ? <Pill tone="gray">nofollow</Pill> : (r.found_nofollow ?? r.nofollow) === false ? <Pill tone="blue">follow</Pill> : <span className="text-xs text-gray-400">?</span>) },
    { key: 'status', header: 'Status', sort: (r) => r.status, render: (r) => <StatusBadge b={r} /> },
    { key: 'first', header: 'First seen', sort: (r) => r.first_seen_at, render: (r) => <span className="text-xs text-gray-600">{fmtDate(r.first_seen_at)}</span> },
    { key: 'checked', header: 'Last checked', sort: (r) => r.last_checked_at ?? '', render: (r) => <span className="text-xs text-gray-600">{r.lost_at ? `lost ${fmtRelative(r.lost_at)}` : fmtRelative(r.last_checked_at)}</span> },
  ];

  const domainCols: Column<ReferringDomain>[] = [
    { key: 'domain', header: 'Referring site', sort: (r) => r.domain, render: (r) => <span className="text-sm font-medium text-gray-900">{r.domain}</span> },
    { key: 'live', header: 'Live links', sort: (r) => r.live, align: 'right', render: (r) => <span className="tabular">{r.live}</span> },
    { key: 'followed', header: 'Followed', sort: (r) => r.followed, align: 'right', render: (r) => <span className="tabular">{r.followed}</span> },
    { key: 'lost', header: 'Lost', sort: (r) => r.lost, align: 'right', render: (r) => <span className={r.lost ? 'tabular text-red-700' : 'tabular text-gray-400'}>{r.lost}</span> },
    { key: 'first', header: 'First seen', sort: (r) => r.first_seen_at, render: (r) => <span className="text-xs text-gray-600">{fmtDate(r.first_seen_at)}</span> },
  ];

  return (
    <div>
      <PageHeader
        title="Backlinks"
        description="Links from other websites to yours: checked live every week, with alerts for lost links and 301 proposals for links that land on broken pages."
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {data?.provider.configured && <JobButton type="backlinks-sync" label={`Sync from ${data.provider.name}`} onDone={reload} hideStatus />}
            <JobButton type="backlinks-verify" label="Check links now" variant="primary" onDone={reload} />
          </span>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && loading && <Loading />}
      {data && (
        <div className="space-y-5">
          <div className="flex items-start gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{data.note} Buying links, link networks and mass outreach break Google's spam policies and can get the site penalised.</span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Referring sites" value={fmtNum(data.summary.liveReferringDomains)} hint={`${fmtNum(data.summary.referringDomains)} known`} />
            <Stat label="Live backlinks" value={fmtNum(data.summary.live)} hint={`${fmtNum(data.summary.nofollow)} nofollow`} />
            <Stat label="Lost" value={fmtNum(data.summary.lost)} />
            <Stat label="Not checked yet" value={fmtNum(data.summary.unverified)} />
            <Stat label="Links to broken pages" value={fmtNum(data.brokenTargets.reduce((s, b) => s + b.links, 0))} hint={`${data.brokenTargets.length} broken URL(s)`} />
          </div>

          {canEdit && <ImportCard onImported={reload} />}

          {data.brokenTargets.length > 0 && (
            <Card title="Backlinks pointing at broken pages" subtitle="Each one has a 301 redirect proposal waiting for admin approval" actions={<Link to="/approvals" className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">Review in Approvals <ArrowRight className="h-3.5 w-3.5" /></Link>} bodyClassName="p-0">
              <ul className="divide-y divide-gray-100">
                {data.brokenTargets.map((b) => (
                  <li key={b.target} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                    <Pill tone="red">{b.status}</Pill>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-900">{pathOf(b.target)}</span>
                    <span className="text-xs text-gray-600">{b.links} link(s) from {b.domains} site(s)</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {!data.backlinks.length ? (
            <Card>
              <EmptyState title="No backlinks yet" description={data.provider.configured ? 'Run "Sync" to pull links from your provider, or upload a CSV export.' : 'Upload the Search Console "Latest links" export above, then run "Check links now".'} />
            </Card>
          ) : (
            <>
              <Card title="All backlinks" subtitle={data.lastVerify?.finished_at ? `Last check ${fmtRelative(data.lastVerify.finished_at)} (${data.lastVerify.status})` : 'Not checked yet'} bodyClassName="p-0">
                <div className="px-4 pt-2">
                  <Tabs<Filter>
                    value={filter}
                    onChange={setFilter}
                    tabs={[
                      { id: 'all', label: 'All', count: data.backlinks.length },
                      { id: 'live', label: 'Live', count: count('live') },
                      { id: 'lost', label: 'Lost', count: count('lost') },
                      { id: 'error', label: 'Check failed', count: count('error') },
                      { id: 'unverified', label: 'Not checked', count: count('unverified') },
                    ]}
                  />
                </div>
                <DataTable className="rounded-none border-0" columns={linkCols} rows={rows} rowKey={(r) => r.id} maxHeight="560px" empty={<p className="p-4 text-sm text-gray-500">Nothing in this view.</p>} />
              </Card>
              <Card title="Referring sites" bodyClassName="p-0">
                <DataTable className="rounded-none border-0" dense columns={domainCols} rows={data.domains} rowKey={(r) => r.domain} initialSort={{ key: 'live', dir: 'desc' }} maxHeight="420px" />
              </Card>
            </>
          )}
          <p className="flex items-center gap-1 text-xs text-gray-400">
            <ExternalLink className="h-3 w-3" /> Linking pages open in a new tab. Checks fetch one page per link, one request per site at a time.
          </p>
        </div>
      )}
    </div>
  );
}
