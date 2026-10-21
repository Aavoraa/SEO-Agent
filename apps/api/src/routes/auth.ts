import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, generateApiKey, hashApiKey, hashPassword, signJwt, verifyPassword, verifyJwt, encryptSecret } from '@phoenixx/shared';
import { exchangeGoogleCode, googleAuthUrl } from '@phoenixx/integrations';
import type { AppContext } from '../context.js';
import { parse, requireActor, requireRole, meta } from '../http.js';
import { audit } from '../services/common.js';
import { membershipsOf, organizationsOf, setMembership } from '../services/access.js';

const login = z.object({ email: z.string().email(), password: z.string().min(1).max(200) });
const membership = z.object({ projectId: z.string().uuid(), role: z.enum(['admin', 'editor', 'viewer']) });
const newUser = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: z.string().min(10).max(200),
  /** Platform role: 'admin' manages the whole platform and sees every project. */
  role: z.enum(['admin', 'editor', 'viewer']).default('viewer'),
  /** Project access for non-admins. Without it the user sees no projects until added as a member. */
  projects: z.array(membership).max(500).default([]),
});

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const issue = (u: { id: string; email: string; name: string; role: string }) => ({ token: signJwt({ sub: u.id, role: u.role }, ctx.jwtSecret), user: { id: u.id, email: u.email, name: u.name, role: u.role } });

  app.post('/api/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(login, req.body);
    const u = await ctx.db.one<any>('SELECT * FROM users WHERE lower(email) = lower($1)', [b.email]);
    if (!u || !u.is_active || !verifyPassword(b.password, u.password_hash)) {
      await audit(ctx, { actorType: 'system', action: 'auth.login_failed', details: { email: b.email }, ...meta(req) });
      throw new AppError('Invalid email or password', 401, 'unauthorized');
    }
    await ctx.db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    await audit(ctx, { actorType: 'user', actorId: u.id, actorLabel: u.email, action: 'auth.login', ...meta(req) });
    return issue(u);
  });

  /** First-run: create the first admin. Disabled as soon as any user exists. */
  app.post('/api/auth/setup', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const b = parse(newUser.omit({ role: true }), req.body);
    const count = await ctx.db.one<{ n: number }>('SELECT COUNT(*)::int AS n FROM users');
    if ((count?.n ?? 0) > 0) throw new AppError('Setup already completed – ask an admin for an account', 409, 'setup_done');
    const u = await ctx.db.one<any>(`INSERT INTO users(email, name, password_hash, role) VALUES ($1,$2,$3,'admin') RETURNING *`, [b.email.toLowerCase(), b.name, hashPassword(b.password)]);
    await audit(ctx, { actorType: 'user', actorId: u.id, actorLabel: u.email, action: 'auth.setup_admin', ...meta(req) });
    return issue(u);
  });

  /** Demo mode only: one-click login into the separate demo database. */
  app.post('/api/auth/demo-login', async () => {
    if (!ctx.cfg.DEMO_MODE) throw new AppError('Demo login is only available when DEMO_MODE=true', 404, 'not_found');
    const u = await ctx.db.one<any>(`SELECT * FROM users WHERE email = 'demo@phoenixxit.local'`);
    if (!u) throw new AppError('Demo data not seeded – run npm run db:seed:demo', 400, 'no_demo');
    return issue(u);
  });

  app.get('/api/auth/me', async (req) => {
    const a = requireActor(req);
    if (a.type !== 'user') return { actor: a };
    const u = await ctx.db.one('SELECT id, email, name, role, last_login_at FROM users WHERE id = $1', [a.id]);
    return { actor: a, user: u, memberships: await membershipsOf(ctx, a.id!), organizations: await organizationsOf(ctx, a.id!), product: { name: ctx.cfg.PRODUCT_NAME } };
  });

  app.get('/api/auth/users', async (req) => {
    requireRole(req, 'admin');
    return ctx.db.query(
      `SELECT u.id, u.email, u.name, u.role, u.is_active, u.created_at, u.last_login_at,
              COALESCE(json_agg(json_build_object('projectId', m.project_id, 'role', m.role)) FILTER (WHERE m.project_id IS NOT NULL), '[]') AS memberships
       FROM users u LEFT JOIN project_members m ON m.user_id = u.id GROUP BY u.id ORDER BY u.created_at`,
    );
  });

  app.post('/api/auth/users', async (req) => {
    const a = requireRole(req, 'admin');
    const b = parse(newUser, req.body);
    const u = await ctx.db.one<any>(`INSERT INTO users(email, name, password_hash, role) VALUES ($1,$2,$3,$4) ON CONFLICT (email) DO NOTHING RETURNING id, email, name, role`, [b.email.toLowerCase(), b.name, hashPassword(b.password), b.role]);
    if (!u) throw new AppError('A user with this email already exists', 409, 'exists');
    for (const m of b.projects) {
      if (!(await ctx.db.one('SELECT 1 FROM projects WHERE id = $1', [m.projectId]))) throw new AppError(`Project ${m.projectId} not found`, 400, 'validation');
      await setMembership(ctx, m.projectId, u.id, m.role);
    }
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'user.create', entityType: 'user', entityId: u.id, details: { role: b.role, projects: b.projects }, ...meta(req) });
    return { ...u, memberships: b.projects };
  });

  app.patch('/api/auth/users/:id', async (req) => {
    const a = requireRole(req, 'admin');
    const b = parse(z.object({ role: z.enum(['admin', 'editor', 'viewer']).optional(), isActive: z.boolean().optional() }), req.body);
    const { id } = req.params as { id: string };
    if (id === a.id && (b.isActive === false || (b.role && b.role !== 'admin'))) throw new AppError('You cannot demote or disable yourself', 400, 'bad_request');
    await ctx.db.query('UPDATE users SET role = COALESCE($2, role), is_active = COALESCE($3, is_active) WHERE id = $1', [id, b.role ?? null, b.isActive ?? null]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'user.update', entityType: 'user', entityId: id, details: b, ...meta(req) });
    return { ok: true };
  });

  app.post('/api/auth/api-keys', async (req) => {
    const a = requireRole(req, 'admin');
    const b = parse(z.object({ name: z.string().min(1).max(80), role: z.enum(['service', 'viewer']).default('service'), projectId: z.string().uuid().optional() }), req.body);
    if (b.projectId && !(await ctx.db.one('SELECT 1 FROM projects WHERE id = $1', [b.projectId]))) throw new AppError('Project not found', 400, 'validation');
    const key = generateApiKey();
    const row = await ctx.db.one<any>('INSERT INTO api_keys(name, key_hash, role, created_by, project_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, role, project_id, created_at', [b.name, hashApiKey(key), b.role, a.type === 'user' ? a.id : null, b.projectId ?? null]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'api_key.create', entityType: 'api_key', entityId: row.id, ...meta(req) });
    return { ...row, key, note: 'Store this key now – it is shown only once.' };
  });

  app.get('/api/auth/api-keys', async (req) => {
    requireRole(req, 'admin');
    return ctx.db.query('SELECT id, name, role, project_id, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC');
  });

  app.delete('/api/auth/api-keys/:id', async (req) => {
    const a = requireRole(req, 'admin');
    await ctx.db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [(req.params as { id: string }).id]);
    await audit(ctx, { actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'api_key.revoke', entityId: (req.params as { id: string }).id, ...meta(req) });
    return { ok: true };
  });

  /* ── Google OAuth (Search Console + GA4 read-only) ── */
  const redirectUri = () => `${ctx.cfg.PUBLIC_API_URL.replace(/\/$/, '')}/api/integrations/google/callback`;

  app.get('/api/projects/:projectId/integrations/google/auth-url', async (req) => {
    requireRole(req, 'admin');
    if (!ctx.cfg.GOOGLE_CLIENT_ID || !ctx.cfg.GOOGLE_CLIENT_SECRET) throw new AppError('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (or use a service account).', 400, 'not_configured');
    const state = signJwt({ projectId: (req.params as { projectId: string }).projectId, purpose: 'google_oauth' }, ctx.jwtSecret, 600);
    return { url: googleAuthUrl(ctx.cfg.GOOGLE_CLIENT_ID, redirectUri(), state), redirectUri: redirectUri() };
  });

  app.get('/api/integrations/google/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const back = (status: string) => reply.redirect(`${ctx.cfg.FRONTEND_URL.replace(/\/$/, '')}/settings?google=${encodeURIComponent(status)}`);
    if (q.error || !q.code || !q.state) return back(q.error ?? 'missing_code');
    const st = verifyJwt<{ projectId: string; purpose: string }>(q.state, ctx.jwtSecret);
    if (!st || st.purpose !== 'google_oauth') return back('invalid_state');
    try {
      const tok = await exchangeGoogleCode(q.code, ctx.cfg.GOOGLE_CLIENT_ID!, ctx.cfg.GOOGLE_CLIENT_SECRET!, redirectUri());
      await ctx.db.query(
        `INSERT INTO integrations(project_id, provider, status, config, secret_encrypted, connected_at) VALUES ($1,'google_oauth','connected',$2,$3, now())
         ON CONFLICT (project_id, provider) DO UPDATE SET status = 'connected', config = EXCLUDED.config, secret_encrypted = EXCLUDED.secret_encrypted, connected_at = now(), last_error = NULL`,
        [st.projectId, { scope: tok.scope }, encryptSecret(tok.refreshToken, ctx.encryptionKey)],
      );
      await audit(ctx, { projectId: st.projectId, actorType: 'system', action: 'integration.google_connected', ...meta(req) });
      return back('connected');
    } catch (e) {
      ctx.log.error('google.oauth_failed', { error: (e as Error).message });
      return back('error');
    }
  });

  app.delete('/api/projects/:projectId/integrations/google', async (req) => {
    const a = requireRole(req, 'admin');
    const { projectId } = req.params as { projectId: string };
    await ctx.db.query(`UPDATE integrations SET status = 'disconnected', secret_encrypted = NULL WHERE project_id = $1 AND provider = 'google_oauth'`, [projectId]);
    await audit(ctx, { projectId, actorType: a.type, actorId: a.id, actorLabel: a.label, action: 'integration.google_disconnected', ...meta(req) });
    return { ok: true };
  });
}
