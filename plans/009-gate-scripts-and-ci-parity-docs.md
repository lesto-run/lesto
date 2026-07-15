# Plan 009: Add `gate` / `gate:full` scripts and fix the "CI runs exactly this" docs

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- package.json AGENTS.md CONTRIBUTING.md .github/workflows/ci.yml`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / docs
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

`AGENTS.md:31` ("Commands (the gate — CI runs exactly this)") and
`CONTRIBUTING.md` ("It is exactly what CI runs") both list only four commands:
`ws:typecheck`, `ws:lint`, `ws:format:check`, `coverage-gate`. But
`.github/workflows/ci.yml` runs ~9 more steps (e2e-spec typecheck,
`test:types` type-regression, content-package tests, integration tests, examples
gallery, docs-site test+build, bundle-size, browser E2E, scaffold E2E). So
contributors and fleet agents go green locally and then fail CI — and
`RELEASING.md:67` documents that trusting "the local fast-gate set … which OMITS
the e2e" caused the 0.1.7 release near-miss. The fix names the two gates
explicitly (`gate` = fast, `gate:full` = CI-equivalent) and corrects the docs so
they stop claiming a parity that doesn't hold.

## Current state

- Root `package.json` scripts include `ws:typecheck`, `ws:lint`,
  `ws:format:check`, `ws:test:cov` (→ `scripts/coverage-gate.ts`), `test:types`,
  `test:pack-boot`, `test:pack-import`, etc. There is **no** `gate` or
  `gate:full` aggregate script.
- `AGENTS.md:31-41` — the "the gate — CI runs exactly this" block (4 commands).
- `CONTRIBUTING.md` — a matching "exactly what CI runs" claim (grep for it).
- `.github/workflows/ci.yml` — the real steps (read it to enumerate the full
  list; note `rg` skips `.github/` by default — use `grep -r`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Read CI truthfully | `grep -nE "run:|bun run|node scripts" .github/workflows/ci.yml` | the full step list |
| Fast gate | `bun run gate` (after you add it) | runs the 4 fast checks |
| Full gate | `bun run gate:full` (after you add it) | runs the CI-equivalent set |

## Scope

**In scope**:
- Root `package.json` (`scripts`): add `gate` and `gate:full`.
- `AGENTS.md` and `CONTRIBUTING.md`: correct the parity claim.

**Out of scope**:
- `.github/workflows/ci.yml` — do NOT change what CI runs; only mirror it.
- The coverage gate's serial design (deliberate — never parallelize).

## Steps

### Step 1: Add the aggregate scripts

- `"gate": "bun run ws:typecheck && bun run ws:lint && bun run ws:format:check && bun run ws:test:cov"` — the current fast four.
- `"gate:full"`: the CI-equivalent chain. **Do NOT hand-list from memory — that
  is the exact false-parity this plan exists to kill.** Enumerate **every** job
  in `ci.yml` (`grep -nE "^\s+[a-z0-9-]+:$|run:|bun run|node scripts" .github/workflows/ci.yml`;
  remember `rg` skips `.github/`) and classify each into a table:
  `include` / `exclude-browser` (Playwright) / `exclude-service-container`
  (the Postgres-service jobs — pg-parity, pgoutput/live-server, live-capstone,
  hyperdrive) / `exclude-external-tool` (shellcheck, `bash -n`). Categories a
  naive list drops and MUST appear: the four **Postgres-service** jobs, the
  **`scripts` vitest suite**, **`assert-isolated-node-modules`**,
  **`browser-rum-trace`**, **`deploy-cloudflare-dry`**, the **type-regression**
  (`test:types`), **content** tests, **integration**, **examples**, **docs-site
  test AND build** (CI runs both), **bundle-size**, and the **pack-boot/pack-import**
  smokes. `gate:full` runs everything classified `include`; the docs (Step 2)
  name every exclusion and why. No silent gaps.

**Verify**: `bun run gate` runs and exits 0 on a clean tree. **Note:**
`ws:test:cov` runs `node scripts/require-node.mjs` and needs **Node ≥ 22** — in a
Node-20 shell prefix with `nvm use 22 --silent`, or the "exits 0" check fails on
the Node guard, not on your change.

### Step 2: Fix the docs

In `AGENTS.md:31` and `CONTRIBUTING.md`, change "the gate — CI runs exactly
this" / "exactly what CI runs" to reflect reality: `bun run gate` is the **fast**
gate; **CI additionally** runs `test:types`, e2e, content, integration, examples,
docs-site, bundle-size (name them), reproduced by `bun run gate:full`. Keep the
serial-coverage warning intact.

**Verify**: `grep -n "exactly this\|exactly what CI runs" AGENTS.md CONTRIBUTING.md`
returns nothing (the false claim is gone).

## Test plan

- No unit tests. Verification is: `bun run gate` exists and runs; `gate:full`'s
  command list is a superset of `gate` and matches `ci.yml`'s steps (diff them by
  eye and note any deliberate exclusion in the doc).

## Done criteria

- [ ] `package.json` has `gate` and `gate:full`; `bun run gate` exits 0
- [ ] `gate:full` command list matches `ci.yml` (documented exclusions only)
- [ ] `grep -n "exactly this\|exactly what CI runs" AGENTS.md CONTRIBUTING.md` empty
- [ ] `.github/workflows/ci.yml` unchanged (`git status`)
- [ ] `plans/README.md` status row for 009 updated

## STOP conditions

Stop and report if:
- A CI step cannot be expressed as a root script without new infrastructure
  (e.g. it needs a service container) — list which, and have `gate:full` run
  everything else while the doc names the CI-only remainder.

## Maintenance notes

- When a new CI step is added, `gate:full` and the doc list must be updated in
  the same change — call this out in the doc so it becomes a convention.
- Reviewer should run `bun run gate:full` once to confirm it actually reproduces
  a CI failure class locally (the whole point).
