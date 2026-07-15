# Plan 008: Add a workerd-backed integration smoke for the Cloudflare adapter

> **Executor instructions**: Follow step by step; run every verification command.
> STOP and report on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/cloudflare/ packages/e2e/ packages/integration/`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive tests)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

`packages/cloudflare/` has 100% line coverage, but **every** unit test drives a
hand-built `Request` against a mocked `env` and fake bindings
(`packages/cloudflare/test/d1.test.ts:26` is a hand-written fake D1). None of it
runs under **workerd** — so the coverage proves branch logic, not that a Worker
built from this adapter boots, or that a D1 DDL installer survives a real apply.
The team's own memory records the exact traps a fake can't reproduce: multi-
statement DDL via `d1ToSqlDatabase` throws on **remote** D1 (error 7500) but
passes locally (`d1-single-statement-exec-trap`); `nodejs_compat` fakes
`process.versions.node` so runtime detection needs `isWorkerd()`; workerd caps
PBKDF2 at 100k iterations. The class of bug most likely to reach the flagship
edge target is the one class with no integration test. A small workerd smoke
closes it — this is the "green ≠ exercised" gap the portfolio review named.

## Current state

- `packages/cloudflare/test/` — unit tests only; no `miniflare` / `unstable_dev`
  / `cloudflare:test` / `@cloudflare/vitest-pool-workers` harness anywhere
  (grep to confirm).
- `packages/cloudflare/src/fetch-handler.ts` — the edge entry the smoke should
  boot. `packages/cloudflare/src/d1.ts` — `d1ToSqlDatabase`, whose remote-DDL
  behavior is the untested risk.
- There is an existing **non-gated** integration step in CI:
  `.github/workflows/ci.yml` runs `@lesto/integration` tests; and
  `packages/e2e` owns Playwright/real-install smokes. The new workerd smoke
  should live where it can run without breaking the 100%-coverage gate (which is
  per-package and serial) — i.e. in `@lesto/integration` or a dedicated
  non-gated suite, NOT inside `packages/cloudflare`'s gated unit suite.

### Conventions to follow

- `AGENTS.md` → the dev-harness discipline: never hand-roll a dev-server spawn;
  reuse `packages/e2e/dev-harness.ts` patterns if you spawn anything.
- Fetch-blocked-ports trap: never boot on a WHATWG restricted port.
- Keep it deterministic and cheap — one route round-trip + one D1 DDL apply, not
  a full app.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Confirm no workerd harness | `grep -rn "miniflare\|vitest-pool-workers\|unstable_dev\|cloudflare:test" packages/cloudflare packages/integration` | (empty today) |
| Run the new smoke | (the command you wire, e.g. `cd packages/integration && bun run test:workerd`) | passes |
| Cloudflare unit gate unaffected | `cd packages/cloudflare && bun run test:cov` | exit 0, 100% |

## Scope

**In scope**:
- A new integration test file + its harness config (miniflare or
  `@cloudflare/vitest-pool-workers`), placed in `packages/integration` or a
  clearly non-gated suite.
- Wiring it into the existing non-gated CI integration step (`.github/workflows/ci.yml`).
- A minimal `wrangler`/worker entry fixture if the harness needs one.

**Out of scope**:
- `packages/cloudflare/src/*` — do not change the adapter; this plan only adds
  coverage. If the smoke reveals a real bug, STOP and report it as a new finding.
- The 100%-coverage gate config — the smoke is additive and non-gated.

## Steps

### Step 1: Choose and install the harness

**Default to `miniflare` programmatic.** The repo is on **vitest 4.1.x**
(`package.json`), and `@cloudflare/vitest-pool-workers`' vitest-4 compatibility
is unverified and historically lags — only use pool-workers if a quick check
proves it works under vitest 4. Add the harness as a devDependency of the host
package only.

**Verify**: the harness's own "hello world" boots (a trivial fetch returns 200).

### Step 2: Boot the fetch handler and do one round-trip

Build the `@lesto/cloudflare` fetch handler over a tiny app + a real (miniflare)
D1 binding; issue one HTTP request through workerd and assert the response.

**Verify**: the smoke passes; it exercises `fetch-handler.ts` under workerd (not
a mocked `env`).

### Step 3: Exercise one real D1 DDL apply

Run one multi-statement-shaped installer path through `d1ToSqlDatabase` against
the miniflare D1 and assert it applies (this is the path that throws 7500 on
remote D1 — the smoke should apply DDL the way the installers do, one statement
per `exec`, per the `d1-single-statement-exec-trap` memory).

**Verify**: the DDL applies and a subsequent query returns the expected row.

### Step 4: Wire into CI

Add the smoke to the non-gated integration job in `.github/workflows/ci.yml`
(NOT the coverage gate). Keep it fast.

**Verify**: `grep -n "workerd\|miniflare" .github/workflows/ci.yml` shows the
new step; the coverage gate config is unchanged.

## Test plan

- The deliverable IS the test. Assert:
  1. a request routed through the workerd-hosted fetch handler returns the
     expected status/body,
  2. a D1 DDL installer applies under miniflare D1 and the data is queryable.
- Make both assertions positive and load-bearing (a broken handler / failed DDL
  must turn the smoke red).

## Done criteria

- [ ] A workerd/miniflare smoke exists and passes, booting `fetch-handler.ts`
      and applying real D1 DDL
- [ ] It runs in CI's non-gated integration step, not the coverage gate
- [ ] `cd packages/cloudflare && bun run test:cov` still exits 0 at 100%
- [ ] `packages/cloudflare/src/*` unchanged (`git status`)
- [ ] `plans/README.md` status row for 008 updated

## STOP conditions

Stop and report if:
- **The Bash sandbox blocks server-starts** (miniflare/pool-workers both spawn a
  workerd subprocess binding a local port) — this is the *likely* outcome here.
  Use the authorized-preflight escape hatch if available, or report that the
  smoke is written and needs to run in CI; do NOT fake it with a mock (that
  recreates the exact gap). The smoke's real home is CI regardless.
- The smoke reveals an actual adapter bug (a genuine 7500/detection failure) —
  report it as a new finding rather than editing `src/` here.

## Maintenance notes

- Keep the smoke minimal — it is a boot/DDL canary, not a full E2E; the app-level
  E2E lives in `packages/e2e`.
- Reviewer should confirm it runs under real workerd (not miniflare's Node
  fallback) and that it is excluded from the per-package coverage gate.
