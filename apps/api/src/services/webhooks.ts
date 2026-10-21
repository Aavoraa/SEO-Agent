import { randomUUID } from 'node:crypto';
import { AppError, decryptSecret } from '@phoenixx/shared';
import type { AppContext } from '../context.js';
import { assertPublicHost } from './net-guard.js';
import { signEvent } from './events.js';

/**
 * Customer webhooks. Body: {id, event, createdAt, organizationId, projectId, data}.
 * Headers: x-webhook-id, x-webhook-event, x-webhook-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">.
 * Receivers should reject signatures older than 5 minutes. Endpoints are disabled after 20 consecutive failures.
 */
const MAX_FAILURES = 20;

async function deliverOne(ctx: AppContext, ep: { id: string; url: string; secret_encrypted: string }, event: string, body: string) {
  const started = Date.now();
  let status: number | null = null;
  let error: string | null = null;
  try {
    await assertPublicHost(ep.url, ctx.cfg.WEBHOOK_ALLOW_PRIVATE_HOSTS);
    const secret = decryptSecret(ep.secret_encrypted, ctx.encryptionKey);
    const r = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `${ctx.cfg.PRODUCT_NAME}-Webhooks/1.0`, 'x-webhook-event': event, 'x-webhook-id': JSON.parse(body).id, 'x-webhook-signature': signEvent(body, secret) },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    status = r.status;
    if (!r.ok) error = `HTTP ${r.status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  const success = !error;
  await ctx.db.query('INSERT INTO webhook_deliveries(endpoint_id, event, status_code, success, error, duration_ms) VALUES ($1,$2,$3,$4,$5,$6)', [ep.id, event, status, success, error, Date.now() - started]);
  await ctx.db.query(
    `UPDATE webhook_endpoints SET last_delivery_at = now(), failures = CASE WHEN $2 THEN 0 ELSE failures + 1 END, active = CASE WHEN NOT $2 AND failures + 1 >= $3 THEN false ELSE active END WHERE id = $1`,
    [ep.id, success, MAX_FAILURES],
  );
  return { endpointId: ep.id, success, status, error };
}

export async function deliverToOrgWebhooks(ctx: AppContext, orgId: string, projectId: string | null, event: string, data: Record<string, unknown>) {
  const eps = await ctx.db.query<{ id: string; url: string; secret_encrypted: string }>(`SELECT id, url, secret_encrypted FROM webhook_endpoints WHERE organization_id = $1 AND active AND $2 = ANY(events)`, [orgId, event]);
  if (!eps.length) return [];
  const body = JSON.stringify({ id: randomUUID(), event, createdAt: new Date().toISOString(), organizationId: orgId, projectId, data });
  const results = await Promise.allSettled(eps.map((ep) => deliverOne(ctx, ep, event, body)));
  return results.map((r) => (r.status === 'fulfilled' ? r.value : { success: false, error: String(r.reason) }));
}

export async function sendWebhookTest(ctx: AppContext, orgId: string, endpointId: string) {
  const ep = await ctx.db.one<{ id: string; url: string; secret_encrypted: string }>('SELECT id, url, secret_encrypted FROM webhook_endpoints WHERE id = $1 AND organization_id = $2', [endpointId, orgId]);
  if (!ep) throw new AppError('Webhook not found', 404, 'not_found');
  const body = JSON.stringify({ id: randomUUID(), event: 'webhook.test', createdAt: new Date().toISOString(), organizationId: orgId, projectId: null, data: { message: 'Test delivery' } });
  return deliverOne(ctx, ep, 'webhook.test', body);
}
