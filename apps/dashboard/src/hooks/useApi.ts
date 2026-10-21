import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import { useProject } from '../context/project';

export interface ApiState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | null) => T | null) => void;
}

type Query = Record<string, string | number | boolean | null | undefined>;

/** GET `path` (with optional query) and keep the last result while reloading. `path = null` skips. */
export function useApi<T>(path: string | null, query?: Query): ApiState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [tick, setTick] = useState(0);
  const qKey = JSON.stringify(query ?? {});

  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    api<T>(path, { query: JSON.parse(qKey) as Query, signal: ctrl.signal })
      .then((d) => {
        setDataState(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if ((e as Error).name === 'AbortError' || ctrl.signal.aborted) return;
        setError(e as Error);
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, qKey, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((fn: (prev: T | null) => T | null) => setDataState((p) => fn(p)), []);
  return { data, error, loading, reload, setData };
}

/** Project-scoped GET: `sub` is appended to `/api/projects/:projectId`. */
export function useProjectApi<T>(sub: string | null, query?: Query): ApiState<T> {
  const { base } = useProject();
  return useApi<T>(base && sub !== null ? `${base}${sub}` : null, query);
}
