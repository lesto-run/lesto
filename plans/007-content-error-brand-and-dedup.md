# Plan 007: Re-base `content-*` errors on `@lesto/errors` and delete duplicated shutdown/cache

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. This is
> a STAGED plan — do the stages in order; the codebase must stay green between
> stages. If a "STOP conditions" item occurs, stop and report. When done, update
> the status row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/content-shared/ packages/content-core/ packages/web/src/harden.ts`

## Status

- **Priority**: P2 — **Stage 1 (errors) is the pre-launch part** (it's a
  breaking ctor change to a published 0.1.7 class, cheapest to land before
  launch); **Stages 2–3 (shutdown, cache) are post-launch** internal dedup with
  no launch value and their own `bun.lock` re-locks.
- **Effort**: L (staged: errors → shutdown → cache)
- **Risk**: MED
- **Depends on**: **serialize with plan 002** — 002 also edits
  `content-shared/package.json` (the `serialize-javascript` pin) and re-locks
  `bun.lock`; run 002 first, then 007, in the content-* serialization chain.
- **Category**: tech-debt / correctness
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

`content-*` is a vendored parallel framework that bypasses three core seams —
the error model, graceful shutdown, and the cache. This plan brings the error
model back into the `@lesto/errors` brand family and deletes the two
duplications.

**Scope-correcting note (read before writing the acceptance test):**
`@lesto/web`'s `statusForError` (`web/src/harden.ts:198-213`) is a **closed
allowlist** — it maps a fixed set of codes (`RUNTIME_*`, `ROUTER_*`, `WEB_*`,
`CLOUDFLARE_*`) to 4xx/413/503 and returns **500 for every other branded code**.
So branding a `DocksError` does **not** by itself make it map to a 4xx: a
branded `DocksError{code:"VALIDATION_ERROR"}` still yields 500 unless its code is
added to that allowlist (which is out of scope — `harden.ts` is a web-tier
contract). The real, in-scope value of branding is: (1) cross-install
recognition — `isLestoError`/`hasCode` work across a duplicate `@lesto/errors`
install; (2) one error model for the `content-mcp` surface, where errors are
surfaced to **agents** and branch-on-`code` is the ADR 0031/0035 contract; and
(3) `@lesto/ui` (a gated core package) imports `@lesto/content-shared`, so an
unbranded content error crossing into core is invisible to `hasCode`. Content
errors are mostly **build-time** (content generation; docs.lesto.run is a static
build), so the HTTP-status angle is minor — do **not** frame this as "fix the
500 on docs.lesto.run." Secondary duplications: `content-shared` re-derives the
runtime's graceful-shutdown, and wraps `lru-cache` where `@lesto/cache`'s
`MemoryStore` already exists.

## Current state

- **Core error base** (the shape to adopt):
  ```ts
  // packages/errors/src/errors.ts — LestoError(code, message, details), carries
  // the process-global Symbol.for("lesto.error") brand; recognized via isLestoError/hasCode.
  ```
- **Content's unbranded base** (arg order swapped, `context` not `details`, no brand):
  ```ts
  // packages/content-shared/src/errors.ts:5
  export class DocksError extends Error {
    readonly code: string;
    readonly context: Record<string, unknown>;
    readonly timestamp: Date;
    constructor(message: string, code: string, context: Record<string, unknown> = {}) { ... }
    toJSON(): Record<string, unknown> { ... }
  }
  // :40  export class ValidationError extends DocksError { ... }  // name collides with content-core's
  ```
- **content-core plain-`Error` classes with NO code at all**:
  ```ts
  // packages/content-core/src/types.ts:733  class ValidationError extends Error   (issues/filePath/collection)
  // packages/content-core/src/types.ts:749  class TransformError extends Error
  // packages/content-core/src/types.ts:770  class SerializationError extends Error
  ```
- **The web boundary that only sees the brand**:
  ```ts
  // packages/web/src/harden.ts:198
  export function statusForError(error: unknown): number {
    if (isLestoError(error)) { /* maps RUNTIME_*/WEB_*/ROUTER_* codes to 4xx/413/503 */ }
    return 500;   // <-- a DocksError lands here
  }
  ```
- **Duplicated shutdown**: `packages/content-shared/src/shutdown.ts:43`
  `class GracefulShutdown` (SIGINT/SIGTERM, force-exit) duplicates
  `packages/runtime/src/graceful-shutdown.ts` `serveWithGracefulShutdown`
  (same signals, double-signal guard, force-exit) — whose doc says it exists so
  callers dogfood it rather than re-derive it.
- **Duplicated cache**: `packages/content-shared/src/cache.ts:1`
  `import { LRUCache } from "lru-cache"` duplicates
  `packages/cache/src/memory-store.ts` `MemoryStore` (own LRU+TTL, no external dep).
- `content-shared`'s `package.json` currently declares **zero** `@lesto/*` deps
  (it is sealed from the kernel) — Stage 1 adds `@lesto/errors`.

### Conventions to follow

- **Errors carry codes**; recognize the base via `isLestoError`/`hasCode`, never
  `instanceof LestoError` (oxlint rule `lesto-errors/no-base-instanceof-lesto-error`
  enforces this and will keep the migration honest).
- `content-core` is **not** 100%-coverage-gated (ADR 0035) — use `bun run test`,
  not `test:cov`, there. `content-shared` — check its `package.json` for a
  coverage gate before assuming.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Typecheck (shared) | `cd packages/content-shared && bun run typecheck` | exit 0 |
| Test (shared) | `cd packages/content-shared && bun run test` | all pass |
| Typecheck (core) | `cd packages/content-core && bun run typecheck` | exit 0 |
| Test (core) | `cd packages/content-core && bun run test` | all pass |
| Web still green | `cd packages/web && bun run typecheck && bun run test:cov` | exit 0, 100% |
| Errors lint rule | `bun run ws:lint` | exit 0 (no base-instanceof) |

## Scope

**In scope**:
- `packages/content-shared/package.json` (add `@lesto/errors`; later drop `lru-cache`)
- `packages/content-shared/src/errors.ts`, `shutdown.ts`, `cache.ts`
- `packages/content-core/src/types.ts` (the three plain-`Error` classes)
- Call sites within `content-*` that construct these errors / use the shutdown/cache
- Tests within `content-*`

**Out of scope**:
- `packages/web/src/harden.ts` — it is correct; the fix is to make content
  errors branded, not to change the mapping.
- `packages/errors`, `packages/runtime`, `packages/cache` internals.
- The zod/deps migration (that is plan 016) and dead-dep pruning (plan 017).

## Stages

### Stage 1 — Errors (the correctness fix; do this first, it stands alone)

1. Add `"@lesto/errors": "workspace:*"` to `content-shared/package.json`
   dependencies; `rm -f bun.lock && bun install`.
2. Re-base `DocksError` on `LestoError`: adopt `LestoError`'s
   `(code, message, details)` contract and the brand. Type the new `code`
   parameter as a **string-literal union** (the house pattern, e.g.
   `WebhookErrorCode` at `webhooks.ts:91`) — this makes a swapped ctor argument a
   **compile error** rather than a silent runtime bug (both args are strings, so
   `tsc` won't otherwise catch a swap). This is a **larger blast radius than
   "swap two args"**: it also renames `context` → `details`, so `toJSON()`
   (`errors.ts:25-33`) and every `.context` reader must move to `details` (which
   is frozen on `LestoError`). Keep `timestamp`/`toJSON` as **additive** members
   if content code relies on them. Update every `new DocksError(...)` /
   `extends DocksError` / subclass ctor and every `.context` read (grep all
   four).
3. Give the three `content-core` plain-`Error` classes (`ValidationError`,
   `TransformError`, `SerializationError`) a stable `code` by re-basing them on
   `LestoError` too (or on the re-based `DocksError`), preserving their extra
   fields (`issues`, `filePath`, `entryId`, `cause`).
4. Resolve the `ValidationError` name collision between
   `content-shared/src/errors.ts:40` and `content-core/src/types.ts:733` — they
   are different shapes; give one a distinct name or a distinct code so a
   maintainer can tell them apart.

**Verify (Stage 1)**:
```
cd packages/content-shared && bun run typecheck && bun run test
cd ../content-core && bun run typecheck && bun run test
cd ../web && bun run typecheck && bun run test:cov
bun run ws:lint
```
→ all green. Add a test (in content-shared) asserting brand recognition:
`isLestoError(new DocksError("VALIDATION_ERROR", "...")) === true`,
`hasCode(e, "VALIDATION_ERROR") === true`, and that subclass `instanceof`
(`instanceof ValidationError`) still holds. Do **NOT** assert
`statusForError(...) === 4xx` — that is unachievable in scope (see the
scope-correcting note; `statusForError`'s allowlist doesn't include content
codes and `harden.ts` is out of scope). If you want the HTTP mapping, that is a
separate, deliberate decision to register content codes in `harden.ts` — record
it as a follow-up, don't smuggle it in here.

### Stage 2 — Shutdown

Delete `content-shared/src/shutdown.ts` and route its callers to the runtime's
`serveWithGracefulShutdown` (`packages/runtime/src/graceful-shutdown.ts`). If a
content caller needs a capability the runtime helper lacks, STOP and report —
do not keep two implementations.

**Verify (Stage 2)**: `cd packages/content-shared && bun run typecheck && bun run test`
and any content example/app that used the shutdown still builds. `grep -rn "GracefulShutdown" packages/content-*` shows no surviving local class.

### Stage 3 — Cache

Back `content-shared/src/cache.ts` with `@lesto/cache`'s `MemoryStore` instead of
`lru-cache`; remove `lru-cache` from `content-shared/package.json`; `rm -f bun.lock && bun install`.
If `@lesto/cache`'s `MemoryStore` API cannot express a limit `content-shared`
needs (e.g. per-entry size weighting), STOP and report rather than keeping the
external dep.

**Verify (Stage 3)**: `cd packages/content-shared && bun run typecheck && bun run test`;
`grep -n "lru-cache" packages/content-shared/package.json` returns nothing;
`bun audit` unaffected.

## Test plan

- Stage 1: a brand-recognition test (above) — this is the whole point; make it
  non-vacuous (construct a `DocksError`, assert `isLestoError` true, assert the
  web mapping yields the coded status, and confirm it would fail if the class
  went back to `extends Error`).
- Stages 2–3: rely on the existing content suites plus a smoke that the docs
  site (or a content example) still builds if one is wired locally.

## Done criteria

- [ ] `isLestoError(new DocksError(...))` is `true` and `hasCode(e, "…")` works;
      subclass `instanceof` still holds (test present). (NOT a `statusForError`→4xx
      assertion — that's out of scope; see the scope-correcting note.)
- [ ] `grep -rn "extends Error" packages/content-shared/src packages/content-core/src` shows no coded-error class still on bare `Error`
- [ ] `packages/content-shared/src/shutdown.ts` deleted; `grep -rn "lru-cache" packages/content-shared` empty
- [ ] All `content-shared`/`content-core` and `@lesto/web` gates green; `bun run ws:lint` clean
- [ ] `plans/README.md` status row for 007 updated

## STOP conditions

Stop and report if:
- Re-basing changes observable content **output** (not just error identity) —
  e.g. a test asserts on `DocksError`'s `context` field shape that `details`
  can't preserve.
- The runtime shutdown helper or `@lesto/cache` `MemoryStore` lacks a capability
  a content caller depends on.
- The ctor-arg-order migration touches more than ~40 call sites (the audit
  estimate) — report the true count before proceeding.

## Maintenance notes

- This is the concrete half of the DIR-03 "bring `content-*` to the house bar"
  direction; the coverage-gating and zod-4 tranches are plans 016/017 and a
  separate scoping decision (ADR 0035 deliberately exempts truly-vendored code).
- Reviewer must scrutinize the ctor-arg-order change — a missed call site is a
  runtime break the type system may not catch if the args are both strings.
