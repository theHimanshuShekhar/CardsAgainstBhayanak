FROM node:22-slim AS base
RUN npm install -g pnpm@10

# ── Build stage ──────────────────────────────────────────────────────────────
FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ── Production stage ─────────────────────────────────────────────────────────
FROM base AS prod
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --from=build /app/dist ./dist
COPY server.mjs drizzle.config.ts entrypoint.sh ./
COPY src/db ./src/db
COPY scripts ./scripts
RUN chmod +x entrypoint.sh

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["./entrypoint.sh"]
