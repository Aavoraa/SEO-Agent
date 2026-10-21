import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, hashApiKey, safeEqual, verifyJwt } from '@phoenixx/shared';
import type { AppContext } from './context.js';
import type { Actor } from './services/common.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor?: Actor;
    authError?: Error;
    correlationId: string;
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new AppError('Validation failed', 400, 'validation', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

/** Resolves the caller from a Bearer JWT (users) or an x-api-key (n8n / integrations). */
export async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<Actor | null> {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) {
    if (ctx.cfg.SERVICE_API_KEY && safeEqual(apiKey, ctx.cfg.SERVICE_API_KEY)) return { type: 'api_key', id: 'env:SERVICE_API_KEY', label: 'n8n/service', role: 'service' };
    const row = await ctx.db.one<{ id: string; name: string; role: Actor['role']; project_id: string | null; organization_id: string | null }>('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, name, role, project_id, organization_id', [hashApiKey(apiKey)]);
    if (row) return { type: 'api_key', id: row.id, label: `api-key:${row.name}`, role: row.role, projectScope: row.project_id, orgScope: row.organization_id };
    throw new AppError('Invalid API key', 401, 'unauthorized');
  }
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const payload = verifyJwt<{ sub: string }>(auth.slice(7), ctx.jwtSecret);
    if (!payload) throw new AppError('Invalid or expired token', 401, 'unauthorized');
    const user = await ctx.db.one<{ id: string; email: string; role: Actor['role']; is_active: boolean }>('SELECT id, email, role, is_active FROM users WHERE id = $1', [payload.sub]);
    if (!user || !user.is_active) throw new AppError('User disabled', 401, 'unauthorized');
    return { type: 'user', id: user.id, label: user.email, role: user.role };
  }
  return null;
}

export function requireActor(req: FastifyRequest): Actor {
  if (req.authError) throw req.authError;
  if (!req.actor) throw new AppError('Authentication required', 401, 'unauthorized');
  return req.actor;
}

/** Role gate. 'service' (n8n) may run jobs and read, but can never approve or change settings. */
export function requireRole(req: FastifyRequest, ...roles: Actor['role'][]): Actor {
  const a = requireActor(req);
  if (!roles.includes(a.role) && !(roles.includes('editor') && a.role === 'admin')) throw new AppError(`Requires role: ${roles.join(' or ')}`, 403, 'forbidden');
  return a;
}

export function meta(req: FastifyRequest) {
  return { ip: req.ip, requestId: req.correlationId };
}

export function sendCsv(reply: FastifyReply, filename: string, rows: Record<string, unknown>[]) {
  const cols = rows.length ? Object.keys(rows[0]!) : [];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])).join(','))].join('\n');
}

export const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) });
