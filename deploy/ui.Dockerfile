# syntax=docker/dockerfile:1
# UI layer: the built console plus its edge server (static files + /api pass-through).
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

FROM node:26-alpine
WORKDIR /app
COPY --from=build /app/dist/ui ./dist/ui
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
