import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Circle, FileCode2, Loader2, MinusCircle, XCircle } from 'lucide-react';
import { api } from '../api/client';
import type { DeploymentDetail, FieldCheck, PreviewResult } from '../api/types';
import { useProject } from '../context/project';
import { cx, fmtDateTime, humanize } from '../lib/format';
import { Pill } from './Badges';
import { ErrorBox, Spinner } from './ui';

/* ───────────── Word-level before/after diff ───────────── */

type Tok = { t: string; k: 'same' | 'add' | 'del' };

/** LCS over words (inputs are titles/descriptions/headings – short enough for O(n·m)). */
export function diffWords(before: string, after: string): Tok[] {
  const a = before.split(/(\s+)/).filter((x) => x !== '');
  const b = after.split(/(\s+)/).filter((x) => x !== '');
  if (a.length * b.length > 250_000) return [{ t: before, k: 'del' }, { t: after, k: 'add' }];
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Tok[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ t: a[i]!, k: 'same' });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: a[i++]!, k: 'del' });
    else out.push({ t: b[j++]!, k: 'add' });
  }
  while (i < a.length) out.push({ t: a[i++]!, k: 'del' });
  while (j < b.length) out.push({ t: b[j++]!, k: 'add' });
  return out;
}

export function WordDiff({ before, after, className }: { before: string | null; after: string | null; className?: string }) {
  const toks = useMemo(() => diffWords(before ?? '', after ?? ''), [before, after]);
  const added = toks.filter((x) => x.k === 'add' && x.t.trim()).length;
  const removed = toks.filter((x) => x.k === 'del' && x.t.trim()).length;
  return (
    <div className={cx('rounded-md border border-gray-200 bg-white', className)}>
      <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-1.5 text-[11px] font-semibold tracking-wide text-gray-500 uppercase">
        Change
        <span className="font-normal normal-case text-emerald-700">+{added} word(s)</span>
        <span className="font-normal normal-case text-red-700">−{removed} word(s)</span>
      </div>
      <p className="p-3 text-sm leading-relaxed break-words text-gray-900">
        {toks.map((x, i) =>
          x.k === 'same' ? (
            <span key={i}>{x.t}</span>
          ) : x.k === 'add' ? (
            <ins key={i} className="rounded-sm bg-emerald-100 text-emerald-900 no-underline">
              {x.t}
            </ins>
          ) : (
            <del key={i} className="rounded-sm bg-red-100 text-red-800">
              {x.t}
            </del>
          ),
        )}
      </p>
    </div>
  );
}

/* ───────────── Expected vs actual checks ───────────── */

export function CheckList({ checks }: { checks: FieldCheck[] }) {
  if (!checks.length) return null;
  return (
    <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 text-xs">
      {checks.map((c, i) => (
        <li key={i} className="grid grid-cols-[16px_minmax(90px,140px)_1fr] items-start gap-2 px-3 py-1.5">
          {c.passed ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
          <span className="font-medium text-gray-700">
            {humanize(c.field)} <span className="font-normal text-gray-400">{c.kind === 'changed' ? '· changed' : c.kind === 'http' ? '' : '· unchanged'}</span>
          </span>
          <span className="min-w-0 break-words text-gray-600">
            {c.passed ? String(c.actual ?? '—') : (
              <>
                expected <strong className="text-gray-900">{String(c.expected ?? '—')}</strong> · got <strong className="text-red-700">{String(c.actual ?? '—')}</strong>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ───────────── File preview (dry run against the real/demo file) ───────────── */

export function FilePreview({ recId, onLoaded }: { recId: string; onLoaded?: (p: PreviewResult) => void }) {
  const { base } = useProject();
  const [data, setData] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    api<PreviewResult>(`${base}/recommendations/${recId}/preview`)
      .then((p) => {
        if (!alive) return;
        setData(p);
        onLoaded?.(p);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, recId]);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <div className="flex items-center gap-2 text-xs text-gray-500"><Spinner className="h-3.5 w-3.5" /> Loading the page file (read-only)…</div>;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Pill tone={data.mode === 'demo' ? 'violet' : 'dark'}>{data.mode === 'demo' ? 'DEMO copy' : 'LIVE site'}</Pill>
        <Pill tone="gray">{data.provider}</Pill>
        {data.file && <span className="inline-flex items-center gap-1 font-mono text-gray-700"><FileCode2 className="h-3.5 w-3.5" />{data.file}</span>}
        <span className={data.ok ? 'text-emerald-700' : 'text-amber-700'}>{data.message}</span>
      </div>
      {data.fileDiff.length > 0 && (
        <div className="overflow-hidden rounded-md border border-gray-200 font-mono text-[11px] leading-relaxed">
          {data.fileDiff.map((l) => (
            <div key={l.line}>
              {l.before && <div className="bg-red-50 px-3 py-0.5 break-all whitespace-pre-wrap text-red-800"><span className="mr-2 text-red-400 select-none">−{l.line}</span>{l.before}</div>}
              {l.after && <div className="bg-emerald-50 px-3 py-0.5 break-all whitespace-pre-wrap text-emerald-900"><span className="mr-2 text-emerald-500 select-none">+{l.line}</span>{l.after}</div>}
            </div>
          ))}
        </div>
      )}
      <CheckList checks={data.checks} />
    </div>
  );
}

/* ───────────── Deployment progress (polls until finished) ───────────── */

const FINAL = ['verified', 'verification_failed', 'failed', 'restored', 'deployed', 'awaiting_publish', 'exported'];

export function DeploymentStatusPill({ status }: { status: string }) {
  const tone = status === 'verified' ? 'green' : status === 'running' ? 'blue' : status === 'verification_failed' || status === 'restored' ? 'amber' : status === 'failed' ? 'red' : 'gray';
  return <Pill tone={tone}>{status.replace('_', ' ').toUpperCase()}</Pill>;
}

export function DeploymentProgress({ deploymentId, onDone }: { deploymentId: string; onDone?: (d: DeploymentDetail) => void }) {
  const { base } = useProject();
  const [d, setD] = useState<DeploymentDetail | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const x = await api<DeploymentDetail>(`${base}/deployments/${deploymentId}`);
        if (!alive) return;
        setD(x);
        if (FINAL.includes(x.status) && x.status !== 'deployed') onDone?.(x);
        else timer = setTimeout(tick, 1200);
      } catch (e) {
        if (alive) setError(e);
      }
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, deploymentId]);
  if (error) return <ErrorBox error={error} />;
  if (!d) return <div className="flex items-center gap-2 text-xs text-gray-500"><Spinner className="h-3.5 w-3.5" /> Starting deployment…</div>;
  const running = !FINAL.includes(d.status) || d.status === 'deployed';
  return (
    <div className="rounded-md border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 px-3 py-2 text-xs">
        <span className="font-semibold text-gray-900">{d.action === 'rollback' ? 'Rollback' : 'Deployment'} {d.id.slice(0, 8)}</span>
        <Pill tone={d.mode === 'demo' ? 'violet' : 'dark'}>{d.mode === 'demo' ? 'DEMO' : d.mode.toUpperCase()}</Pill>
        <DeploymentStatusPill status={d.status} />
        {d.target && <span className="font-mono text-gray-500">{d.target}</span>}
        <span className="ml-auto text-gray-400">{fmtDateTime(d.deployment_started_at)}</span>
      </div>
      <ol className="space-y-1 px-3 py-2 text-xs">
        {d.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            {s.status === 'done' ? <CheckCircle2 className="mt-px h-3.5 w-3.5 shrink-0 text-emerald-600" /> : s.status === 'failed' ? <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-red-600" /> : <MinusCircle className="mt-px h-3.5 w-3.5 shrink-0 text-gray-400" />}
            <span className="w-40 shrink-0 font-medium text-gray-800">{s.step}</span>
            <span className="min-w-0 break-words text-gray-600">{s.message}</span>
          </li>
        ))}
        {running && (
          <li className="flex items-center gap-2 text-gray-500">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Working…
          </li>
        )}
        {!running && !d.steps.length && (
          <li className="flex items-center gap-2 text-gray-500">
            <Circle className="h-3.5 w-3.5" /> No steps recorded
          </li>
        )}
      </ol>
      {d.error_message && <p className="border-t border-gray-100 px-3 py-2 text-xs text-red-700">{d.error_message}</p>}
    </div>
  );
}
