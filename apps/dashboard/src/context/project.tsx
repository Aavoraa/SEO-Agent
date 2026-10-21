import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import { useAuth } from './auth';
import type { OverviewCountsLite, Project, ProjectSummary } from './project-types';

interface ProjectState {
  projects: ProjectSummary[];
  projectId: string | null;
  project: Project | null;
  loading: boolean;
  error: string | null;
  selectProject: (id: string) => void;
  reloadProject: () => Promise<void>;
  /** Base path for project-scoped endpoints, e.g. `/api/projects/<id>`. */
  base: string;
  counts: OverviewCountsLite | null;
  setCounts: (c: OverviewCountsLite) => void;
  refreshCounts: () => void;
}

const Ctx = createContext<ProjectState | null>(null);
const KEY = 'phoenixx.seo.project';

function readStored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<OverviewCountsLite | null>(null);
  const { setProjectRole } = useAuth();

  useEffect(() => {
    let alive = true;
    api<ProjectSummary[]>('/api/projects')
      .then((list) => {
        if (!alive) return;
        setProjects(list);
        const stored = readStored();
        const pick = list.find((p) => p.id === stored) ?? list[0];
        setProjectId(pick?.id ?? null);
        if (!pick) setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setError((e as Error).message);
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const reloadProject = useCallback(async () => {
    if (!projectId) return;
    try {
      const p = await api<Project>(`/api/projects/${projectId}`);
      setProject(p);
      setProjectRole(p.myRole === 'service' ? 'viewer' : p.myRole);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [projectId, setProjectRole]);

  const refreshCounts = useCallback(() => {
    if (!projectId) return;
    api<{ counts: OverviewCountsLite }>(`/api/projects/${projectId}/overview`, { query: { days: 28 } })
      .then((o) => setCounts(o.counts))
      .catch(() => undefined);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    reloadProject();
    refreshCounts();
  }, [projectId, reloadProject, refreshCounts]);

  const selectProject = useCallback((id: string) => {
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
    setProject(null);
    setProjectRole(null);
    setProjectId(id);
  }, [setProjectRole]);

  const value = useMemo<ProjectState>(
    () => ({ projects, projectId, project, loading, error, selectProject, reloadProject, base: projectId ? `/api/projects/${projectId}` : '', counts, setCounts, refreshCounts }),
    [projects, projectId, project, loading, error, selectProject, reloadProject, counts, refreshCounts],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProject(): ProjectState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useProject outside ProjectProvider');
  return c;
}
