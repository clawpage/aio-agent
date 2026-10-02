# syntax=docker/dockerfile:1
# Control layer: accounts, tasks, agents, the workspace proxy and the sandbox gateway.
# It holds no Docker access; sandboxes are reached only through sandbox nodes.
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.server.json ./
COPY scripts ./scripts
COPY src/common ./src/common
COPY src/control ./src/control
RUN npx tsc -p tsconfig.server.json && node scripts/copy-server-assets.mjs

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist/control ./dist/control
COPY --from=build /app/dist/common ./dist/common
COPY bin/create-user.mjs bin/set-user-model.mjs ./bin/
RUN mkdir -p /data && chown node:node /data
ARG AIO_VERSION=dev
ARG AIO_API=
ARG AIO_API_MIN=
ARG AIO_SANDBOX_PROTOCOL_MIN=
ARG AIO_SANDBOX_PROTOCOL_MAX=
LABEL ai.aio.component="control" ai.aio.version="${AIO_VERSION}" \
  ai.aio.api="${AIO_API}" ai.aio.api.min="${AIO_API_MIN}" \
  ai.aio.sandbox-protocol.min="${AIO_SANDBOX_PROTOCOL_MIN}" ai.aio.sandbox-protocol.max="${AIO_SANDBOX_PROTOCOL_MAX}"
# No Codex installation in here: owner turns run on Claude Code or the bridge models.
ENV AIO_VERSION=${AIO_VERSION} PA_DATA_DIR=/data PA_BIND=0.0.0.0 PA_PORT=4892 PA_HOST_CODEX=off
USER node
VOLUME ["/data"]
EXPOSE 4892 4902
HEALTHCHECK --interval=15s --timeout=8s --start-period=30s --retries=4 \
  CMD node -e "fetch('http://127.0.0.1:4892/healthz').then(r=>r.json()).then(j=>process.exit(j.compatible?0:1),()=>process.exit(1))"
CMD ["node", "dist/control/index.js"]
