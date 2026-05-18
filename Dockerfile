FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ARG POSTHOG_PERSONAL_API_KEY
ARG POSTHOG_API_KEY
RUN if [ -n "$POSTHOG_PERSONAL_API_KEY" ]; then \
      pnpm dlx posthog-cli sourcemap upload --directory dist ; \
    fi

FROM node:22-alpine AS run
WORKDIR /app
RUN corepack enable && addgroup -g 1001 cab && adduser -D -u 1001 -G cab cab
# TanStack Start v1.167 emits an SSR fetch handler only; server.prod.ts
# wraps it with srvx + crossws (run via tsx, reading ~ paths from tsconfig).
COPY --from=build --chown=cab:cab /app/dist ./dist
COPY --from=build --chown=cab:cab /app/src ./src
COPY --from=build --chown=cab:cab /app/server.prod.ts ./server.prod.ts
COPY --from=build --chown=cab:cab /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=cab:cab /app/package.json ./package.json
COPY --from=build --chown=cab:cab /app/node_modules ./node_modules
COPY --from=build --chown=cab:cab /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=build --chown=cab:cab /app/scripts/start-prod.sh ./start-prod.sh
RUN chmod +x ./start-prod.sh
USER cab
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["./start-prod.sh"]
