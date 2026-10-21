import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { JobRun } from '../api/types';
import { useProject } from '../context/project';

export type JobStatus = 'idle' | 'starting' | 'running' | 'succeeded' | 'failed';

export interface JobState {
  status: JobStatus;
  jobId: string | null;
  type: string | null;
  output: unknown;
  error: string | null;
  correlationId: string | null;
  startedAt: number | null;
  finishedAt: number | null;
}

const idle: JobState = { status: 'idle', jobId: null, type: null, output: null, error: null, correlationId: null, startedAt: null, finishedAt: null };

/**
 * Start a background job (POST /jobs/:type → 202 {jobId}) and poll GET /jobs/:jobId every 2 s
 * until it succeeds or fails. If the same job type is already running (409), attach to it.
 */
export function useJob(opts: { onDone?: (job: JobState) => void } = {}) {
  const { base } = useProject();
  const [state, setState] = useState<JobState>(idle);
  const timer = useRef<number | null>(null);
  const onDone = useRef(opts.onDone);
  onDone.current = opts.onDone;

  const stop = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  const poll = useCallback(
    (jobId: string, type: string, startedAt: number) => {
      const tick = async () => {
        try {
          const j = await api<JobRun>(`${base}/jobs/${jobId}`);
          if (j.status === 'running') {
            setState((s) => ({ ...s, status: 'running' }));
            timer.current = window.setTimeout(tick, 2000);
            return;
          }
          const done: JobState = {
            status: j.status === 'succeeded' ? 'succeeded' : 'failed',
            jobId,
            type,
            output: j.output,
            error: j.error,
            correlationId: j.correlation_id,
            startedAt,
            finishedAt: Date.now(),
          };
          setState(done);
          onDone.current?.(done);
        } catch (e) {
          const done: JobState = { ...idle, status: 'failed', jobId, type, error: (e as Error).message, startedAt, finishedAt: Date.now() };
          setState(done);
          onDone.current?.(done);
        }
      };
      timer.current = window.setTimeout(tick, 2000);
    },
    [base],
  );

  const run = useCallback(
    async (type: string, body: Record<string, unknown> = {}) => {
      stop();
      const startedAt = Date.now();
      setState({ ...idle, status: 'starting', type, startedAt });
      try {
        const r = await api<{ jobId: string; status: string; correlationId?: string; output?: unknown; error?: string }>(`${base}/jobs/${type}`, { method: 'POST', body });
        if (r.status === 'running') {
          setState({ ...idle, status: 'running', jobId: r.jobId, type, correlationId: r.correlationId ?? null, startedAt });
          poll(r.jobId, type, startedAt);
        } else {
          const done: JobState = { ...idle, status: r.status === 'succeeded' ? 'succeeded' : 'failed', jobId: r.jobId, type, output: r.output, error: r.error ?? null, startedAt, finishedAt: Date.now() };
          setState(done);
          onDone.current?.(done);
        }
      } catch (e) {
        const err = e as ApiError;
        const existing = (err.details as { jobId?: string } | undefined)?.jobId;
        if (err.code === 'job_running' && existing) {
          setState({ ...idle, status: 'running', jobId: existing, type, startedAt });
          poll(existing, type, startedAt);
          return;
        }
        const done: JobState = { ...idle, status: 'failed', type, error: err.message, correlationId: err.correlationId ?? null, startedAt, finishedAt: Date.now() };
        setState(done);
        onDone.current?.(done);
      }
    },
    [base, poll],
  );

  const reset = useCallback(() => {
    stop();
    setState(idle);
  }, []);

  return { ...state, run, reset, busy: state.status === 'starting' || state.status === 'running' };
}
