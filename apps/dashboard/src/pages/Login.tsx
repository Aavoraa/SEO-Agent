import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { PlayCircle } from 'lucide-react';
import { api, ApiError } from '../api/client';
import type { AuthResponse } from '../api/types';
import { useAuth } from '../context/auth';
import { DemoBanner } from '../components/Layout';
import { Button, Field } from '../components/ui';

export function AuthShell({ children, title, subtitle }: { children: ReactNode; title: string; subtitle?: string }) {
  const { status, productName } = useAuth();
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      {status?.demoMode && <DemoBanner />}
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-brand-500 text-base font-bold text-white">{productName.charAt(0).toUpperCase()}</span>
            <div className="leading-tight">
              <div className="text-base font-semibold text-gray-900">{productName}</div>
              <div className="text-xs text-gray-500">Find what matters · fix it safely · verify the result</div>
            </div>
          </div>
          <div className="card p-6">
            <h1 className="text-base font-semibold text-gray-900">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
            <div className="mt-5">{children}</div>
          </div>
          {status && <p className="mt-4 text-center text-[11px] text-gray-400">API v{status.version} · {status.database}</p>}
        </div>
      </div>
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as ApiError;
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
      {e.message}
      {e instanceof ApiError && e.status >= 500 && e.correlationId && <div className="mt-1 font-mono text-[11px] text-red-500">Correlation ID: {e.correlationId}</div>}
    </div>
  );
}

export function LoginPage() {
  const { user, status, statusError, signIn } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<'login' | 'demo' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const from = (loc.state as { from?: string } | null)?.from ?? '/';

  if (user) return <Navigate to={from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('login');
    setError(null);
    try {
      signIn(await api<AuthResponse>('/api/auth/login', { body: { email, password } }));
      nav(from, { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  const demo = async () => {
    setBusy('demo');
    setError(null);
    try {
      signIn(await api<AuthResponse>('/api/auth/demo-login', { method: 'POST' }));
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <AuthShell title="Sign in" subtitle="Use the account your administrator created for you.">
      <form onSubmit={submit} className="space-y-4">
        {statusError && <FormError error={new Error(`API unavailable: ${statusError}`)} />}
        <FormError error={error} />
        <Field label="Email">
          <input className="input w-full" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Password">
          <input className="input w-full" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy === 'login'} disabled={!!busy}>
          Sign in
        </Button>
      </form>
      {status?.signupEnabled && <p className="mt-4 text-center text-xs text-gray-500">New here? <Link to="/signup" className="font-medium text-brand-700 hover:underline">Create an account</Link></p>}
      {status?.demoMode && (
        <div className="mt-5 border-t border-gray-100 pt-5">
          <Button className="w-full" onClick={demo} loading={busy === 'demo'} disabled={!!busy} icon={<PlayCircle className="h-4 w-4" />}>
            Explore demo
          </Button>
          <p className="mt-2 text-center text-xs text-gray-500">Opens a sample project with fictional data.</p>
        </div>
      )}
    </AuthShell>
  );
}
