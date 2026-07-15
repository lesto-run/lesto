# Plan 012: Align `content-mcp`'s MCP SDK spec and normalize the workspace protocol

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/content-mcp/package.json packages/identity/package.json packages/integration/package.json packages/mailing-lists/package.json bun.lock`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dependencies
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

Two manifest-spec drifts publish a lie to downstream installers even though the
in-repo lockfile hides them:

1. `packages/content-mcp/package.json:40` declares
   `"@modelcontextprotocol/sdk": "^1.0.4"` while root and `packages/mcp` use
   `^1.29.0`. In-repo it dedupes to 1.29.0, but the **published** manifest tells
   a downstream app "any 1.x ≥ 1.0.4 is fine" — an app already holding, say, SDK
   1.5 will dedupe `content-mcp` onto it and hit missing-API failures at runtime.
2. Workspace-protocol drift: `packages/identity/package.json:29`
   (`"@lesto/mail": "workspace:^"`) is the **sole** `workspace:^` outlier
   repo-wide — every other internal dep uses `workspace:*`. `workspace:^`
   publishes as `^0.1.7` vs `*`'s exact `0.1.7`: two different upgrade semantics
   for the same lockstep-released surface. (Only this one spec changes; the
   earlier prose framing of "outliers" plural was imprecise.)

Both are the works-in-repo / breaks-downstream class that every in-repo gate
(including `pack-boot`, which installs the fresh closure) can miss.

## Current state

- `packages/content-mcp/package.json:40` — `"@modelcontextprotocol/sdk": "^1.0.4"`.
- Root `package.json` — `"@modelcontextprotocol/sdk": "^1.29.0"`; `packages/mcp`
  matches.
- `packages/identity/package.json` — `"@lesto/mail": "workspace:^"` (grep to
  confirm the exact internal dep); `integration`/`mailing-lists` use
  `workspace:*`. The repo releases the whole `@lesto/*` surface in lockstep.

### Conventions to follow

- **RELEASING dragon**: after a manifest change, `rm -f bun.lock && bun install`;
  never hand-edit `bun.lock`.
- Pick the protocol that matches the lockstep release train. `workspace:*`
  publishes as the **exact** current version (`0.1.7`), which is the honest
  semantics for packages that are always released together; prefer it unless a
  package deliberately wants a caret range.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Find drift | `grep -rn "@modelcontextprotocol/sdk" packages/*/package.json` | content-mcp `^1.0.4`, others `^1.29.0` |
| Protocol drift | `grep -rn "workspace:" packages/*/package.json \| grep -v "workspace:\*"` | the `workspace:^` outliers |
| Re-lock | `rm -f bun.lock && bun install` | exit 0 |
| Verify content-mcp | `cd packages/content-mcp && bun run typecheck && bun run test` | exit 0 (content-mcp is not coverage-gated) |
| Pack-boot smoke | `bun run test:pack-boot` | exit 0 |

## Scope

**In scope**:
- `packages/content-mcp/package.json` (SDK spec)
- The `package.json` files using `workspace:^` for a lockstep internal dep
  (normalize to `workspace:*` — or whichever the repo standardizes on)
- `bun.lock` (regenerated)

**Out of scope**:
- Any `.ts` source.
- Deliberate caret ranges on **external** deps (only normalize the internal
  `workspace:` protocol; do not touch third-party version ranges beyond the
  content-mcp SDK).

## Steps

### Step 1: Raise the content-mcp SDK floor

Change `content-mcp`'s `@modelcontextprotocol/sdk` to `^1.29.0` (match root).
Then confirm `content-mcp`'s source only uses APIs present in ≥1.29.0 — grep its
`src` for SDK imports and sanity-check against `packages/mcp` usage.

**Verify**: `grep -rn "@modelcontextprotocol/sdk" packages/*/package.json` shows
`^1.29.0` everywhere; `cd packages/content-mcp && bun run typecheck` → exit 0.

### Step 2: Normalize the workspace protocol

Change the `workspace:^` internal-dep specs to `workspace:*` (exact, matching the
lockstep train). Confirm no package intentionally wants a caret (none is
documented).

**Verify**: `grep -rn "workspace:\^" packages/*/package.json` returns nothing.

### Step 3: Re-lock + smoke

**Verify**: `rm -f bun.lock && bun install` exit 0; `bun run test:pack-boot`
exit 0 (installs the fresh published-shape closure).

## Test plan

- No new unit tests. Verification is the manifest greps, `typecheck`, and
  `pack-boot` (which installs the real closure and boots it — the one gate that
  exercises published-manifest resolution).
- Optional: a small manifest-lint in `scripts/` asserting shared external deps
  use one spec repo-wide (the audit suggested this). If added, wire it where
  other `scripts/*` gates live and run it in CI.

## Done criteria

- [ ] `grep -rn "@modelcontextprotocol/sdk" packages/*/package.json` shows `^1.29.0` uniformly
- [ ] `grep -rn "workspace:\^" packages/*/package.json` empty
- [ ] `cd packages/content-mcp && bun run typecheck && bun run test` exit 0
- [ ] `bun run test:pack-boot` exit 0
- [ ] Only `package.json` files + `bun.lock` changed (`git status`)
- [ ] `plans/README.md` status row for 012 updated

## STOP conditions

Stop and report if:
- `content-mcp/src` uses an SDK API that differs between 1.0.4 and 1.29.0 in a
  way that needs a code change — report; a source change is out of scope here.
- A package's `workspace:^` turns out to be deliberate (documented) — leave it
  and note why.

## Maintenance notes

- A CI manifest-lint (if added) prevents this class from recurring — recommend it
  in the PR.
- Reviewer should confirm `pack-boot` passes (the real test of published-manifest
  resolution) and no source changed.
