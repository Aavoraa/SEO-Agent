import { AppError, ORG_ROLE_TO_PROJECT_ROLE, type OrgRole } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import type { Actor } from './common.js';

export type ProjectRole = 'admin' | 'editor' | 'viewer';

/**
 * Tenant isolation. Returns the actor with its role *for this project*:
 *  - platform admins and the env service key (n8n) reach every project;
 *  - API keys scoped to a project/organization reach only that project/organization;
 *  - users: an explicit project membership wins; otherwise their organization role maps to a
 *    project role (owner/admin/manager → admin, specialists/editors/developers → editor,
 *    viewer/client → viewer).
 * Anything else is a 404, so other tenants' projects are never revealed.
 */
export async function actorForProject(ctx: AppContext, actor: Actor, projectId: string): Promise<Actor> {
  const denied = () => new AppError('Project not found', 404, 'not_found');
  if (actor.type === 'api_key') {
    if (actor.projectScope && actor.projectScope !== projectId) throw denied();
    if (actor.orgScope) {
      const p = await ctx.db.one<{ organization_id: string }>('SELECT organization_id FROM projects WHERE id = $1', [projectId]);
      if (!p || p.organization_id !== actor.orgScope) throw denied();
    }
    return actor;
  }
  if (actor.type === 'system' || actor.role === 'admin') return actor;
  const m = await ctx.db.one<{ role: ProjectRole }>('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, actor.id]);
  if (m) return { ...actor, role: m.role };
  const o = await ctx.db.one<{ role: OrgRole }>('SELECT om.role FROM organization_members om JOIN projects p ON p.organization_id = om.organization_id WHERE p.id = $1 AND om.user_id = $2', [projectId, actor.id]);
  if (!o) throw denied();
  return { ...actor, role: ORG_ROLE_TO_PROJECT_ROLE[o.role], orgRole: o.role };
}

/** Projects the actor can see (null = all). */
export async function visibleProjectIds(ctx: AppContext, actor: Actor): Promise<string[] | null> {
  if (actor.type === 'api_key') {
    if (actor.projectScope) return [actor.projectScope];
    if (actor.orgScope) return (await ctx.db.query<{ id: string }>('SELECT id FROM projects WHERE organization_id = $1', [actor.orgScope])).map((r) => r.id);
    return null;
  }
  if (actor.type === 'system' || actor.role === 'admin') return null;
  return (
    await ctx.db.query<{ id: string }>(
      `SELECT project_id AS id FROM project_members WHERE user_id = $1
       UNION SELECT p.id FROM projects p JOIN organization_members om ON om.organization_id = p.organization_id WHERE om.user_id = $1`,
      [actor.id],
    )
  ).map((r) => r.id);
}

export async function membershipsOf(ctx: AppContext, userId: string) {
  return ctx.db.query<{ projectId: string; role: ProjectRole }>('SELECT project_id AS "projectId", role FROM project_members WHERE user_id = $1 ORDER BY created_at', [userId]);
}

export async function organizationsOf(ctx: AppContext, userId: string) {
  return ctx.db.query<{ id: string; name: string; slug: string; role: OrgRole; planId: string; isDemo: boolean; branding: Record<string, unknown> }>(
    `SELECT o.id, o.name, o.slug, om.role, o.plan_id AS "planId", o.is_demo AS "isDemo", o.branding FROM organization_members om JOIN organizations o ON o.id = om.organization_id WHERE om.user_id = $1 ORDER BY o.created_at`,
    [userId],
  );
}

export async function setMembership(ctx: AppContext, projectId: string, userId: string, role: ProjectRole) {
  const user = await ctx.db.one<{ id: string; role: string }>('SELECT id, role FROM users WHERE id = $1', [userId]);
  if (!user) throw new AppError('User not found', 404, 'not_found');
  await ctx.db.query(`INSERT INTO project_members(project_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [projectId, userId, role]);
}
