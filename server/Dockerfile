FROM node:25-alpine AS builder
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

FROM node:25-alpine
RUN apk upgrade --no-cache
WORKDIR /app
ENV NODE_ENV=production
COPY server/package.json server/package-lock.json* ./
# Install prod deps, then EVICT npm from the runtime image. The
# Trivy scan flagged HIGH-severity CVEs in npm's own bundled deps
# under /usr/local/lib/node_modules/npm/node_modules/* (CVE-2026-31802
# in tar@7.5.11 was the canonical recent example). The runtime
# container only needs `node dist/index.js` — npm / npx are dead
# weight after install. Same trick removes a chunk of dependency
# surface from the shipped image. node + libstdc++ + libgcc remain
# (required by the v8 native bits).
RUN npm ci --omit=dev \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx /root/.npm /tmp/*
COPY --from=builder /app/dist ./dist
# Migrations live at the repo root. They are read at startup by index.ts
# to self-heal missing tables (014_ai_integration, 015_ai_pricing_feedback, ...).
COPY migrations ./migrations
# Pipeline-schema templates served read-only by /api/admin/pipeline/*
# (Admin → Pipeline view). Per-integration .sql files are operator-
# managed and NOT included here; only globals.sql + future cross-
# integration files ship with the platform.
COPY scripts/pipeline-schemas ./scripts/pipeline-schemas
RUN mkdir -p /app/uploads && chown node:node /app/uploads
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
