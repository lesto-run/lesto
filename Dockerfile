# syntax=docker/dockerfile:1

# ---- Production image for a Volo app ----------------------------------------
# A Volo app is a single `volo.app.ts` that default-exports its AppConfig; the
# `volo` CLI boots it over HTTP (`volo serve`) and drains its durable, SQL-backed
# job queue. The image is deliberately minimal: a Bun runtime, the production
# dependency closure, the app source, and a CMD that stands up the web tier.

FROM oven/bun:1.3.5-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---- Dependencies -----------------------------------------------------------
# Copy only the manifests first so the install layer caches across code changes.
# `--production` skips devDependencies (vitest/oxlint/oxfmt/etc.) — the running
# app needs only @volo/* and the database driver.
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --production --frozen-lockfile

# ---- Runtime ----------------------------------------------------------------
FROM base AS runtime

# Bring in the resolved production node_modules, then the application code.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The stateless web tier listens here. `volo serve` defaults to 3000; override
# with PORT and pass it through in the CMD below.
ENV PORT=3000
EXPOSE 3000

# Run as the unprivileged user the Bun base image ships with.
USER bun

# Boot the HTTP server in front of the app. `volo serve` calls `createApp`,
# which applies pending migrations on boot, then binds the port and stays alive.
# Run database migrations and the queue worker as separate processes/commands
# (see DEPLOY.md) — this entry is the web tier only, so it scales horizontally.
CMD ["sh", "-c", "bunx volo serve --port ${PORT}"]
