# Plan 017: Prune `content-*` runtime deps that are never imported, and rename the misleading test

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/content-core/ packages/content-mdx/ packages/content-mcp/ bun.lock`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tech-debt / dependencies
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

Several `content-*` packages declare **runtime** dependencies they never import,
bloating install size and giving a false dependency signal on published packages.
And one test is named after a library the code doesn't use.

## Current state (verified — each is a `dependencies` entry with no `src` import)

- `packages/content-core/package.json` → `"fast-json-stringify": "^6.1.1"` is a
  runtime dependency but is **not imported anywhere in `src`**; the generator
  emits with plain `JSON.stringify(…, space)` (`content-core/src/generator.ts`).
  The test `packages/content-core/src/__tests__/fast-json-stringify.test.ts` is
  **named after a lib the code doesn't use** — it actually asserts NODE_ENV-driven
  minification of `JSON.stringify` (misleading name).
- `packages/content-mdx/package.json` → `"shiki"` — not imported in `src`.
- `packages/content-mcp/package.json` → `"zod-to-json-schema"` — not imported;
  `content-mcp`'s own `src` comments (`tools.ts`, `server.ts`) explain why they
  **avoid** it.
- `packages/content-core/package.json` → `@lesto/content-embeddings` — referenced
  only in a `build.ts` comment, not imported. **It is a `workspace:*` runtime
  dep and content-core is a code generator**, so also confirm the *emitted*
  output doesn't `import "@lesto/content-embeddings"` (grep generated templates /
  the codegen strings), not just `src`.
- `@content-collections/{core,markdown,mdx}` — **devDependencies imported
  nowhere** (verified: zero `src` imports across all content packages and
  `site/`; only package.json lines + docs + one unrelated test comment). These
  are vestigial Docks tooling. Plan 016's re-scope hands them here for deletion.
  (Note: `content-markdown`/`content-mdx` pin `@content-collections/{markdown,mdx}`
  at `^0.1.4`/`^0.2.2` — a different version track from core's `^0.9`; all three
  are dead regardless.)

(Confirm each with the grep in Step 1 before removing — do not trust this list
blind; deps can be added between planning and execution.)

### Conventions to follow

- **RELEASING dragon**: `rm -f bun.lock && bun install` after manifest edits.
- Verify "unused" means no static import AND no dynamic `import()`/`require`
  (grep both) AND not referenced by a build/codegen step.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prove unused | `grep -rn "fast-json-stringify" packages/content-core/src` etc. | no import (comments/test-name only) |
| Re-lock | `rm -f bun.lock && bun install` | exit 0 |
| Content gates | `cd packages/content-core && bun run typecheck && bun run test` (+ mdx, mcp) | pass |

## Scope

**In scope**:
- `packages/content-core/package.json`, `content-mdx/package.json`,
  `content-mcp/package.json`, `content-markdown/package.json` (remove the
  confirmed-unused deps, **including the dead `@content-collections/*` devDeps**)
- Rename `packages/content-core/src/__tests__/fast-json-stringify.test.ts` to a
  name matching what it tests (e.g. `json-minify.test.ts`) and update any
  describe/it titles.
- `bun.lock`

**Out of scope**:
- Any `src` behavior. Deps that ARE imported (even if it looks removable).
- The `content-shared` zod bump (plan 016).

## Steps

### Step 1: Confirm each dep is truly unused

For each candidate, grep `src` for a static import, a dynamic `import(`, a
`require(`, and any build/codegen reference. Only remove a dep with zero hits
(comments and the mis-named test do not count as usage).

**Verify**: the grep for each removed dep shows no real usage.

### Step 2: Remove + re-lock

Delete the confirmed-unused entries; `rm -f bun.lock && bun install`.

**Verify**: `rm -f bun.lock && bun install` exit 0; the deps are gone from the
manifests.

### Step 3: Rename the misleading test

Rename the `fast-json-stringify` test file to reflect what it asserts and update
its titles.

**Verify**: `cd packages/content-core && bun run test` → pass (the renamed test
still runs and passes).

## Test plan

- No new tests. Verification is: each removed dep has no importer (Step 1), the
  content packages still `typecheck` + `test`, and the renamed test still passes.
- Optional: a `depcheck`/`knip` pass over `content-*` to catch any others (report
  extras rather than removing blindly).

## Done criteria

- [ ] `grep -rn "fast-json-stringify" packages/content-core/src` shows no import (only the renamed test / comments)
- [ ] `shiki` gone from `content-mdx`, `zod-to-json-schema` gone from `content-mcp`, unused `@lesto/content-embeddings` gone from `content-core` (each verified unused)
- [ ] The mis-named test file is renamed and still passes
- [ ] `cd packages/content-core && bun run typecheck && bun run test` (+ mdx/mcp) pass
- [ ] Only `package.json` + the renamed test + `bun.lock` changed
- [ ] `plans/README.md` status row for 017 updated

## STOP conditions

Stop and report if:
- Any candidate dep turns out to be imported (static or dynamic) or used by a
  build step — leave it and note why.
- Removing a dep breaks a content gate (it shouldn't if truly unused) — report.

## Maintenance notes

- Consider adding `knip`/`depcheck` to CI for `content-*` so dead deps can't
  re-accrue (noted, not required here).
- Reviewer should re-run the unused-grep for each removed dep.
