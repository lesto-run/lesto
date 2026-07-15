# Plan 006: Add a README to every published package

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> "STOP conditions" item occurs, stop and report. When done, update the status
> row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `for d in packages/*/; do [ -f "$d/package.json" ] && ! grep -q '"private": *true' "$d/package.json" && [ ! -f "${d}README.md" ] && echo "$d"; done`
> Confirm the list of README-less public packages still matches the ~29 below;
> if it has shrunk substantially, someone else started this — reconcile first.

## Status

- **Priority**: P2 (launch-relevant)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

29 of the 49 published `@lesto/*` packages have no `README.md`, so their npm
pages render "No README data found!" — including the flagship surface (`queue`,
which `CONVENTIONS.md` calls the reference package, plus `web`, `db`, `kernel`,
`router`, `ui`, `cli`, `create-lesto`, `runtime`, `errors`, `observability`,
`deploy`, `storage`, `assets`). `docs/ATTACK-PLAN-2027.md` names the L1 launch
window (2026-07-27 → 08-01) and its thesis is that a reader's first move is
"agent, try this framework." Both humans and agents resolving `@lesto/*` on the
registry hit blank pages at exactly the moment the plan optimizes for
first-touch. This is also an agent-legibility gap (ADR 0035): an agent
evaluating a package from npm gets zero orientation. The fix is a generator that
stamps a minimal, accurate README per package, then hand-polish for the headline
batteries.

## Current state

- Public packages (not `"private": true`) that lack a README today, from the
  drift-check command: `queue`, `web`, `db`, `kernel`, `router`, `ui`, `cli`,
  `create-lesto`, `runtime`, `errors`, `observability`, `deploy`, `storage`,
  `assets`, and ~15 more (run the drift check for the exact list).
- Richer per-battery copy already exists to excerpt from:
  `site/content/docs/batteries/*.md` and `site/content/docs/**`. Every docs page
  also has a Markdown twin at its path + `.md` (see `AGENTS.md`).
- Each `package.json` has a `description` field and a `files` allowlist. **npm
  includes `README.md` in the tarball regardless of `files`**, so adding a
  README needs no manifest change.
- There is a package generator convention at `scripts/new-package.mjs`
  (root `package.json` script `new-package`) — read it to match the house style
  for scripts.

### Conventions to follow

- READMEs are agent-readable docs: keep them factual, link to
  `https://docs.lesto.run` and the package's docs page, and to
  `https://docs.lesto.run/llms.txt`.
- Do not invent API. Every code sample must be real — derive from the package's
  `src/index.ts` exports and the matching `site/content/docs` page, or omit.

## Commands you will need

| Purpose        | Command                                             | Expected |
|----------------|-----------------------------------------------------|----------|
| List gaps      | (drift-check command above)                         | the package list |
| Typecheck all  | `bun run ws:typecheck`                              | exit 0 |
| Full gate      | `bun run ws:typecheck && bun run ws:lint && bun run ws:format:check` | exit 0 |

## Scope

**In scope**:
- A new generator script under `scripts/` (e.g. `scripts/gen-readmes.mjs`).
- `packages/<name>/README.md` for each README-less public package (created).

**Out of scope** (do NOT touch):
- Any `package.json` (`files`, `description`, versions) — README needs no
  manifest change.
- Any `src/` code.
- Packages that already have a README (do not overwrite hand-written ones —
  the generator must skip existing files).
- Private/example packages.

## Git workflow

- Commit style: `docs(packages): add generated READMEs to the published surface`.
- Consider one commit for the generator and one for the generated files.

## Steps

### Step 1: Write the generator

Add `scripts/gen-readmes.mjs` (match `scripts/new-package.mjs` style) that, for
each public package **without** an existing README, emits a README from:
- the package `name` + `description`,
- an install line (`bun add <name>`),
- a short usage block **only if** a real snippet can be sourced from the
  matching `site/content/docs/batteries/<name>.md` (else omit the block),
- links to `https://docs.lesto.run/docs/...` for that package and to `llms.txt`.

The generator MUST skip any package that already has a `README.md` (never
overwrite).

**Verify**: `node scripts/gen-readmes.mjs --dry-run` (implement a dry-run flag)
prints the packages it would write and the content, touching nothing.

### Step 2: Generate

Run the generator for real.

**Verify**: the drift-check command now prints nothing (every public package has
a README); `git status` shows only new `README.md` files + the script.

### Step 3: Hand-polish the highest-value MISSING packages

**Do NOT target the 13 RELEASING.md "headline batteries" — they already have
READMEs and are not in the 29-missing set** (the generator skips them). Polish
the high-value packages that are *actually missing* one — the core infra the
intro names: `queue`, `web`, `db`, `kernel`, `router`, `cli`, `runtime`,
`errors`, `assets`, `deploy`, `storage`, `observability`, `ui` (plus
`create-lesto`). Replace their generated stub's usage block with a real,
runnable example sourced from `site/content/docs/**`, verifying each import path
and symbol against the package's `src/index.ts`.

**Verify**: `bun run ws:typecheck && bun run ws:lint && bun run ws:format:check`
→ exit 0 (READMEs don't affect these, but confirm nothing else drifted).

## Test plan

- READMEs are not unit-tested. The verification is: (a) the drift check is empty,
  (b) each headline-battery snippet's imports match `src/index.ts` exports (grep
  each `import { X } from "@lesto/<pkg>"` symbol against the export list).
- **Required (not optional):** add a meta-test in the repo's existing
  `scripts/*.test.mjs` style (e.g. alongside `scripts/build-public.test.mjs`)
  asserting every non-private `packages/*` has a `README.md`. This repo's traps
  register shows unenforced conventions drift (a fail-open guard, `L-ceb1dc5a`);
  a convention without a check will regress. Wire it into the gate.
- **Timing:** the publish pipeline copies README/LICENSE into the staged tarball
  (`scripts/lib/build-public.mjs:149`), so a README reaches npm **only at the
  next release cut** — this plan must land **before** the launch cut (0.1.8) or
  the npm pages stay blank through the window it exists to fix.

## Done criteria

- [ ] Drift-check command prints nothing (0 public packages without a README)
- [ ] `git status` shows only new `README.md` files + the generator script
- [ ] The high-value *missing* infra packages (queue, web, db, kernel, router,
      cli, runtime, errors, assets, deploy, storage, observability, ui) have a
      hand-verified runnable snippet
- [ ] `bun run ws:typecheck && bun run ws:lint && bun run ws:format:check` exit 0
- [ ] `plans/README.md` status row for 006 updated

## STOP conditions

Stop and report if:

- A package's `description` is missing or wrong (the generator would emit a bad
  README) — list those packages for a human to fill the description first.
- A docs page's example uses API that does not match the package's current
  `src/index.ts` (docs drift) — report the mismatch; do not "fix" the code to
  match the doc.

## Maintenance notes

- If you added the "every public package has a README" meta-check, new packages
  will fail it until they add one — that is the intended forcing function.
- Reviewer should spot-check 3–4 generated READMEs for accuracy (real imports,
  correct docs links) and confirm no hand-written README was overwritten.
