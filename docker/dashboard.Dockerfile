# ─── Phoenixx SEO Agent – Dashboard (static build served by nginx, /api proxied to the API) ───
FROM node:22-alpine AS build
WORKDIR /app
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
COPY apps/dashboard apps/dashboard
RUN npm run build -w @phoenixx/dashboard

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 80
