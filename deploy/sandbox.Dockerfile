# syntax=docker/dockerfile:1
# Sandbox layer: sandboxd, the only component with Docker access. It runs no user
# code and offers only fixed operations on the sandbox containers it manages.
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.server.json ./
COPY src/common ./src/common
COPY src/sandbox ./src/sandbox
RUN npx tsc -p tsconfig.server.json

FROM docker:28-cli AS docker

FROM node:26-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist/sandbox ./dist/sandbox
COPY --from=build /app/dist/common ./dist/common
ARG AIO_VERSION=dev
ARG AIO_SANDBOX_PROTOCOL=
LABEL ai.aio.component="sandbox" ai.aio.version="${AIO_VERSION}" ai.aio.sandbox-protocol="${AIO_SANDBOX_PROTOCOL}"
ENV AIO_VERSION=${AIO_VERSION} PA_SANDBOXD_BIND=0.0.0.0 PA_SANDBOXD_PORT=4894
EXPOSE 4894
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4894/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/sandbox/index.js"]
