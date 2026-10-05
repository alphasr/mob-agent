# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/dashboard/Dockerfile .
# (docker compose in apps/dashboard does this for you.)

FROM node:24-slim AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
# --force: the workspace also holds the macOS-only iMessage package, which the dashboard doesn't use.
# Behind a TLS-inspecting proxy, pass its CA certificate as the optional `ca` build secret (see SELF_HOSTING.md).
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi \
 && npm ci --force --no-audit --no-fund \
 && npm run build \
 && npm run build --workspace apps/dashboard

FROM node:24-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# The standalone server with only the files it uses (migrations included); static assets are copied next to it.
COPY --from=build --chown=node:node /repo/apps/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/dashboard/.next/static ./apps/dashboard/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "apps/dashboard/server.js"]
