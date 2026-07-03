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
it moves the monorepo much closer to the **no-phantom-dependency** discipline the 32-package publish
bar needs — `@lesto/*` packages are no longer hoisted to the root, so a package importing an
`@lesto/*` it never declared now fails locally instead of only in a consumer's app. (b) Pin it with
`[install] linker = "isolated"` in `bunfig.toml`, so the layout is an explicit decision rather than a
silent consequence of the lockfile's `configVersion`. (c) Adopt the doctrine: **resolve every
dependency from the package that DECLARES it**; out-of-repo fixtures reconstruct their `node_modules`
via `packages/e2e/link-workspace.ts` (never a bare symlink to the repo-root install, which resolves
zero `@lesto/*` under the isolated layout).

**Scope of the guarantee (be precise).** Isolation is not total for *workspace members*: they live at
real paths inside the repo, so Node/bun still walk **up** to the repo-root `node_modules` — a member
can therefore phantom-import anything the *root* declares, even under the isolated linker. A published
package on a consumer's isolated installer cannot. So the doctrine is enforced by the *layout* only for
the `@lesto/*` scope (un-hoisted); for third-party deps a member must still declare what it uses. The
canonical example this session: `@lesto/live-server` lazily `require("pg")` but declared no `pg` peer —
it resolved only via a root-level install and would break once published; the fix was to declare `pg`
an optional peer (mirroring `@lesto/pg`), **not** to rely on the layout. Treat "resolve from the
declaring package" as a discipline the guard *assists*, not one the linker fully guarantees.

## Consequences

- A CI **drift guard** — `scripts/assert-isolated-node-modules.mjs`, run as
  `bun scripts/assert-isolated-node-modules.mjs` — fails fast if (1) the repo-root `node_modules` ever
  regrows an `@lesto` scope (hoisting crept back), (2) the `bunfig.toml` pin is removed, or (3) any
  `bun.lock` workspace entry no longer maps to a git-tracked directory. Check (3) covers the failure
  that actually bit hardest this session: an untracked scratch dir matching a workspace glob got baked
  into `bun.lock` by a local `bun install`, and a fresh CI checkout then failed frozen-install with an
  opaque "lockfile had changes" (closed for the specific case by a `!examples/hmr-check` negation; the
  guard catches the whole class, with the offending path named).
- The per-site fixes for the layout flip are **layout-agnostic** — they resolve dependencies from the
  declaring package regardless of hoisting, so they hold under either linker. (They are not, however,
  "done once": the flip kept surfacing new latent breakage one CI job at a time — a scaffold that
  couldn't resolve `tailwindcss`, a package pairing react 18 with react-dom 19 — each a fresh
  declaration to fix, not a regression in the fixes themselves.)
- The publish bar gains a **partial** standing guarantee: the monorepo install matches published
  isolation for the un-hoisted `@lesto/*` scope, narrowing — not fully closing — the "works hoisted,
  breaks published" gap (see *Scope of the guarantee* above: workspace members still walk up to root
  for third-party deps, so declaring them remains the developer's responsibility).
