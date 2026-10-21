# ─── Phoenixx SEO Agent – API (+ CLI, migrations, prompts) ───
FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache git
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/crawler/package.json apps/crawler/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/seo-engine/package.json packages/seo-engine/
COPY packages/keyword-engine/package.json packages/keyword-engine/
COPY packages/ai-engine/package.json packages/ai-engine/
COPY packages/integrations/package.json packages/integrations/
COPY packages/reporting-engine/package.json packages/reporting-engine/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json tsconfig.json ./
COPY apps/api apps/api
COPY apps/crawler apps/crawler
COPY packages packages
RUN npm run build -w @phoenixx/api

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/database/migrations \
    PROMPTS_DIR=/app/prompts \
    DEMO_CRAWL_FILE=/app/database/seed/phoenixx-crawl-sample.json \
    EXPORT_DIR=/app/exports
WORKDIR /app
# git is needed by the GitAdapter (static-site repositories); wget for the healthcheck.
RUN apk add --no-cache git wget && addgroup -S seo && adduser -S seo -G seo
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/crawler/package.json apps/crawler/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
COPY packages/seo-engine/package.json packages/seo-engine/
COPY packages/keyword-engine/package.json packages/keyword-engine/
COPY packages/ai-engine/package.json packages/ai-engine/
COPY packages/integrations/package.json packages/integrations/
COPY packages/reporting-engine/package.json packages/reporting-engine/
RUN npm ci --omit=dev --no-audit --no-fund \
      -w @phoenixx/api -w @phoenixx/crawler -w @phoenixx/shared -w @phoenixx/database \
      -w @phoenixx/seo-engine -w @phoenixx/keyword-engine -w @phoenixx/ai-engine -w @phoenixx/integrations -w @phoenixx/reporting-engine \
    && npm cache clean --force
COPY --from=build /app/apps/api/dist ./dist
COPY database ./database
COPY packages/ai-engine/prompts ./prompts
RUN mkdir -p /app/exports /app/.data && chown -R seo:seo /app/exports /app/.data
USER seo
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/ready || exit 1
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
