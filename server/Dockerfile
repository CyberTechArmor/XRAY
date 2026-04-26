FROM node:20-alpine AS builder
# `apk upgrade --no-cache` pulls in Alpine's latest patched OS-level
# packages (openssl, busybox, libxml2, musl, etc.) on top of the
# node:20-alpine base. The base image is rebuilt on Node releases,
# not on Alpine CVE patches, so without this the image carries
# whatever Alpine package versions the upstream tag was frozen at —
# which is what gates Trivy on HIGH/CRITICAL OS-level CVEs.
RUN apk upgrade --no-cache
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:20-alpine
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
# Migrations live at the repo root. They are read at startup by index.ts
# to self-heal missing tables (014_ai_integration, 015_ai_pricing_feedback, ...).
COPY migrations ./migrations
RUN mkdir -p /app/uploads && chown node:node /app/uploads
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
