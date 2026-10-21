#!/usr/bin/env node
/**
 * Generates the importable n8n workflow JSON files in n8n/workflows/.
 * Source of truth for all workflows – edit here, then run:  node n8n/scripts/generate-workflows.mjs
 *
 * Conventions used by every workflow:
 *  - n8n only ORCHESTRATES: each step calls the SEO Agent API (POST /api/projects/:id/jobs/:type?wait=true).
 *    All business logic, AI calls and approvals live in the API, where they are tested.
 *  - Auth: header x-api-key = $env.SEO_API_KEY (a *service* key: can run jobs, can never approve changes).
 *  - Every request carries x-correlation-id = <workflow>-<executionId> so API logs, job_runs and n8n executions line up.
 *  - Retries: 3 tries, 30s apart, on every API call. Failed jobs return non-2xx → node fails → the
 *    "SEO Agent – Error Handler" workflow raises an alert in the API (which notifies Email/Slack/Teams/Telegram).
 *  - Timezone Asia/Kolkata.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../workflows');
mkdirSync(outDir, { recursive: true });

const uuid = (seed) => {
  const h = createHash('sha1').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

const ERROR_WORKFLOW_ID = 'pxSeoErrHandler1';
const API = '={{ $env.SEO_API_URL }}';
const PROJECT = '{{ $env.SEO_PROJECT_ID }}';

function schedule(name, cron, pos) {
  return { parameters: { rule: { interval: [{ field: 'cronExpression', expression: cron }] } }, name, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: pos };
}

/** POST a job to the API and wait for it to finish. */
function job(name, type, pos, { body = '{}', optional = false, timeoutMin = 30, wf } = {}) {
  return {
    parameters: {
      method: 'POST',
      url: `${API}/api/projects/${PROJECT}/jobs/${type}?wait=true`,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'x-api-key', value: '={{ $env.SEO_API_KEY }}' },
          { name: 'x-correlation-id', value: `=${wf}-{{ $execution.id }}` },
        ],
      },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: body,
      options: { timeout: timeoutMin * 60_000 },
    },
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 30000,
    ...(optional ? { onError: 'continueRegularOutput', notes: 'Optional step – failures are logged in job_runs but do not stop the workflow.' } : {}),
  };
}

function apiGet(name, pathExpr, pos, wf) {
  return {
    parameters: {
      url: `${API}/api/projects/${PROJECT}/${pathExpr}`,
      sendHeaders: true,
      headerParameters: { parameters: [{ name: 'x-api-key', value: '={{ $env.SEO_API_KEY }}' }, { name: 'x-correlation-id', value: `=${wf}-{{ $execution.id }}` }] },
      options: { timeout: 60000 },
    },
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 10000,
  };
}

function code(name, js, pos) {
  return { parameters: { jsCode: js }, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos };
}

function ifNode(name, leftValue, operator, rightValue, pos) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [{ id: uuid(name), leftValue, rightValue, operator }],
        combinator: 'and',
      },
      options: {},
    },
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position: pos,
  };
}

function stickyNote(content, pos, width = 520, height = 260) {
  return { parameters: { content, width, height }, name: `Note ${uuid(content).slice(0, 6)}`, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: pos };
}

function chain(...names) {
  const c = {};
  for (let i = 0; i < names.length - 1; i++) c[names[i]] = { main: [[{ node: names[i + 1], type: 'main', index: 0 }]] };
  return c;
}

function workflow({ id, file, name, description, nodes, connections, tags }) {
  const wf = {
    id,
    name,
    nodes: nodes.map((n) => ({ id: uuid(`${id}:${n.name}`), ...n })),
    connections,
    active: false,
    settings: {
      executionOrder: 'v1',
      timezone: 'Asia/Kolkata',
      saveDataErrorExecution: 'all',
      saveDataSuccessExecution: 'all',
      saveExecutionProgress: true,
      saveManualExecutions: true,
      ...(id !== ERROR_WORKFLOW_ID ? { errorWorkflow: ERROR_WORKFLOW_ID } : {}),
    },
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
    tags: (tags ?? []).map((t) => ({ name: t })),
    versionId: uuid(`${id}:v1`),
  };
  // Every workflow documents itself on the canvas.
  wf.nodes.unshift({ id: uuid(`${id}:note`), ...stickyNote(`## ${name}\n${description}\n\nRequires n8n env vars: SEO_API_URL, SEO_API_KEY (service key), SEO_PROJECT_ID. All logic runs in the SEO Agent API; every call is retried 3× and failures trigger the Error Handler workflow.`, [-420, -260]) });
  writeFileSync(path.join(outDir, file), JSON.stringify(wf, null, 2) + '\n');
  return wf;
}

const summarize = (label) => `// Summarise job output for the execution log (visible in n8n → Executions).
const r = $input.first().json;
return [{ json: { workflow: '${label}', status: r.status, jobId: r.jobId, correlationId: r.correlationId, output: r.output, finishedAt: new Date().toISOString() } }];`;

/* ─────────────── 00 Error handler ─────────────── */
workflow({
  id: ERROR_WORKFLOW_ID,
  file: '00-error-handler.json',
  name: 'SEO Agent – Error Handler',
  description: 'Runs whenever any SEO Agent workflow fails (after retries). Creates a HIGH alert in the SEO Agent (visible on the dashboard) which is dispatched to the configured Email / Slack / Teams / Telegram channels. n8n failures never disappear silently.',
  tags: ['seo-agent', 'ops'],
  nodes: [
    { parameters: {}, name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0] },
    code(
      'Build alert',
      `const e = $input.first().json;
const wf = e.workflow?.name ?? 'unknown workflow';
const node = e.execution?.lastNodeExecuted ?? 'unknown node';
const msg = (e.execution?.error?.message ?? 'Unknown error').slice(0, 1500);
return [{ json: {
  severity: 'high',
  type: 'n8n_workflow_failed',
  title: 'Automation failed: ' + wf,
  message: 'Node "' + node + '" failed after retries: ' + msg + (e.execution?.url ? '\\nExecution: ' + e.execution.url : ''),
  fingerprint: 'n8n:' + wf + ':' + node,
  evidence: { workflow: wf, node, executionId: e.execution?.id ?? null, mode: e.execution?.mode ?? null }
} }];`,
      [240, 0],
    ),
    {
      parameters: {
        method: 'POST',
        url: `${API}/api/projects/${PROJECT}/alerts`,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'x-api-key', value: '={{ $env.SEO_API_KEY }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json) }}',
        options: { timeout: 30000 },
      },
      name: 'Raise alert in SEO Agent',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [480, 0],
      retryOnFail: true,
      maxTries: 5,
      waitBetweenTries: 60000,
    },
  ],
  connections: chain('Error Trigger', 'Build alert', 'Raise alert in SEO Agent'),
});

/* ─────────────── 01 Daily SEO Monitor ─────────────── */
workflow({
  id: 'pxSeoDailyMon001',
  file: '01-daily-seo-monitor.json',
  name: 'SEO Agent – 01 Daily SEO Monitor',
  description: 'Schedule → Fetch Search Console → Fetch GA4 → Analyze performance / detect anomalies (traffic drops, ranking losses, uptime) → Store → Generate & dispatch alerts.',
  tags: ['seo-agent', 'daily'],
  nodes: [
    schedule('Every day 06:30 IST', '30 6 * * *', [0, 0]),
    job('Fetch Search Console', 'gsc-sync', [240, 0], { body: '={ "days": 16 }', wf: 'daily-monitor' }),
    job('Fetch GA4', 'ga4-sync', [480, 0], { body: '={ "days": 16 }', optional: true, wf: 'daily-monitor' }),
    job('Analyze & detect anomalies', 'alerts-evaluate', [720, 0], { wf: 'daily-monitor' }),
    code('Log summary', summarize('daily-monitor'), [960, 0]),
  ],
  connections: chain('Every day 06:30 IST', 'Fetch Search Console', 'Fetch GA4', 'Analyze & detect anomalies', 'Log summary'),
});

/* ─────────────── 02 Weekly Website Crawl ─────────────── */
workflow({
  id: 'pxSeoWeeklyCrawl',
  file: '02-weekly-website-crawl.json',
  name: 'SEO Agent – 02 Weekly Website Crawl & SEO Audit',
  description: 'Schedule → Crawler → Technical SEO analyzer → 10-category SEO audit score (stored in audit history) → Issue detection → AI analysis (only when the issue set changed) → Recommendations → mobile audit. Critical findings are dispatched immediately.',
  tags: ['seo-agent', 'weekly', 'audit'],
  nodes: [
    schedule('Every Monday 02:00 IST', '0 2 * * 1', [0, 0]),
    job('Crawl + audit + recommend (desktop)', 'seo-audit', [240, 0], { body: '={ "aiSummary": true, "device": "desktop" }', timeoutMin: 45, wf: 'weekly-audit' }),
    job('Mobile audit', 'seo-audit', [480, 0], { body: '={ "aiSummary": false, "device": "mobile" }', timeoutMin: 45, optional: true, wf: 'weekly-audit' }),
    ifNode('Critical issues found?', "={{ $('Crawl + audit + recommend (desktop)').first().json.output.issues.critical ?? 0 }}", { type: 'number', operation: 'gt' }, 0, [720, 0]),
    job('Dispatch alerts', 'alerts-dispatch', [960, -100], { wf: 'weekly-audit' }),
    code('Log summary', summarize('weekly-audit'), [960, 100]),
  ],
  connections: {
    ...chain('Every Monday 02:00 IST', 'Crawl + audit + recommend (desktop)', 'Mobile audit', 'Critical issues found?'),
    'Critical issues found?': { main: [[{ node: 'Dispatch alerts', type: 'main', index: 0 }], [{ node: 'Log summary', type: 'main', index: 0 }]] },
    'Dispatch alerts': { main: [[{ node: 'Log summary', type: 'main', index: 0 }]] },
  },
});

/* ─────────────── 03 Keyword Opportunity Discovery ─────────────── */
workflow({
  id: 'pxSeoKeywordDisc',
  file: '03-keyword-opportunity-discovery.json',
  name: 'SEO Agent – 03 Keyword Opportunity Discovery',
  description: 'Schedule → Search Console → Keyword processor → Intent classification (rules, AI refines low-confidence only) → Clustering → Opportunity scoring → Database. Search volume is never fabricated; impressions are the demand signal.',
  tags: ['seo-agent', 'weekly'],
  nodes: [
    schedule('Every Tuesday 03:00 IST', '0 3 * * 2', [0, 0]),
    job('Refresh Search Console', 'gsc-sync', [240, 0], { body: '={ "days": 16 }', wf: 'keyword-discovery' }),
    job('Process, classify, cluster, score', 'keywords', [480, 0], { body: '={ "useAi": true }', wf: 'keyword-discovery' }),
    code('Log summary', summarize('keyword-discovery'), [720, 0]),
  ],
  connections: chain('Every Tuesday 03:00 IST', 'Refresh Search Console', 'Process, classify, cluster, score', 'Log summary'),
});

/* ─────────────── 04 Content Opportunity Agent ─────────────── */
workflow({
  id: 'pxSeoContentAgnt',
  file: '04-content-opportunity-agent.json',
  name: 'SEO Agent – 04 Content Opportunity Agent',
  description: 'Keyword opportunities → Content gap analysis → AI → Content brief → HUMAN APPROVAL. Generates briefs for the top 3 high-priority opportunities; briefs land in the Approval Center. n8n can never approve or publish.',
  tags: ['seo-agent', 'weekly', 'content'],
  nodes: [
    schedule('Every Wednesday 03:00 IST', '0 3 * * 3', [0, 0]),
    job('Content gap analysis', 'content-opportunities', [240, 0], { body: '={ "useAi": true }', wf: 'content-agent' }),
    apiGet('Load opportunities', 'content', [480, 0], 'content-agent'),
    code(
      'Pick top 3 open high-priority',
      `const opps = ($input.first().json.opportunities ?? [])
  .filter(o => o.status === 'open' && ['high','critical'].includes(o.priority))
  .slice(0, 3);
return opps.map(o => ({ json: { id: o.id, title: o.title, score: o.score } }));`,
      [720, 0],
    ),
    {
      parameters: {
        method: 'POST',
        url: `${API}/api/projects/${PROJECT}/content/opportunities/{{ $json.id }}/brief`,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'x-api-key', value: '={{ $env.SEO_API_KEY }}' }, { name: 'x-correlation-id', value: '=content-agent-{{ $execution.id }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={}',
        options: { timeout: 300000 },
      },
      name: 'Generate brief (→ approval queue)',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [960, 0],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 30000,
    },
    code('Log summary', `return [{ json: { workflow: 'content-agent', briefsCreated: $input.all().length, note: 'Briefs await human approval in the Approval Center.' } }];`, [1200, 0]),
  ],
  connections: chain('Every Wednesday 03:00 IST', 'Content gap analysis', 'Load opportunities', 'Pick top 3 open high-priority', 'Generate brief (→ approval queue)', 'Log summary'),
});

/* ─────────────── 05 On-Page Optimization ─────────────── */
workflow({
  id: 'pxSeoOnPageOpt01',
  file: '05-on-page-optimization.json',
  name: 'SEO Agent – 05 On-Page Optimization',
  description: 'Branch A (webhook): page selected → current SEO analysis → AI optimisation → before/after recommendations → Approval Center.\nBranch B (every 30 min): approved changes → implementation via the website adapter (git/WordPress/API, or manual export) → verification on the live page → experiment monitoring.\nPOST {"pageUrl": "https://www.phoenixxit.com/automation"} to /webhook/seo-onpage.',
  tags: ['seo-agent', 'on-page'],
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'seo-onpage', responseMode: 'lastNode', options: {} }, name: 'Page selected (webhook)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: uuid('seo-onpage') },
    ifNode('Valid pageUrl?', '={{ $json.body.pageUrl }}', { type: 'string', operation: 'startsWith' }, 'http', [240, 0]),
    job('AI on-page optimisation', 'onpage-optimize', [480, -80], { body: '={{ JSON.stringify({ pageUrl: $json.body.pageUrl }) }}', timeoutMin: 10, wf: 'onpage' }),
    code('Respond', `const r = $input.first().json;\nreturn [{ json: { ok: r.status === 'succeeded', recommendations: r.output?.recommendations ?? 0, note: 'Recommendations are pending approval in the dashboard.' } }];`, [720, -80]),
    code('Reject request', `return [{ json: { ok: false, error: 'Body must be {"pageUrl": "https://..."}' } }];`, [480, 100]),
    schedule('Every 30 minutes', '*/30 * * * *', [0, 320]),
    job('Implement approved + verify', 'process-changes', [240, 320], { timeoutMin: 20, wf: 'implement-verify' }),
    code('Log summary', summarize('implement-verify'), [480, 320]),
  ],
  connections: {
    'Page selected (webhook)': { main: [[{ node: 'Valid pageUrl?', type: 'main', index: 0 }]] },
    'Valid pageUrl?': { main: [[{ node: 'AI on-page optimisation', type: 'main', index: 0 }], [{ node: 'Reject request', type: 'main', index: 0 }]] },
    'AI on-page optimisation': { main: [[{ node: 'Respond', type: 'main', index: 0 }]] },
    ...chain('Every 30 minutes', 'Implement approved + verify', 'Log summary'),
  },
});

/* ─────────────── 06 Internal Linking Agent ─────────────── */
workflow({
  id: 'pxSeoIntLinks001',
  file: '06-internal-linking-agent.json',
  name: 'SEO Agent – 06 Internal Linking Agent',
  description: 'Website crawl (latest) → Build page/topic graph (TF-IDF similarity + inlink counts) → Find linking opportunities → AI anchor recommendations → Approval. Links are never inserted automatically.',
  tags: ['seo-agent', 'weekly'],
  nodes: [
    schedule('Every Monday 04:00 IST', '0 4 * * 1', [0, 0]),
    job('Graph + opportunities + AI anchors', 'internal-links', [240, 0], { body: '={ "useAi": true }', wf: 'internal-links' }),
    code('Log summary', summarize('internal-links'), [480, 0]),
  ],
  connections: chain('Every Monday 04:00 IST', 'Graph + opportunities + AI anchors', 'Log summary'),
});

/* ─────────────── 07 Local SEO Monitor ─────────────── */
workflow({
  id: 'pxSeoLocalMon001',
  file: '07-local-seo-monitor.json',
  name: 'SEO Agent – 07 Local SEO Monitor',
  description: 'Search data → Location analysis → Service × Location opportunities (Coimbatore / Tamil Nadu / India first) → Recommendations. New location pages are only suggested with real demand evidence; no thin doorway pages.',
  tags: ['seo-agent', 'weekly', 'local'],
  nodes: [
    schedule('Every Thursday 03:00 IST', '0 3 * * 4', [0, 0]),
    job('Local SEO analysis', 'local-seo', [240, 0], { body: '={ "useAi": true }', wf: 'local-seo' }),
    code('Log summary', summarize('local-seo'), [480, 0]),
  ],
  connections: chain('Every Thursday 03:00 IST', 'Local SEO analysis', 'Log summary'),
});

/* ─────────────── 08 Weekly Report ─────────────── */
workflow({
  id: 'pxSeoWeeklyRpt01',
  file: '08-weekly-report.json',
  name: 'SEO Agent – 08 Weekly Report',
  description: 'Analytics + Search Console + Crawler + SEO engine → experiment evaluation → AI summary (from the numbers only; correlation ≠ causation) → HTML/Markdown report → Email (SMTP) + dashboard.',
  tags: ['seo-agent', 'weekly', 'reporting'],
  nodes: [
    schedule('Every Monday 08:00 IST', '0 8 * * 1', [0, 0]),
    job('Evaluate experiments', 'experiments-evaluate', [240, 0], { optional: true, wf: 'weekly-report' }),
    job('Build & send weekly report', 'weekly-report', [480, 0], { body: '={ "send": true }', wf: 'weekly-report' }),
    code('Log summary', summarize('weekly-report'), [720, 0]),
  ],
  connections: chain('Every Monday 08:00 IST', 'Evaluate experiments', 'Build & send weekly report', 'Log summary'),
});

/* ─────────────── 09 Monthly Competitor Analysis ─────────────── */
workflow({
  id: 'pxSeoCompetitors',
  file: '09-monthly-competitor-analysis.json',
  name: 'SEO Agent – 09 Monthly Competitor Analysis',
  description: 'Crawls the competitor URLs configured in the dashboard (robots.txt respected, 1 request/second, structure only – no content copied), then refreshes content gap analysis.',
  tags: ['seo-agent', 'monthly'],
  nodes: [
    schedule('1st of month 04:00 IST', '0 4 1 * *', [0, 0]),
    job('Analyze competitors', 'competitor-analyze', [240, 0], { timeoutMin: 60, wf: 'competitors' }),
    job('Refresh content gaps', 'content-opportunities', [480, 0], { body: '={ "useAi": false }', wf: 'competitors' }),
    code('Log summary', summarize('competitors'), [720, 0]),
  ],
  connections: chain('1st of month 04:00 IST', 'Analyze competitors', 'Refresh content gaps', 'Log summary'),
});

/* ─────────────── 10 Weekly Backlink Monitor ─────────────── */
workflow({
  id: 'pxSeoBacklinks01',
  file: '10-weekly-backlink-monitor.json',
  name: 'SEO Agent – 10 Weekly Backlink Monitor',
  description: 'Pull backlinks from the configured provider (optional; CSV imports work without one) → check every linking page live → alert on lost links → 301 recommendations for links pointing at broken pages (admin approval). Monitoring only: never contacts sites or builds links.',
  tags: ['seo-agent', 'weekly', 'backlinks'],
  nodes: [
    schedule('Every Wednesday 04:00 IST', '0 4 * * 3', [0, 0]),
    job('Sync backlinks from provider', 'backlinks-sync', [240, 0], { optional: true, wf: 'backlinks' }),
    job('Verify links + broken targets', 'backlinks-verify', [480, 0], { timeoutMin: 40, wf: 'backlinks' }),
    job('Send alerts', 'alerts-dispatch', [720, 0], { optional: true, wf: 'backlinks' }),
    code('Log summary', summarize('backlinks'), [960, 0]),
  ],
  connections: chain('Every Wednesday 04:00 IST', 'Sync backlinks from provider', 'Verify links + broken targets', 'Send alerts', 'Log summary'),
});

/* ─────────────── 11 SEO Audit (on demand) ─────────────── */
workflow({
  id: 'pxSeoAuditHook01',
  file: '11-seo-audit-on-demand.json',
  name: 'SEO Agent – 11 SEO Audit (on demand)',
  description: 'Webhook → full crawl → 10-category SEO audit (score, checks, quick wins) → audit history. POST {"device": "desktop" | "mobile"} to /webhook/seo-audit. The weekly audit runs in workflow 02.',
  tags: ['seo-agent', 'audit'],
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'seo-audit', responseMode: 'lastNode', options: {} }, name: 'Audit requested (webhook)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: uuid('seo-audit') },
    job('Run SEO audit', 'seo-audit', [240, 0], { body: "={{ JSON.stringify({ device: $json.body?.device === 'mobile' ? 'mobile' : 'desktop', aiSummary: true }) }}", timeoutMin: 45, wf: 'seo-audit' }),
    code(
      'Respond',
      `const r = $input.first().json;
return [{ json: { ok: r.status === 'succeeded', auditId: r.output?.auditId ?? null, score: r.output?.auditScore ?? null, pages: r.output?.pagesCrawled ?? null } }];`,
      [480, 0],
    ),
  ],
  connections: chain('Audit requested (webhook)', 'Run SEO audit', 'Respond'),
});

/* ─────────────── 12 Change Deployment & Notifications ─────────────── */
const verifySignature = `// Reject forged or replayed events: HMAC-SHA256 over "<t>.<body>" with N8N_EVENTS_SECRET (same value as the API).
const crypto = require('crypto');
const item = $input.first().json;
const sig = String(item.headers['x-phoenixx-signature'] ?? '');
const m = /^t=(\\d+),v1=([a-f0-9]{64})$/.exec(sig);
if (!m) throw new Error('Missing or malformed x-phoenixx-signature');
if (!$env.N8N_EVENTS_SECRET) throw new Error('N8N_EVENTS_SECRET is not set in n8n');
const expected = crypto.createHmac('sha256', $env.N8N_EVENTS_SECRET).update(m[1] + '.' + JSON.stringify(item.body)).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]))) throw new Error('Invalid event signature');
if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) throw new Error('Stale event (older than 5 minutes)');
if (item.body.projectId !== $env.SEO_PROJECT_ID) throw new Error('Event for another project');
return [{ json: item.body }];`;

const formatNotification = `const e = $input.first().json;
// Failures are already alerted by the API itself; only successes and rollbacks are announced here.
if (!(e.event === 'deployment.completed' && e.data.status === 'verified') && e.event !== 'rollback.completed') return [];
const ok = e.event === 'deployment.completed';
const score = e.data.auditScore != null ? ' Audit score now ' + e.data.auditScore + '/100.' : '';
return [{ json: {
  severity: ok ? 'info' : 'medium',
  type: 'deployment_event',
  title: ok ? 'SEO change deployed and verified' : 'SEO change rolled back',
  message: 'Change ' + (e.data.changeId ?? '') + (ok ? ' is live and verified.' + score : ' was rolled back.'),
  fingerprint: e.event + ':' + (e.data.deploymentId ?? e.data.changeId),
  evidence: e.data
} }];`;

workflow({
  id: 'pxSeoDeployEvt01',
  file: '12-change-deployment.json',
  name: 'SEO Agent – 12 Change Deployment & Notifications',
  description: 'The SEO Agent POSTs signed events here (set N8N_EVENTS_WEBHOOK_URL=<n8n>/webhook/seo-events and the same N8N_EVENTS_SECRET in both). change.approved → deployment pipeline (backup → deploy → verify → re-score; live only if an admin enabled it). deployment.completed (verified) / rollback.completed → notification. Failures are alerted by the API itself. n8n never approves or rolls back – those are human actions in the app.',
  tags: ['seo-agent', 'deployment'],
  nodes: [
    { parameters: { httpMethod: 'POST', path: 'seo-events', responseMode: 'onReceived', options: {} }, name: 'SEO Agent event (webhook)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: uuid('seo-events') },
    code('Verify signature', verifySignature, [240, 0]),
    ifNode('Change approved?', '={{ $json.event }}', { type: 'string', operation: 'equals' }, 'change.approved', [480, 0]),
    job('Deploy + verify', 'deploy-change', [720, -100], { body: '={{ JSON.stringify({ changeId: $json.data.changeId, requestedBy: "n8n (approved by " + ($json.data.by ?? "?") + ")" }) }}', timeoutMin: 10, wf: 'deploy' }),
    code('Log deployment', summarize('deploy'), [960, -100]),
    code('Format notification', formatNotification, [720, 100]),
    {
      parameters: {
        method: 'POST',
        url: `${API}/api/projects/${PROJECT}/alerts`,
        sendHeaders: true,
        headerParameters: { parameters: [{ name: 'x-api-key', value: '={{ $env.SEO_API_KEY }}' }, { name: 'x-correlation-id', value: '=deploy-notify-{{ $execution.id }}' }] },
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json) }}',
        options: { timeout: 30000 },
      },
      name: 'Notify via SEO Agent',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [960, 100],
      retryOnFail: true,
      maxTries: 3,
      waitBetweenTries: 30000,
    },
  ],
  connections: {
    ...chain('SEO Agent event (webhook)', 'Verify signature', 'Change approved?'),
    'Change approved?': { main: [[{ node: 'Deploy + verify', type: 'main', index: 0 }], [{ node: 'Format notification', type: 'main', index: 0 }]] },
    'Deploy + verify': { main: [[{ node: 'Log deployment', type: 'main', index: 0 }]] },
    'Format notification': { main: [[{ node: 'Notify via SEO Agent', type: 'main', index: 0 }]] },
  },
});

/* ─────────────── 13 Post-Deployment Verification ─────────────── */
workflow({
  id: 'pxSeoPostDeploy1',
  file: '13-post-deployment-verification.json',
  name: 'SEO Agent – 13 Post-Deployment Verification',
  description: 'Hourly: re-crawl pages whose deployment was flagged VERIFICATION_FAILED in the last 48 h (CDN/page caches often catch up) → mark VERIFIED when the live page matches → re-score the audit. Anything still failing stays flagged with rollback available in the dashboard.',
  tags: ['seo-agent', 'deployment'],
  nodes: [
    schedule('Every hour', '15 * * * *', [0, 0]),
    job('Re-verify deployments', 'verify-deployments', [240, 0], { timeoutMin: 10, wf: 'post-deploy' }),
    job('Dispatch alerts', 'alerts-dispatch', [480, 0], { optional: true, wf: 'post-deploy' }),
    code('Log summary', summarize('post-deploy'), [720, 0]),
  ],
  connections: chain('Every hour', 'Re-verify deployments', 'Dispatch alerts', 'Log summary'),
});

/* ─────────────── 14 Daily Opportunities & Autopilot ─────────────── */
workflow({
  id: 'pxSeoOppAutopil1',
  file: '14-daily-opportunities-autopilot.json',
  name: 'SEO Agent – 14 Daily Opportunities & Autopilot',
  description: 'Daily: re-rank every opportunity (documented formula) → Next Best Action → if the project is at automation level 3/4, approve + deploy eligible LOW-risk fixes (never high/critical; daily cap; same backup/verify/rollback pipeline) → dispatch alerts.',
  tags: ['seo-agent', 'daily', 'autopilot'],
  nodes: [
    schedule('Every day 07:00 IST', '0 7 * * *', [0, 0]),
    job('Refresh opportunities', 'opportunities', [240, 0], { wf: 'opportunities' }),
    job('Autopilot (level 3/4 only)', 'autopilot', [480, 0], { optional: true, timeoutMin: 20, wf: 'opportunities' }),
    job('Dispatch alerts', 'alerts-dispatch', [720, 0], { optional: true, wf: 'opportunities' }),
    code('Log summary', summarize('opportunities'), [960, 0]),
  ],
  connections: chain('Every day 07:00 IST', 'Refresh opportunities', 'Autopilot (level 3/4 only)', 'Dispatch alerts', 'Log summary'),
});

console.log(`Workflows written to ${outDir}`);
