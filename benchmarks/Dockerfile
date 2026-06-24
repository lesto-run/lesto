# syntax=docker/dockerfile:1
#
# Benchmark SOFTWARE-PIN image — the LOWER-FIDELITY reproduction path.
#
# This image pins the software stack ONLY: Bun, Node, and the resolved deps. It
# does NOT — and a container CANNOT — provide the things that actually make a
# benchmark reproducible: a performance CPU governor, disabled turbo/boost,
# fixed clocks, or true core isolation. Those are HOST concerns (see
# `README.md` → "Reproduce it yourself").
#
# So: numbers produced inside this container are INDICATIVE, not publication-grade
# — and `driver/run.ts` will stamp them "NON-CANONICAL" automatically. Published
# comparisons come from the documented bare-metal rig, not from here. Use this
# only to re-run the methodology on your own hardware without fighting installs.
#
# The base is pinned by DIGEST (not just the tag) so it never drifts. Refresh with:
#   docker buildx imagetools inspect oven/bun:1.3.5-slim   # copy the top-level Digest
FROM oven/bun:1.3.5-slim@sha256:6111acec4c5a703f2069d6e681967c047920ff2883e7e5a5e64f4ac95ddeb27f

# Node 22 — the competitor apps boot via `node server.mjs` and the generator runs
# through `npx autocannon`. Pin the major; the exact patch is stamped into RESULTS.md.
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# The benchmarks resolve @lesto/* + react/preact from the repo root, so the whole
# repo is the build context (see .dockerignore for what's excluded). Copy it, then
# install the root workspace and the isolated competitor libs under benchmarks/.
COPY . .
RUN bun install --frozen-lockfile \
  && cd benchmarks && bun install

# Default: run the in-process comparison (always works in a container). The
# real-server load test needs `bun benchmarks/driver/run.ts` and binds sockets —
# run it explicitly, knowing it will be stamped non-canonical here.
CMD ["bun", "run", "benchmarks/compare/run.ts"]
