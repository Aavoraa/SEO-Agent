import nodemailer from 'nodemailer';
import { SEVERITY_RANK, type AppConfig, type Severity } from '@phoenixx/shared';

export interface Notification {
  severity: Severity;
  title: string;
  message: string;
  url?: string;
  html?: string;
}

export interface Notifier {
  readonly channel: 'email' | 'slack' | 'teams' | 'telegram';
  send(n: Notification): Promise<void>;
}

const EMOJI: Record<Severity, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵', info: '⚪' };

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Webhook ${new URL(url).hostname} responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export class EmailNotifier implements Notifier {
  readonly channel = 'email' as const;
  private transport: ReturnType<typeof nodemailer.createTransport>;
  constructor(
    private cfg: { host: string; port: number; user?: string; password?: string; from: string; to: string },
  ) {
    this.transport = nodemailer.createTransport({ host: cfg.host, port: cfg.port, secure: cfg.port === 465, auth: cfg.user ? { user: cfg.user, pass: cfg.password } : undefined });
  }
  async send(n: Notification) {
    await this.transport.sendMail({ from: this.cfg.from, to: this.cfg.to, subject: `[SEO ${n.severity.toUpperCase()}] ${n.title}`, text: `${n.message}${n.url ? `\n\n${n.url}` : ''}`, html: n.html });
  }
}

export class SlackNotifier implements Notifier {
  readonly channel = 'slack' as const;
  constructor(private webhookUrl: string) {}
  send(n: Notification) {
    return postJson(this.webhookUrl, { text: `${EMOJI[n.severity]} *${n.title}*\n${n.message}${n.url ? `\n<${n.url}|Open in dashboard>` : ''}` });
  }
}

export class TeamsNotifier implements Notifier {
  readonly channel = 'teams' as const;
  constructor(private webhookUrl: string) {}
  send(n: Notification) {
    // Adaptive card payload accepted by Teams Workflows (Power Automate) webhooks.
    return postJson(this.webhookUrl, {
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `${EMOJI[n.severity]} ${n.title}`, wrap: true },
              { type: 'TextBlock', text: n.message, wrap: true },
            ],
            actions: n.url ? [{ type: 'Action.OpenUrl', title: 'Open dashboard', url: n.url }] : [],
          },
        },
      ],
    });
  }
}

export class TelegramNotifier implements Notifier {
  readonly channel = 'telegram' as const;
  constructor(
    private token: string,
    private chatId: string,
  ) {}
  send(n: Notification) {
    return postJson(`https://api.telegram.org/bot${this.token}/sendMessage`, { chat_id: this.chatId, text: `${EMOJI[n.severity]} ${n.title}\n\n${n.message}${n.url ? `\n${n.url}` : ''}`, disable_web_page_preview: true });
  }
}

/** Builds only the channels that are fully configured in the environment. */
export function notifiersFromConfig(cfg: AppConfig): Notifier[] {
  const out: Notifier[] = [];
  if (cfg.SMTP_HOST && cfg.REPORT_EMAIL_TO) out.push(new EmailNotifier({ host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, user: cfg.SMTP_USER, password: cfg.SMTP_PASSWORD, from: cfg.SMTP_FROM ?? cfg.SMTP_USER ?? 'seo-agent@localhost', to: cfg.REPORT_EMAIL_TO }));
  if (cfg.SLACK_WEBHOOK_URL) out.push(new SlackNotifier(cfg.SLACK_WEBHOOK_URL));
  if (cfg.TEAMS_WEBHOOK_URL) out.push(new TeamsNotifier(cfg.TEAMS_WEBHOOK_URL));
  if (cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID) out.push(new TelegramNotifier(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_CHAT_ID));
  return out;
}

/** Sends to every channel whose minimum severity is met; returns per-channel outcome (failures never throw). */
export async function dispatch(notifiers: Notifier[], n: Notification, minSeverity: Record<string, Severity> = {}): Promise<{ channel: string; ok: boolean; error?: string }[]> {
  const results = [];
  for (const nt of notifiers) {
    const min = minSeverity[nt.channel] ?? 'high';
    if (SEVERITY_RANK[n.severity] < SEVERITY_RANK[min]) continue;
    try {
      await nt.send(n);
      results.push({ channel: nt.channel, ok: true });
    } catch (e) {
      results.push({ channel: nt.channel, ok: false, error: (e as Error).message });
    }
  }
  return results;
}
