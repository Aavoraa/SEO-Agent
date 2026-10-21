import { createHmac } from 'node:crypto';
import type { AppContext } from '../context.js';

/** Every event the platform emits (n8n + customer webhooks). */
export const PLATFORM_EVENTS = [
  'audit.completed',
  'recommendation.created',
  'approval.required',
  'change.approved',
  'deployment.started',
  'deployment.completed',
  'deployment.failed',
  'verification.completed',
  'rollback.completed',
  'alert.created',
  'ranking.changed',
  'traffic.changed',
] as const;
export type PlatformEvent = (typeof PLATFORM_EVENTS)[number];

/**
 * HMAC-SHA256 signature `t=<unix>,v1=<hex>` over `${t}.${body}` – the same scheme for n8n and
 * customer webhooks, so receivers can reject forged or replayed calls.
 */
export function signEvent(body: string, secret: string, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/**
 * Emits a platform event: to n8n (N8N_EVENTS_WEBHOOK_URL, signed with N8N_EVENTS_SECRET) and to the
 * organization's subscribed webhooks. Events carry ids, statuses and counts – never credentials or
 * page content. Delivery is best-effort and never breaks the calling workflow.
 */
export async function emitEvent(ctx: AppContext, projectId: string, event: PlatformEvent, data: Record<string, unknown>) {
  const out: { n8n: unknown; webhooks: unknown[] } = { n8n: null, webhooks: [] };
  try {
    const org = await ctx.db.one<{ organization_id: string | null }>('SELECT organization_id FROM projects WHERE id = $1', [projectId]);
    if (org?.organization_id) {
      const { deliverToOrgWebhooks } = await import('./webhooks.js');
      out.webhooks = await deliverToOrgWebhooks(ctx, org.organization_id, projectId, event, data);
    }
  } catch (e) {
    ctx.log.warn('events.webhooks_failed', { event, error: (e as Error).message });
  }
  out.n8n = await sendToN8n(ctx, projectId, event, data);
  return { sent: (out.n8n as { sent: boolean }).sent, ...out };
}

async function sendToN8n(ctx: AppContext, projectId: string, event: PlatformEvent, data: Record<string, unknown>) {
  const url = ctx.cfg.N8N_EVENTS_WEBHOOK_URL;
  if (!url) return { sent: false as const, reason: 'N8N_EVENTS_WEBHOOK_URL not set' };
  if (!ctx.cfg.N8N_EVENTS_SECRET) {
    ctx.log.warn('events.unsigned_refused', { event });
    return { sent: false as const, reason: 'N8N_EVENTS_SECRET not set – refusing to send unsigned events' };
  }
  const body = JSON.stringify({ event, projectId, at: new Date().toISOString(), data });
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-phoenixx-signature': signEvent(body, ctx.cfg.N8N_EVENTS_SECRET) }, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) ctx.log.warn('events.delivery_failed', { event, status: r.status });
    return { sent: r.ok, status: r.status };
  } catch (e) {
    ctx.log.warn('events.delivery_failed', { event, error: (e as Error).message });
    return { sent: false as const, reason: (e as Error).message };
  }
}
