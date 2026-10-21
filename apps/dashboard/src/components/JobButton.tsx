import { useEffect, useState } from 'react';
import { CheckCircle2, Play, XCircle } from 'lucide-react';
import { useAuth } from '../context/auth';
import { useJob, type JobState } from '../hooks/useJob';
import { cx } from '../lib/format';
import { Button, Spinner, Tooltip } from './ui';

function summarize(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
    if (typeof v === 'number' || typeof v === 'boolean') parts.push(`${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: ${v}`);
    else if (Array.isArray(v)) parts.push(`${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: ${v.length}`);
    if (parts.length >= 4) break;
  }
  return parts.length ? parts.join(' · ') : null;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="tabular">{Math.max(0, Math.round((now - since) / 1000))}s</span>;
}

/** Inline status for a job started with useJob. */
export function JobStatusLine({ job, className }: { job: JobState; className?: string }) {
  if (job.status === 'idle') return null;
  if (job.status === 'starting' || job.status === 'running')
    return (
      <span className={cx('inline-flex items-center gap-1.5 text-xs text-gray-600', className)}>
        <Spinner className="h-3.5 w-3.5 text-brand-500" /> Running {job.type}… {job.startedAt && <Elapsed since={job.startedAt} />}
      </span>
    );
  if (job.status === 'succeeded') {
    const s = summarize(job.output);
    return (
      <span className={cx('inline-flex items-center gap-1.5 text-xs text-emerald-700', className)}>
        <CheckCircle2 className="h-3.5 w-3.5" /> {job.type} completed{job.startedAt && job.finishedAt ? ` in ${Math.round((job.finishedAt - job.startedAt) / 1000)}s` : ''}
        {s && <span className="text-gray-500">· {s}</span>}
      </span>
    );
  }
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs text-red-700', className)}>
      <XCircle className="h-3.5 w-3.5 shrink-0" /> {job.type} failed: {job.error}
      {job.correlationId && <span className="font-mono text-[10px] text-gray-400">({job.correlationId})</span>}
    </span>
  );
}

/** "Run now" button for a background job; hidden for viewers. Shows progress and result inline. */
export function JobButton({ type, body, label, onDone, variant = 'secondary', size = 'md', hideStatus, disabled, disabledReason }: { type: string; body?: Record<string, unknown>; label: string; onDone?: (j: JobState) => void; variant?: 'primary' | 'secondary'; size?: 'sm' | 'md'; hideStatus?: boolean; disabled?: boolean; disabledReason?: string }) {
  const { canEdit } = useAuth();
  const job = useJob({ onDone });
  if (!canEdit) return null;
  const btn = (
    <Button variant={variant} size={size} loading={job.busy} disabled={disabled} icon={<Play className="h-3.5 w-3.5" />} onClick={() => job.run(type, body)}>
      {label}
    </Button>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {disabled && disabledReason ? <Tooltip content={disabledReason}>{btn}</Tooltip> : btn}
      {!hideStatus && <JobStatusLine job={job} />}
    </span>
  );
}
