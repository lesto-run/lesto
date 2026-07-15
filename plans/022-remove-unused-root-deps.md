# Plan 022: Remove unused runtime deps from the root manifest

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- package.json bun.lock`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW (verify no dynamic/spawned consumer)
- **Depends on**: none
- **Category**: dependencies / dx
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

The root `package.json` `dependencies` block carries `@anthropic-ai/sdk`,
`@modelcontextprotocol/sdk`, `better-sqlite3`, and `zod`, but nothing at the
**root** imports them — every consuming package declares its own copy
(`@anthropic-ai/sdk`→`ui-generate`; `@modelcontextprotocol/sdk`→`mcp`/`content-mcp`/`e2e`;
`better-sqlite3`→`content-store`/`integration`/`migrate`; `zod`→8 packages).

**Why this matters more than "install bloat":** a workspace member can still walk
up and **phantom-import anything the root declares** — that is exactly the
failure ADR 0045 exists to bound (its canonical example is the `pg`/`live-server`
incident), and `bunfig.toml` pins `[install] linker = "isolated"` with
`scripts/assert-isolated-node-modules.mjs` enforcing it. Removing these root deps
closes a **works-in-repo / breaks-published** mask, not just an install cost. (An
earlier draft of this plan had the ADR 0045 rationale backwards — it does not
make root deps unreachable; it bounds the damage.) Secondary: every `bun install`
pays for an unused Anthropic SDK and a native `better-sqlite3` build, and the
root `@anthropic-ai/sdk ^0.102.0` creates a false "we're on 0.102" signal.

## Current state

- Root `package.json` `dependencies`:
  ```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.102.0",
    "@modelcontextprotocol/sdk": "^1.29.0",
    "better-sqlite3": "^11.10.0",
    "zod": "^4.0.0"
  }
  ```
- No root code imports them: `scripts/`, `type-tests/`, and `e2e/` import only
  `@lesto/*` (verify in Step 1). Each is declared by its real consumer
  (`ui-generate`, `mcp`, `content-store`/`migrate`, various).

### Conventions to follow

- **RELEASING dragon**: `rm -f bun.lock && bun install` after manifest edits.
- Verify "unused at root" against static imports, dynamic `import()`, and
  anything a root **script** spawns (`node scripts/*`, `bun run ...`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Prove unused | `grep -rn "@anthropic-ai/sdk\|@modelcontextprotocol/sdk\|better-sqlite3\|from \"zod\"" scripts type-tests e2e 2>/dev/null` | no hits |
| Re-lock | `rm -f bun.lock && bun install` | exit 0 |
| Full gate | `bun run ws:typecheck && bun run ws:lint && bun run ws:format:check && bun scripts/coverage-gate.ts` | exit 0 |
| Smokes | `bun run test:pack-boot && node scripts/require-node.mjs` | exit 0 |

## Scope

**In scope**:
- Root `package.json` `dependencies` block.
- `bun.lock` (regenerated).

**Out of scope**:
- `devDependencies` at root (they ARE used — vitest, oxfmt, react, etc.).
  Note: removing `better-sqlite3` leaves `@types/better-sqlite3` orphaned in root
  `devDependencies` (no root tsconfig references it; `type-tests` uses
  `types: ["node"]`). Out of scope here, but call it out in the PR so a reviewer
  isn't surprised — or remove it too if the gate stays green.
- Any package's own `dependencies`.

## Steps

### Step 1: Confirm each is unused at root

Grep `scripts`, `type-tests`, `e2e`, and any root-level `.ts`/`.mjs` for each dep
(static + dynamic import). Check no root script spawns a tool that needs a
root-level copy.

**Verify**: the grep shows no root consumer.

### Step 2: Remove + re-lock

Delete the `dependencies` block (or, if one dep turns out to be genuinely
root-needed, move only that one to `devDependencies` with a comment naming its
consumer). Then **plain `bun install`** — do NOT `rm -f bun.lock`. That
full-regen dragon is for post-`bun run version` release cuts; here it would float
every `^`-ranged transitive dep to latest across 49 published packages for no
reason. A plain `bun install` removes only the dead entries.

**Verify**: `bun install` exit 0; `git diff bun.lock` shows only the removed
entries (not a wholesale re-resolve).

### Step 3: Full gate + smokes (regression smoke, not proof)

**Verify**:
```
bun run ws:typecheck && bun run ws:lint && bun run ws:format:check && bun scripts/coverage-gate.ts
bun run test:pack-boot
```
→ all exit 0. Note these are a **regression smoke, not proof**: under the
isolated linker they resolve per-package and `pack-boot` exercises the published
closure, so none of them resolve from root `node_modules`. The real proof that
the removal is safe is the Step-1 grep plus the ADR 0045 isolated layout.

## Test plan

- No new tests. Verification is the grep (Step 1) + the full workspace gate +
  `pack-boot` (which installs a fresh closure). If any of these fail, a root dep
  was load-bearing after all — STOP.

## Done criteria

- [ ] Root `package.json` no longer lists the unused runtime deps
- [ ] `grep` shows no root consumer of the removed deps
- [ ] `bun run ws:typecheck && bun run ws:lint && bun run ws:format:check && bun scripts/coverage-gate.ts` exit 0
- [ ] `bun run test:pack-boot` exit 0
- [ ] Only root `package.json` + `bun.lock` changed (`git status`)
- [ ] `plans/README.md` status row for 022 updated

## STOP conditions

Stop and report if:
- Any removed dep has a real root consumer (static, dynamic, or spawned) — keep
  it and note the consumer.
- Removal breaks the coverage gate or `pack-boot` — a hidden hoist dependency;
  report before working around it (the isolated-node_modules ADR 0045 says this
  shouldn't happen, so a failure is itself worth surfacing).

## Maintenance notes

- Root `dependencies` should stay empty (or documented per-entry) — the isolated
  layout means shared runtime deps belong to their consuming packages.
- Reviewer should confirm `pack-boot` passed after removal.
