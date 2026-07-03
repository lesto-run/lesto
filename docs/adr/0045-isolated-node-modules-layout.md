# ADR 0045 — Pin the isolated node_modules layout (bun `configVersion: 1`), and adopt the resolve-from-the-declaring-package doctrine

- **Status:** **Accepted** (2026-07-03, chief-architect review). Ratifies and **pins** the isolated
  node_modules layout that bun 1.3.5 already produces for this repo, converting an implicit
  lockfile-field consequence into an explicit, drift-proof decision. Implemented alongside this ADR:
  the pin (`[install] linker = "isolated"` in `bunfig.toml`) and its CI drift guard
  (`scripts/assert-isolated-node-modules.mjs`).
- **Date:** 2026-07-03
- **Deciders:** tech lead + owner
- **Builds on / touches:** the packaging discipline behind the **32-package `@lesto/*` publish bar**
  (`scripts/publish.mjs`, ADR 0038's dogfood-thin-config apps), and the out-of-repo e2e fixture
  reconstruction `packages/e2e/link-workspace.ts` (which already rebuilds a member's `node_modules`
  for the isolated layout). Follows **ADR 0044's drift-guard precedent** — that ADR pairs a ratified
  convention with a fail-fast guard (its `wrangler.jsonc` compat-drift check); this ADR does the same
  for the install layout.

## Context

bun 1.3.5 installs with an **isolated** node_modules layout: the repo-root `node_modules` holds only
the ~16 shared externals and **no `@lesto/*`** — each workspace package resolves from the member that
declares it. This is bun's intentional default for `configVersion: 1` lockfiles, and commit `8c2209c`
flipped `bun.lock` `configVersion 0 → 1`, thereby flipping the layout from hoisted to isolated. The
change was **unpinned**: nothing in the repo asserted the linker, so a future lockfile regen or a bun
version bump could silently flip it back. The flip surfaced as a wave of CI failures — tests and CI
steps that had assumed the old *hoisted* layout (resolving `@lesto/*` from the repo root) broke when
those packages were no longer hoisted there.

## Decision

**Ratify the isolated layout, pin it, and adopt the doctrine.** (a) Isolated is the correct default:
it enforces the **no-phantom-dependency** discipline the 32-package publish bar needs — a package can
only import what it *declares*, so nothing that installs cleanly in the monorepo fails in isolation on
npm. (b) Pin it with `[install] linker = "isolated"` in `bunfig.toml`, so the layout is an explicit
decision rather than a silent consequence of the lockfile's `configVersion`. (c) Adopt the doctrine:
**resolve every dependency from the package that DECLARES it**; out-of-repo fixtures reconstruct their
`node_modules` via `packages/e2e/link-workspace.ts` (never a bare symlink to the repo-root install,
which resolves zero `@lesto/*` under the isolated layout).

## Consequences

- A CI **drift guard** — `scripts/assert-isolated-node-modules.mjs`, run as
  `bun scripts/assert-isolated-node-modules.mjs` — fails fast if the repo-root `node_modules` ever
  regrows an `@lesto` scope (hoisting crept back) or if the `bunfig.toml` pin is removed. It names the
  most likely cause (a lockfile regen without the pin) so the fix is obvious.
- The per-site fixes already landed for the layout flip are **layout-agnostic** — they resolve
  dependencies from the declaring package regardless of hoisting, so they hold under either linker and
  need no revisiting.
- The publish bar gains a standing guarantee: the monorepo install now matches the isolation each
  published `@lesto/*` package experiences on npm, closing the "works hoisted, breaks published" gap.
