import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { AuthResponse } from '../api/types';
import { useAuth } from '../context/auth';
import { Button, Field } from '../components/ui';
import { AuthShell, FormError } from './Login';

/** First-run: create the first admin (only while /api/system/status reports needsSetup). */
export function SetupPage() {
  const { user, status, signIn, refreshStatus } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (user) return <Navigate to="/" replace />;
  if (status && !status.needsSetup) return <Navigate to="/login" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.password.length < 10) return setError(new Error('Password must be at least 10 characters.'));
    if (form.password !== form.confirm) return setError(new Error('Passwords do not match.'));
    setBusy(true);
    try {
      signIn(await api<AuthResponse>('/api/auth/setup', { body: { name: form.name, email: form.email, password: form.password } }));
      await refreshStatus();
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <AuthShell title="Create the first admin" subtitle="No users exist yet. This account will be able to manage users, settings and high-risk approvals.">
      <form onSubmit={submit} className="space-y-4">
        <FormError error={error} />
        <Field label="Full name">
          <input className="input w-full" required value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Email">
          <input className="input w-full" type="email" autoComplete="username" required value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Password" hint="At least 10 characters.">
          <input className="input w-full" type="password" autoComplete="new-password" required value={form.password} onChange={set('password')} />
        </Field>
        <Field label="Confirm password">
          <input className="input w-full" type="password" autoComplete="new-password" required value={form.confirm} onChange={set('confirm')} />
        </Field>
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          Create admin & continue
        </Button>
      </form>
    </AuthShell>
  );
}
