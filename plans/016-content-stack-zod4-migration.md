# Plan 016: Move `@lesto/content-shared` off zod 3 to zod 4

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/content-shared/ site/ bun.lock`

## Status

- **Priority**: P2
- **Effort**: **S** (re-scoped — one `content-shared` zod bump + one file's
  zod-4 migration; the `@content-collections` "upstream bump" was DROPPED, see
  below)
- **Risk**: LOW–MED (zod 3→4 semantics in one file; the site build is the net)
- **Depends on**: coordinate with 002/007/017 on `bun.lock` (see README chain)
- **Category**: dependencies / migration
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

The framework's boundary-validation story is zod 4 (ADR 0005), and the whole
repo resolves `zod@4` — **except** `@lesto/content-shared`, which pins
`"zod": "^3.22.0"` as a **runtime** dependency. Its `createValidator(schema:
z.ZodType<T>)` (`content-shared/src/validation.ts:88`) accepts a *user's* schema,
so a zod-3 pin here is precisely the cross-boundary type-mismatch a zod-4 app
hits when it passes a schema in. Moving this one package to zod 4 removes the
last zod-major split in the published surface.

**What this plan does NOT do (dropped after review):** the earlier framing —
"bump `@content-collections/core` 0.9→0.15" — was wrong. `@content-collections/{core,markdown,mdx}`
are **devDependencies imported nowhere** in the repo (grep confirms zero `src`
imports across all content packages and `site/`); they are vestigial Docks
tooling. Migrating a library nothing calls is busywork. Those dead devDeps are
**deleted** in plan 017, not upgraded here.

## Current state

- `packages/content-shared/package.json:72` — **runtime** dep `"zod": "^3.22.0"`.
- `packages/content-shared/src/validation.ts` — the real migration surface:
  `createValidator(schema: z.ZodType<T>)` (`:88`) and `result.error.flatten()`
  (`:94`). `.flatten()` is the main zod-4-migration target (its shape/name
  changed in zod 4). This is a ~135-line file — the whole zod-4 surface.
- `bun.lock` — a nested `zod@3.25.76` for content-shared; everything else `zod@4.x`.
- `packages/content-core`'s zod is a **devDep** (`^4.1.13`), content-mcp is
  `^4.x` — so only content-shared's runtime pin is on zod 3.
- `site/` builds on this stack (CI-gated) — the safety net.

### Conventions to follow

- **RELEASING dragon**: `rm -f bun.lock && bun install` after the manifest change.
- Migrate to the zod-4 idioms the rest of the repo uses — grep non-content
  `packages/*/src` for the current `z.ZodType` / error-formatting patterns and
  match them. `.flatten()` → the zod-4 equivalent (`z.treeifyError` /
  `error.flatten()` semantics changed; check what the repo's other zod-4 callers
  use).
- Note: `content-shared` is **not** coverage-gated — the exemption is the prefix
  skip at `scripts/coverage-gate.ts:27` (`if (dir.startsWith("content-")) continue;`),
  NOT ADR 0035 — so use `bun run test`, not `test:cov`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Find the pin | `grep -n '"zod"' packages/content-shared/package.json` | `^3.22.0` |
| Re-lock | `rm -f bun.lock && bun install` | exit 0 |
| Typecheck+test | `cd packages/content-shared && bun run typecheck && bun run test` | pass |
| Site build (net) | (the repo's `site` build+test command from `ci.yml`) | pass |

## Scope

**In scope**:
- `packages/content-shared/package.json` (zod `^3` → `^4`)
- `packages/content-shared/src/validation.ts` (the zod-4 idiom migration)
- `bun.lock`, and any `site/` fallout the zod change surfaces

**Out of scope**:
- `@content-collections/*` (dead devDeps — plan 017 deletes them).
- Non-content packages (already zod 4).
- The `serialize-javascript` bump (plan 002) and the error-brand refactor (007).

## Steps

### Step 1: Bump the pin + re-lock

Change `content-shared`'s runtime `zod` to `^4`; `rm -f bun.lock && bun install`.

**Verify**: `grep -n '"zod"' packages/content-shared/package.json` shows `^4`;
`bun install` exit 0.

### Step 2: Migrate `validation.ts` to zod-4 idioms

Fix the zod-3-only usage — chiefly `result.error.flatten()` at `:94` and the
`z.ZodType<T>` generic at `:88` — to the zod-4 forms the rest of the repo uses.

**Verify**: `cd packages/content-shared && bun run typecheck && bun run test` → pass.

### Step 3: Prove the site builds

Run the site build+test (the CI-gated safety net) and fix fallout.

**Verify**: the site build+test passes; `bun run ws:typecheck` for content-shared is green.

## Test plan

- The existing `content-shared` suite covers `validation.ts`; the site build is
  the integration net. If a test asserts on zod-3 error-message **formatting**
  that changed under zod 4, update it to the zod-4 shape (expected migration
  fallout). If a test asserts on **content output** that changed, STOP and report.

## Done criteria

- [ ] `grep -n '"zod"' packages/content-shared/package.json` shows `^4`
- [ ] `cd packages/content-shared && bun run typecheck && bun run test` pass
- [ ] The `site` build+test passes
- [ ] `bun.lock` no longer carries a zod-3 copy for content-shared
- [ ] `@content-collections/*` NOT touched here (that's plan 017)
- [ ] `plans/README.md` status row for 016 updated

## STOP conditions

Stop and report if:
- `.flatten()`'s zod-4 replacement changes the *shape* of validation errors that
  a content consumer/test depends on (surface it rather than silently reshaping).
- A content test asserts on serialized/content output that changes.
- The site build reveals a runtime break the type system didn't catch.

## Maintenance notes

- This is the zod tranche of the DIR-03 "bring content-* to the bar" direction
  (007 = error brand, 017 = dead deps). The DIR-03 capstone (removing the
  `content-` prefix skip at `coverage-gate.ts:27` once the stack meets the bar,
  or ratifying its permanence) is a separate decision — see the README.
- Reviewer should confirm no non-content package's zod changed and the site
  (docs.lesto.run substrate) still builds.
