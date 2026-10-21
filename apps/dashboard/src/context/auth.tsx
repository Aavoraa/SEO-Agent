import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, getToken, setToken, UNAUTHORIZED_EVENT } from '../api/client';
import type { AuthResponse, MeResponse, OrgSummary, Role, SystemStatus, User } from '../api/types';

interface AuthState {
  ready: boolean;
  user: User | null;
  status: SystemStatus | null;
  statusError: string | null;
  role: Role | null;
  canEdit: boolean;
  /** Admin of the current project (platform admins are admins of every project). */
  isAdmin: boolean;
  /** Manages the whole platform: users, API keys, new projects. */
  isPlatformAdmin: boolean;
  /** Set by ProjectProvider once the current project's role is known. */
  setProjectRole: (role: Role | null) => void;
  /** Organizations the user belongs to (tenants). */
  organizations: OrgSummary[];
  reloadMe: () => Promise<void>;
  productName: string;
  signIn: (res: AuthResponse) => void;
  signOut: () => void;
  refreshStatus: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [projectRole, setProjectRole] = useState<Role | null>(null);
  const [organizations, setOrganizations] = useState<OrgSummary[]>([]);
  const reloadMe = useCallback(async () => {
    const me = await api<MeResponse>('/api/auth/me');
    if (me.user) setUser(me.user);
    setOrganizations(me.organizations ?? []);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api<SystemStatus>('/api/system/status'));
      setStatusError(null);
    } catch (e) {
      setStatusError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      await refreshStatus();
      if (getToken()) {
        try {
          const me = await api<MeResponse>('/api/auth/me');
          if (alive && me.user) {
            setUser(me.user);
            setOrganizations(me.organizations ?? []);
          } else if (alive) setToken(null);
        } catch {
          setToken(null);
        }
      }
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [refreshStatus]);

  useEffect(() => {
    const onUnauthorized = () => {
      setToken(null);
      setUser(null);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signIn = useCallback((res: AuthResponse) => {
    setToken(res.token);
    setUser(res.user);
    api<MeResponse>('/api/auth/me').then((me) => setOrganizations(me.organizations ?? [])).catch(() => undefined);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    setOrganizations([]);
  }, []);

  const value = useMemo<AuthState>(() => {
    const isPlatformAdmin = user?.role === 'admin';
    // Permissions follow the role in the current project; before one is loaded, fall back to read-only.
    const role: Role | null = !user ? null : isPlatformAdmin ? 'admin' : projectRole ?? 'viewer';
    return { ready, user, status, statusError, role, canEdit: role === 'admin' || role === 'editor', isAdmin: role === 'admin', isPlatformAdmin, setProjectRole, organizations, reloadMe, productName: status?.productName ?? 'SEO Agent', signIn, signOut, refreshStatus };
  }, [ready, user, status, statusError, projectRole, organizations, reloadMe, signIn, signOut, refreshStatus]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}
