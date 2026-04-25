FROM node:25-alpine AS builder
WORKDIR /app
COPY server/package.json server/package-lock.json* ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

FROM node:25-alpine
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
