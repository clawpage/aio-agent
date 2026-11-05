# syntax=docker/dockerfile:1
# UI layer: the built console plus its edge server (static files + /api pass-through).
# The UI image now serving (deploy/aio.mjs passes it); without one, the build stands alone.
ARG AIO_UI_PREVIOUS=build
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY src/common ./src/common
COPY src/ui ./src/ui
# Empty: the console talks to its own origin (the edge passes /api through).
ARG VITE_AIO_API_BASE=
RUN npx vite build

FROM ${AIO_UI_PREVIOUS} AS previous

# A console opened before this deploy keeps loading its own build's files (ui-keep-assets.mjs).
FROM node:26-alpine AS merged
ARG AIO_VERSION=dev
COPY --from=build /app/dist/ui /ui/new
COPY --from=previous /app/dist/ui /ui/previous
COPY deploy/ui-keep-assets.mjs /ui/keep.mjs
RUN node /ui/keep.mjs /ui/new /ui/previous "${AIO_VERSION}" 5

FROM node:26-alpine
WORKDIR /app
COPY --from=merged /ui/new ./dist/ui
COPY src/ui/edge.mjs ./src/ui/edge.mjs
ARG AIO_VERSION=dev
ARG AIO_API_REQUIRES=
LABEL ai.aio.component="ui" ai.aio.version="${AIO_VERSION}" ai.aio.api.requires="${AIO_API_REQUIRES}"
ENV AIO_VERSION=${AIO_VERSION} AIO_UI_BIND=0.0.0.0 AIO_UI_PORT=4891 AIO_UI_DIST=/app/dist/ui
USER node
EXPOSE 4891
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4891/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/ui/edge.mjs"]
