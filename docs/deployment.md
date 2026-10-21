# Website deployment (approved SEO changes → phoenixxit.com)

```
SEO Audit → finding → AI fix (optional) → before/after preview → human approval
→ BACKUP → apply in memory → validate → upload (temp file + rename) → checksum
→ HTTP check → re-crawl page → expected vs actual → VERIFIED / VERIFICATION_FAILED
→ audit re-scored → change log → rollback available
```

Nothing is ever written to the real website unless **all** of these are true:
1. the project is a live (non-demo) project,
2. a deployment connection is configured and a **read-only connection test passed**,
3. an **admin switched "Live deployment" on** by typing the domain (Settings → Deployment),
4. the individual change was **approved by a human** (critical changes can never be approved).

## Providers

| `WEBSITE_DEPLOYMENT_PROVIDER` | Use when | What happens on approval |
|---|---|---|
| `sftp` | GoDaddy cPanel/Linux hosting with SSH access (recommended) | File pipeline with backup, verification, automatic restore |
| `ftp` | GoDaddy cPanel without SSH | Same, over FTPS (explicit TLS). Plain FTP is refused unless `FTP_ALLOW_INSECURE=true` |
| `local` | The web root is mounted on the API server | Same, on a local directory (`LOCAL_DEPLOY_ROOT`) |
| `git` | The site lives in a Git repository | Commit on a branch; merge/deploy stays with you, then verification |
| `wordpress` | The redesign moves to WordPress | Title/meta via the REST API (application password); no core/theme edits |
| `api` | Custom CMS with an HTTP endpoint | POST apply/rollback to your endpoint |
| `manual` (default) | No connection | Approved changes are exported as instructions (JSON/CSV/Markdown) |

phoenixxit.com today is hand-written static HTML on Apache (GoDaddy) → **SFTP or FTPS**.
Only `.html/.htm` files can be changed (`DEPLOY_ALLOWED_EXTENSIONS`); PHP, JavaScript, `.htaccess`,
`cgi-bin`, `.well-known`, `wp-admin`, hidden files and anything outside the web root are refused.
Nothing is ever deleted.

Deployable change types: **title, meta description, H1, canonical, JSON-LD schema, og:image**.
Everything else (content rewrites, internal links, ALT text, redirects…) is exported as instructions.

## Connecting the real Phoenixx IT website (GoDaddy)

1. GoDaddy → My Products → Web Hosting → **Manage** → cPanel.
2. Choose one:
   - **SFTP (recommended):** cPanel → Security → *SSH Access* (enable if needed). Host = server hostname/IP, port 22, cPanel username + password (or an SSH key).
   - **FTPS:** cPanel → Files → *FTP Accounts* → create an account restricted to the site folder. Port 21, explicit TLS.
3. Find the web root: the folder containing `index.html` (usually `/public_html`, not guaranteed).
4. Enter the details in **Settings → Deployment** of the *live* project (stored encrypted), or in `.env`:
   ```env
   WEBSITE_DEPLOYMENT_PROVIDER=sftp
   SFTP_HOST=…            SFTP_PORT=22
   SFTP_USERNAME=…        SFTP_PASSWORD=…        # or SFTP_PRIVATE_KEY_FILE=/secrets/id_ed25519
   SFTP_HOST_FINGERPRINT=SHA256:…                  # shown by "Test connection"; confirm with GoDaddy
   DEPLOY_REMOTE_ROOT=/public_html
   ```
   or for FTPS: `FTP_HOST`, `FTP_PORT=21`, `FTP_USERNAME`, `FTP_PASSWORD`, `FTP_SECURE=true`
   (if GoDaddy's certificate is issued for their host name, set `FTP_TLS_SERVERNAME` to it).
5. **Test connection** (read-only): connects, finds `index.html`, and checks it matches the live homepage (proves the root is right).
6. Type the domain and **Enable live deployment**. Any later connection change switches it off again.

## Demo mode → test → live

| | Demo (`npm run demo`) | Live |
|---|---|---|
| Website | Local copy of the 11 public pages in `.data/demo-site`, served on `http://127.0.0.1:4001` | phoenixxit.com via SFTP/FTPS |
| Audits | Crawl the local copy (URLs mapped back to phoenixxit.com) | Crawl the real site |
| Deploy / rollback | Write the local copy only | Write the real site after the four conditions above |
| Labels | "DEMO MODE", "DEMO copy" everywhere | "LIVE" |

Try it: SEO Audit → *Quick wins* → **Missing H1** → View pages → Open fix → **Fix with AI** →
**Preview fix** → **Approve & deploy** (or Approve, then Changes → Deploy) → watch the steps →
Changes → **Rollback**. `git diff --no-index` between `.data/demo-site` and a copy shows exactly what changed.

Switching to live: run the API without `DEMO_MODE` (`npm run dev:api` / Docker), open the live
"Phoenixx IT" project, configure Settings → Deployment, test, enable. Start with one low-risk change.

## Safety levels

| Risk | Examples | Rule |
|---|---|---|
| LOW | title, meta description, ALT, schema, internal links | editor; one-click "Approve & deploy" |
| MEDIUM | H1/headings, content, FAQ | explicit editor approval |
| HIGH | canonical, redirects, robots, sitemap, noindex, new pages, templates/server | admin approval **after opening the preview** |
| CRITICAL | deleting files, auth, database, DNS, server configuration | never executed by the platform |

## Failure handling

| Failure | Result |
|---|---|
| Connection/credentials fail | `FAILED`, nothing touched |
| Page changed since the recommendation | `FAILED` before upload (re-audit, approve a fresh proposal) |
| Edit would alter anything but the target element | `FAILED` before upload |
| Upload or checksum fails | original restored automatically → `RESTORED` (+ alert) |
| Page returns 5xx/404 after upload | original restored automatically → `RESTORED` |
| Live page doesn't show the expected value (e.g. cache) | `VERIFICATION_FAILED`, rollback available; re-checked hourly for 48 h (workflow 13) |

Backups (`deployment_snapshots`) store the full original file (base64, byte-exact) with its SHA-256.
Rollback restores it byte for byte when the file is unchanged since deployment; if someone edited the
file since, only the changed element is reverted (using the real previous value from the backup).
After a rollback the page is re-crawled and must match its pre-deployment state field by field.

## Security

- Credentials: env vars or AES-256-GCM encrypted in `integrations.secret_encrypted` (`APP_ENCRYPTION_KEY`). Never returned by the API, never logged (audit entries are redacted), never sent to AI models (AI only sees crawler/GSC evidence).
- SFTP host keys are pinned (`SFTP_HOST_FINGERPRINT`); FTPS certificates are verified.
- Only admins configure connections, run connection tests, switch live on/off and roll back; editors approve low/medium changes and deploy approved ones; the n8n service key can deploy already-approved changes but never approve or roll back.
- Every deploy/rollback/approval/connection change is written to `audit_logs`.
- n8n events are HMAC-SHA256 signed (`N8N_EVENTS_SECRET`) with a 5-minute replay window.
