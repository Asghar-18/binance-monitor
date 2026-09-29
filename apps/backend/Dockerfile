# Build context: repository root (see docker-compose.yml)
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/backend/package.json apps/backend/
RUN pnpm install --frozen-lockfile --filter @bpm/backend...
COPY packages/shared packages/shared
COPY apps/backend apps/backend
RUN pnpm --filter @bpm/backend build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/backend
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]
