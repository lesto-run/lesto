# Plan 021: Serialize dev route-reload so overlapping reloads can't pin stale app code

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/cli/src/run.ts`

## Status

- **Priority**: P3 (dev-only, but on the dev-loop this repo keeps chasing)
- **Effort**: S
- **Risk**: LOW (dev path only)
- **Depends on**: none
- **Category**: correctness
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

`lesto dev`'s route watcher fires a new async reload per (debounced) change with
**no in-flight guard**, and whichever `refreshRoutes` resolves **last** wins the
`activeApp` swap — even if it started earlier. Rapid saves can therefore leave the
**older** route code live with no error (out-of-order completion pins stale code),
and each reload re-runs migrations/schema installers against the live DB while
requests are served. It is dev-only, but it is exactly the "saved file didn't
take" ghost the repo's dev-loop work keeps hunting. The fix: serialize reloads and
stamp each with a sequence number so an older completion can't overwrite a newer
swap.

## Current state

- The unserialized reload + last-writer-wins swap:
  ```ts
  // packages/cli/src/run.ts:2105
  const onRouteChange = async (): Promise<void> => {
    const { reloaded, error } = await refreshRoutes(deps, devLog);
    if (reloaded !== undefined) {          // last to resolve wins, regardless of start order
      activeApp = reloaded.app;
      activeRoutes = reloaded.routes;
    }
    if (error !== undefined) showOverlay(error);
    else if (overlayUp) reloadBrowser();
    else swapPage();
  };
  // :2125  a new pass per debounced event, no in-flight guard:
  const stopRoutes = deps.watchRoutes?.(() => void onRouteChange());
  ```

### Conventions to follow

- Separate deciding from timing; keep the swap atomic (the `reloaded` object
  already nests app+routes so they move together — preserve that).
- The CLI package is 100%-coverage-gated; drive the race deterministically with
  a fake `watchRoutes`/`refreshRoutes` (no real file watching or waiting).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Gate | `cd packages/cli && bun run typecheck && bun run lint && bun run format:check && bun run test:cov` | exit 0, 100% |

## Scope

**In scope**:
- `packages/cli/src/run.ts` — `onRouteChange` and its wiring (serialize + seq).
- `packages/cli/test/*` — add the out-of-order regression.

**Out of scope**:
- `refreshRoutes` / `createApp` internals and migration logic.
- The overlay/reload/swap UX branches (keep them; only the swap gating changes).
- DB-handle disposal on reload (a related but larger concern — note in
  maintenance; do not attempt here unless trivial).

## Steps

### Step 1: Serialize + sequence

- **Serialize (chain), not a bare sequence guard.** A seq guard fixes only the
  `activeApp` swap but leaves the plan's second concern — each reload re-running
  migrations/installers against the live DB — running concurrently; chaining
  serializes both. Chain invocations so only one reload runs at a time.
- **The chain MUST have a terminal `.catch`.** `pending = pending.then(onRouteChange)`
  alone **bricks the watcher on the first rejection**: if any link throws
  (`showOverlay`/`reloadBrowser`/`swapPage`, or a future throw), `pending`
  becomes a rejected promise and every later `.then(onRouteChange)` is skipped —
  no more reloads, the exact "save didn't take" ghost this plan targets. Use
  `pending = pending.then(onRouteChange).catch(() => {})` (or `.then(fn, fn)`).
- Optionally collapse N queued changes that arrive mid-reload into one trailing
  run (avoid a backlog of stale reloads).
- Ensure the `overlayUp`/`swapPage` decision uses the winning reload's result.

Note: the swap also feeds the **dev MCP's live view** (the comment at the swap
says so), so a stale pin poisons what an agent *observes* — this is
agent-activation-loop integrity (ADR 0032), not just human DX.

**Verify**: `cd packages/cli && bun run typecheck` → exit 0.

### Step 2: Tests + gate

**Verify**:
```
cd packages/cli && bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```
→ exit 0, 100%.

## Test plan

Modeled on the existing dev/run tests (inject `watchRoutes` + `refreshRoutes`):
1. **Out-of-order completion**: fire reload A (resolves slowly, older code) then
   reload B (resolves first, newer code); assert `activeApp` ends as **B**, not A.
   Make it red without the seq/serialize guard.
2. **Single reload** still swaps normally and drives the correct overlay/swap
   branch.
3. **Error reload** still shows the overlay and does not swap in a broken app.
4. **Rejection does not brick the chain** (the terminal-`.catch` regression):
   make one reload's handler throw, then fire a subsequent change and assert the
   later reload STILL runs and swaps. Make it red if the `.catch` is removed.

## Done criteria

- [ ] `cd packages/cli && bun run test:cov` exit 0, 100%, out-of-order regression present and red-without-the-fix
- [ ] `cd packages/cli && bun run lint && bun run format:check` exit 0
- [ ] A newer reload's result can never be overwritten by an older one (test 1)
- [ ] `plans/README.md` status row for 021 updated

## STOP conditions

Stop and report if:
- The excerpts don't match (drift) or a reload-serialization guard already exists.
- Serializing changes the debounce/overlay UX in a way an existing test asserts
  against — reconcile before proceeding.

## Maintenance notes

- The per-reload DB-handle/watcher accumulation (each reload re-imports
  `lesto.app.ts`, often opening a fresh DB handle) is a related leak on long dev
  sessions — out of scope here; worth a follow-up if dev sessions grow memory.
- Reviewer should confirm the swap is atomic and newest-wins under overlap.
