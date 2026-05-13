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
      pnpm dlx posthog-cli sourcemap upload --directory .output ; \
    fi

FROM node:22-alpine AS run
WORKDIR /app
RUN corepack enable && addgroup -g 1001 cab && adduser -D -u 1001 -G cab cab
COPY --from=build --chown=cab:cab /app/.output ./.output
COPY --from=build --chown=cab:cab /app/package.json ./package.json
COPY --from=build --chown=cab:cab /app/node_modules ./node_modules
USER cab
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
