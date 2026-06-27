FROM node:24-alpine

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bsgames/exm-registry-server build

ENV NODE_ENV=production
ENV EXM_REGISTRY_HOST=0.0.0.0
ENV EXM_REGISTRY_PORT=4873
ENV EXM_REGISTRY_STORAGE_KIND=file
ENV EXM_REGISTRY_FILE_ROOT=/data

VOLUME ["/data"]
EXPOSE 4873

CMD ["node", "packages/exm-registry-server/bin/exm-registry-server.js"]
