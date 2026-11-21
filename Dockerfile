# ─────────────────────────────────────────────────────────────────────────────
# edu-news — production image
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage: dependencies and the TypeScript build stay in the builder stage,
# so the runtime image carries only compiled JavaScript and production modules.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Install every dependency (dev included) so the build stage can run tsc.
RUN npm ci --include=dev

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json* ./
# Only runtime dependencies end up in the final image.
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-alpine AS runtime
WORKDIR /app

# tini reaps zombies and forwards signals so SIGTERM shuts the server down cleanly.
RUN apk add --no-cache tini curl

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY docs ./docs

# Run unprivileged.
RUN addgroup -g 1001 -S nodejs && adduser -S -u 1001 -G nodejs nodejs \
    && chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/src/index.js"]
