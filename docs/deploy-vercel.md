# Deploying on Vercel

`vercel.json` deploys the **dashboard** (static, `apps/dashboard/dist`) and the **API** as one Node
serverless function (`api/index.js` → `apps/api/dist/vercel.js`). It sets `"framework": null`, so it
overrides a wrong project preset (e.g. "FastAPI") – this is a Node/TypeScript project, not Python.

## Project settings
- Root Directory: repository root (leave empty)
- Framework preset: *Other* (vercel.json overrides it anyway)
- Node.js: 20.x or newer

## Modes
| Env vars on the Vercel project | Result |
|---|---|
| none | **Demo** – sample data in an embedded database in `/tmp`, seeded on cold start (~10–15 s first request). Data is per instance and resets on cold starts. Use "Explore demo" on the login page. |
| `DATABASE_URL` (Postgres, e.g. Neon via Vercel Marketplace) + `JWT_SECRET`, `APP_ENCRYPTION_KEY`, `SERVICE_API_KEY` (32+ random chars each) | **Production** – migrations run automatically on cold start; create the first admin on the setup screen. Add Google, AI and notification variables from `.env.example` as needed. |

## Limits
- Function max duration is 300 s: fine for phoenixxit.com (11 pages), but very large crawls should run on the docker-compose deployment.
- n8n is not hosted on Vercel; point a separately hosted n8n at `https://<your-app>.vercel.app` with `SEO_API_URL`.
- Exports (manual-adapter instruction files) go to `/tmp` and are temporary on Vercel – download them from the change drawer (JSON/CSV/MD).
