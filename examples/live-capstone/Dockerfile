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
# MULTI-STAGE (`L-a86b8a71`): the build toolchain (`vite`, the app's only devDep, plus its esbuild /
# rollup tree) is confined to a throwaway `builder` stage and NEVER lands in the runtime image. The
# `runtime` stage does a fresh `bun install --production`, so devDependencies are pruned out. Honest
# scope: this is an OPTIMIZATION, not a small image — a Bun workspace runs `@lesto/*` from TS source, so
# the runtime still ships the packages/ source closure, and there is no install-layer cache across a
# rebuild. Those are inherent monorepo-image costs; the concrete win here is dropping the dev toolchain
# (and its attack surface) from a process that only needs `serve.ts` + the `@lesto/*` source + `pg`.
#
# Pinned to the same Bun the CI `live-capstone-acceptance` job runs (bun-version 1.3.5).

# ---------------------------------------------------------------------------------------------------
# Stage 1 — builder: install the full workspace (incl. devDeps), add pg, and build the client bundle.
# ---------------------------------------------------------------------------------------------------
FROM oven/bun:1.3.5-slim AS builder

WORKDIR /repo

# The capstone resolves @lesto/* from the workspace, so install the ROOT workspace, not a lone package.
# Copy the whole context (Dockerfile.dockerignore keeps it lean — no node_modules/dist/.git), then:
#   1. install the workspace (symlinks every @lesto/* into node_modules; brings vite for the build),
#   2. add `pg` — the Postgres change source's OPTIONAL peer (not in package.json, so the frozen
#      install above doesn't cover it), PINNED so the "prod" image is reproducible rather than floating
#      to whatever `pg` is latest at build time. This mutates examples/live-capstone/package.json +
#      the root bun.lock, which the runtime stage below reuses so the pin carries through verbatim,
#   3. build the client bundle — the ~1.1 MB OPFS engine must survive a real `vite build` into dist/.
#
# --ignore-scripts: a ROOT workspace install pulls sibling members that declare `better-sqlite3` (a
# native, node-gyp postinstall — estate/blog/admin/etc.), which the slim base can't compile (no Python /
# build toolchain). The capstone never uses it: @lesto/runtime's openSqlite falls back to `bun:sqlite`
# under Bun, and this image's default path is `pg` (a pure-JS driver) anyway. vite's esbuild/rollup
# binaries arrive as optionalDependencies (package installs), NOT postinstall scripts, so the build is
# unaffected. Skipping scripts keeps the toolchain out of the picture instead of installing Python here.
COPY . .
RUN bun install --frozen-lockfile --ignore-scripts \
  && cd examples/live-capstone \
  && bun add pg@8 --ignore-scripts \
  && bun run build

# ---------------------------------------------------------------------------------------------------
# Stage 2 — runtime: a fresh slim image with ONLY the production closure (no vite / esbuild / rollup).
# ---------------------------------------------------------------------------------------------------
FROM oven/bun:1.3.5-slim AS runtime

WORKDIR /repo

# Re-copy the workspace SOURCE (dockerignore still excludes node_modules/.git/dist/var). @lesto/* run
# from TS source rather than a built dist/, so packages/ must be present for `workspace:*` resolution,
# and every workspace member's package.json must exist for the frozen install below to validate.
COPY . .

# Carry the builder's mutated manifests (capstone package.json with pg pinned + the matching root
# bun.lock) so the runtime install resolves the SAME pinned `pg`, then install ONLY production deps into
# a fresh node_modules. Because this node_modules starts empty, `vite` (the sole devDep) and its
# esbuild/rollup tree are never fetched here — that is the win over the old single-stage `COPY . .`
# image, which kept the whole dev install. --frozen-lockfile keeps it reproducible against the pin.
COPY --from=builder /repo/bun.lock ./bun.lock
COPY --from=builder /repo/examples/live-capstone/package.json ./examples/live-capstone/package.json
# --ignore-scripts for the same reason as the builder: the production closure of sibling workspace
# members still lists native `better-sqlite3`, which the capstone never calls (bun:sqlite / pg). Skipping
# its node-gyp postinstall is what lets the runtime stay on the slim base with no build toolchain.
RUN bun install --production --frozen-lockfile --ignore-scripts

# The already-built client bundle (dist/ is dockerignored out of the `COPY . .` above, so it comes from
# the builder). The ~1.1 MB OPFS engine that survived `vite build` ships here without vite present.
COPY --from=builder /repo/examples/live-capstone/dist ./examples/live-capstone/dist

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

# Liveness for a plain `docker run` / Render / Railway (Fly uses its own fly.toml [[checks]], not this).
# Use Bun's fetch so the slim image needs no curl/wget. Hits loopback, which HOST=0.0.0.0 also binds.
# start-period is generous: serve.ts runs the pg bootstrap + first snapshot before opening the port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run as the unprivileged user the Bun base image ships with (the build artifacts are world-readable;
# the pg path writes nothing to local disk — a connecting client re-snapshots).
USER bun

# serve.ts OWNS the slot lifecycle: it drops the WAL-pinning slot on SIGINT/SIGTERM and self-heals a
# crash-orphaned slot on boot. A graceful host stop (Fly's default signal is SIGINT; SIGTERM elsewhere)
# unpins WAL. Exec-form + a file arg means bun runs serve.ts in-process, receiving the signal directly.
CMD ["bun", "run", "serve.ts"]
