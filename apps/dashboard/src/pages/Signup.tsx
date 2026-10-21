import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { AuthResponse } from '../api/types';
import { useAuth } from '../context/auth';
import { Button, Field } from '../components/ui';
import { AuthShell, FormError } from './Login';

export function SignupPage() {
  const { user, status, signIn } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', organizationName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (user) return <Navigate to="/" replace />;
  if (status && !status.signupEnabled) {
    return (
      <AuthShell title="Sign-up is closed" subtitle="Ask an administrator of your organization for an invitation.">
        <Link to="/login" className="text-sm font-medium text-brand-700 hover:underline">Back to sign in</Link>
      </AuthShell>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<AuthResponse>('/api/auth/signup', { body: form });
      signIn(r);
      nav('/onboarding', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <AuthShell title="Create your account" subtitle="You'll add your first website next – no credit card needed for the trial.">
      <form onSubmit={submit} className="space-y-3">
        <Field label="Your name"><input className="input w-full" required autoComplete="name" value={form.name} onChange={set('name')} /></Field>
        <Field label="Work email"><input className="input w-full" type="email" required autoComplete="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Password" hint="At least 10 characters"><input className="input w-full" type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={set('password')} /></Field>
        <Field label="Company or agency name"><input className="input w-full" required value={form.organizationName} onChange={set('organizationName')} /></Field>
        <FormError error={error} />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>Create account</Button>
        <p className="text-center text-xs text-gray-500">Already have an account? <Link to="/login" className="font-medium text-brand-700 hover:underline">Sign in</Link></p>
      </form>
    </AuthShell>
  );
}

export function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const { user, signIn } = useAuth();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<AuthResponse>('/api/auth/accept-invite', { body: { token, ...(user ? {} : form) } });
      signIn(r);
      nav('/', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title="Join your team" subtitle={user ? `Accept the invitation as ${user.email}.` : 'Create your account to accept the invitation. If you already have an account, just enter any name and your password is kept.'}>
      <form onSubmit={submit} className="space-y-3">
        {!user && (
          <>
            <Field label="Your name"><input className="input w-full" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Choose a password" hint="At least 10 characters"><input className="input w-full" type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          </>
        )}
        <FormError error={error} />
        <Button type="submit" variant="primary" className="w-full" loading={busy}>Accept invitation</Button>
      </form>
    </AuthShell>
  );
}
