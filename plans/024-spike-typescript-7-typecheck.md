# Plan 024: Spike — evaluate TypeScript 7 (native) for the typecheck path

> **Executor instructions**: INVESTIGATE/SPIKE — deliverable is a measured report
> and a recommendation, not an adoption. Do NOT change the repo's `typescript`
> version in the main tree. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- package.json tsconfig.base.json type-tests/`

## Status

- **Priority**: P3 (investigate)
- **Effort**: M (spike)
- **Risk**: MED (resolution/diagnostics drift under tsgo)
- **Depends on**: none
- **Category**: dx / tooling
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

The gate typechecks all 69 `@lesto/*` packages with `tsc`, plus a separate
type-regression suite (`test:types`, ADR 0026) and an e2e-spec typecheck — `tsc`
is on the critical path of CI and of every fleet agent's loop, and feedback-loop
time is this repo's scarcest resource. The native compiler (TypeScript 7 / tsgo)
advertises a large checking speedup that would compound across 69 packages × every
push × every agent. Ecosystem signal it's adoptable: `@content-collections/core`
already peers `typescript ^5 || ^6 || ^7`. This spike measures the real delta and
the diagnostic drift.

## Current state

- Root `typescript: ^5.7.0`. `npm view typescript version` → 7.x.
- `tsconfig.base.json` uses `Bundler` resolution, `exports` point at `.ts`, and
  the strict flag set (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`, `isolatedModules`, …).
- `type-tests/` (`test:types`, ADR 0026) asserts on **exact diagnostics** — the
  most likely place tsgo drifts.

## What to produce

A report (`plans/notes/024-ts7.md` or appended here) covering:
1. Wall-clock delta: `ws:typecheck` under `tsc` 5.x vs tsgo 7 across the
   workspace (record both times, same machine).
2. Does `Bundler` resolution + `exports`-pointing-at-`.ts` behave identically
   under tsgo?
3. **Type-identity + expected-error parity under tsgo** (NOT "diagnostic
   text/positions" — that was a wrong premise). `test:types` is
   `tsc -p type-tests/tsconfig.json --noEmit`; it does **not** assert diagnostic
   text. It gates on two things:
   (a) `type _ = Expect<Equal<A, B>>` — drift surfaces as **TS2344** on the
   alias, so the real question is whether tsgo's **type-identity** judgment for
   the `Equal<>` function-identity trick (`type-tests/assert.ts`) matches tsc;
   (b) `@ts-expect-error` — it fires only if the next line has *some* error, so a
   tsgo checking-strictness gap turns an expected error into an **unused-directive
   (TS2578) false RED**.
   Report: does every `Expect<Equal<>>` alias and every `@ts-expect-error`
   resolve identically under tsgo?
4. Which strict flags (if any) tsgo doesn't yet support.
5. Recommendation: adopt for typecheck-only (keep 5.x where incompatible),
   wait, or no.

## Steps

### Step 1: Install tsgo in a spike checkout

Add `typescript@7` (or the `@typescript/native-preview`/tsgo package name
current at execution time) alongside; do not remove 5.x.

### Step 2: Measure `ws:typecheck`

Run the workspace typecheck under both compilers; record times and any errors
tsgo reports that `tsc` doesn't (or vice-versa).

### Step 3: Run `test:types`

Run the type-regression suite under tsgo; record **type-identity** and
**expected-error** parity (per question 3), not diagnostic text.

⚠️ `type-tests/probe-audit.ts` is currently **untracked** in git yet is compiled
by `tsc -p` (`include: ["*.ts"]`) — so the `test:types` result depends on
uncommitted working-tree state. Note its presence/absence when you record the
result, or the spike isn't reproducible.

### Step 4: Report + recommendation

Write findings + a clear recommendation. **STOP** — adoption is a follow-up
decision.

## Done criteria

- [ ] A report with the time delta, resolution/diagnostic drift, and a
      recommendation exists
- [ ] `test:types` result under tsgo is recorded
- [ ] The repo's `typescript` version is unchanged in the main tree
- [ ] `plans/README.md` status row for 024 updated (with the recommendation)

## STOP conditions

- tsgo can't resolve the `Bundler`/`.ts`-exports layout — that's the headline
  finding; record and recommend waiting.
- The spike environment can't install tsgo — report what was and wasn't measured.

## Maintenance notes

- If adopted for typecheck-only, keep `tsc` 5.x as the fallback for anything tsgo
  can't check (e.g. the exact-diagnostics suite) until parity holds.
