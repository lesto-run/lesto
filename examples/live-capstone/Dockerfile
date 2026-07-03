# syntax=docker/dockerfile:1
#
# The Tier-4 v1 capstone as a LONG-LIVED prod host (ADR 0042 Inc8, `L-abe3f464`).
#
# This is deliberately NOT the framework's stateless app image (the repo-root `Dockerfile` /
# `DEPLOY.md`). A logical-replication slot consumer holds a dedicated connection and pins WAL until it
# acks, so it is a single long-lived process, not an edge/serverless or horizontally-scaled tier — see
# `examples/live-capstone/DEPLOY.md`. It runs `serve.ts` on the REAL Postgres replication path.
#
# BUILD CONTEXT IS THE REPO ROOT — the capstone resolves its `@lesto/* : workspace:*` deps from the
# monorepo, so the whole repo (minus `Dockerfile.dockerignore`'s excludes) is the context:
#
#   docker build -f examples/live-capstone/Dockerfile -t lesto-live-capstone .
#
# Pinned to the same Bun the CI `live-capstone-acceptance` job runs (bun-version 1.3.5).
FROM oven/bun:1.3.5-slim

WORKDIR /repo

# The capstone resolves @lesto/* from the workspace, so install the ROOT workspace, not a lone package.
# Copy the whole context (Dockerfile.dockerignore keeps it lean — no node_modules/dist/.git), then:
#   1. install the workspace (symlinks every @lesto/* into node_modules),
#   2. add `pg` — the Postgres change source's OPTIONAL peer, loaded lazily; installed here exactly as
#      the CI acceptance job does (`bun add pg`), so the image mirrors the gate that proves the path,
#   3. build the client bundle — the ~1.1 MB OPFS engine must survive a real `vite build` into dist/.
COPY . .
RUN bun install --frozen-lockfile \
  && cd examples/live-capstone \
  && bun add pg \
  && bun run build

WORKDIR /repo/examples/live-capstone

# This image IS the prod path: default the fail-closed source seam to `pg` (a missing LESTO_LIVE_PG_URL
# is then a LOUD boot error, never a silent fall back to the dev poll — see src/app.ts). Bind the
# machine's interface, not loopback, or the host's proxy cannot reach the process (serve.ts default is
# 127.0.0.1 for a safe local run). Provide LESTO_LIVE_PG_URL (a wal_level=logical Postgres) at runtime.
ENV NODE_ENV=production \
  LESTO_LIVE_SOURCE=pg \
  HOST=0.0.0.0 \
  PORT=3000
EXPOSE 3000

# Liveness: `/` serves the built index once the app is up. Use Bun's fetch so the slim image needs no
# curl/wget. Hits loopback, which HOST=0.0.0.0 also binds.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as the unprivileged user the Bun base image ships with (the build artifacts are world-readable;
# the pg path writes nothing to local disk — a connecting client re-snapshots).
USER bun

# serve.ts OWNS the slot lifecycle: it drops the WAL-pinning slot on SIGTERM and self-heals a
# crash-orphaned slot on boot. Fly/Render/Railway send SIGTERM on stop, so a graceful stop unpins WAL.
CMD ["bun", "run", "serve.ts"]
