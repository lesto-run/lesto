# Plan 018: Make `content-mcp`'s inline sleeps injectable (the only real gap)

> **Executor instructions**: Follow step by step; run every verification command.
> STOP on any "STOP conditions" item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/content-mcp/`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (can fold into plan 007's content-* pass)
- **Category**: tech-debt / testability
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters — and what this plan is NOT

**Re-scoped after review.** The original framing ("the `sleep` one-liner is
copied ~7× with no cancellation-aware version") does not survive contact with the
code: almost every copy is a **default behind an injection seam**, which is the
CONVENTIONS.md testability rule ("inject what varies… the poll loop's `sleep` is
a parameter") *working as designed*, not drift:

- `workflows/src/sleep.ts` — `systemSleep` is the injected `Sleep` type's default.
- `queue/src/queue.ts:341` — `defaultSleep`, used as `options.sleep ?? defaultSleep`
  (`:911`); and the drain concern is **already solved deliberately** — the wait is
  sliced into `pollMs` chunks so `stop()` stays responsive (`queue.ts:965-969`).
- `realtime/src/pg-transport.ts` / `live-server/src/replication.ts` — `options.delay
  ?? realDelay`, where `realDelay` **unrefs** its timer (a semantic the others
  deliberately lack) and the loop re-checks its closed-flag after the backoff.

So there is no cross-cutting drift to consolidate, and a new shared package for a
one-liner would join a 49-package lockstep surface with real publish/README
overhead — not worth it. The **one genuine gap** is `content-mcp/src/client.ts`,
whose two inline `setTimeout` sleeps (`:94`, `:131`) are **not** behind an
injection seam, so that client's retry/reconnect timing can't be driven
deterministically in tests. This plan fixes only that.

## Current state

- `packages/content-mcp/src/client.ts:94,131` — inline
  `new Promise((r) => setTimeout(r, ms))` with no injected seam.
- Exemplars to match (injected-default pattern): `queue.ts:316` (`readonly sleep?:
  (ms: number) => Promise<void>`) + `:341` (`defaultSleep`) + `:911`
  (`options.sleep ?? defaultSleep`).

### Conventions to follow

- **Inject what varies** — add a `sleep?` option to the client's options with a
  real default, exactly like `queue`'s.
- `content-mcp` is **not** coverage-gated (the `content-` prefix skip at
  `scripts/coverage-gate.ts:27`) — use `bun run test`, not `test:cov`.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Find the inline sleeps | `grep -n "setTimeout" packages/content-mcp/src/client.ts` | :94, :131 |
| Typecheck+test | `cd packages/content-mcp && bun run typecheck && bun run test` | pass |

## Scope

**In scope**:
- `packages/content-mcp/src/client.ts` (add an injected `sleep` default; route
  both inline sleeps through it)
- `packages/content-mcp/test/*` (a test that drives the client's timing via the
  injected sleep — no real waiting)

**Out of scope**:
- `queue`, `workflows`, `realtime`, `live-server` sleeps — they are injected
  defaults working as designed; do NOT "consolidate" them.
- Creating a new shared sleep/retry package (rejected — no cycle-free home;
  `content-mcp` depends on neither `@lesto/errors` nor `@lesto/web`).

## Steps

### Step 1: Add an injected `sleep` to the content-mcp client

Give the client's options a `sleep?: (ms: number) => Promise<void>` with a
`defaultSleep` fallback (mirror `queue.ts:316/341/911`), and route both
`:94`/`:131` sleeps through it.

**Verify**: `cd packages/content-mcp && bun run typecheck` → exit 0;
`grep -n "setTimeout" packages/content-mcp/src/client.ts` shows the default only.

### Step 2: Test the timing deterministically

Add a test injecting a fake `sleep` (records/resolves immediately) and asserting
the retry/reconnect path advances without real waiting.

**Verify**: `cd packages/content-mcp && bun run typecheck && bun run test` → pass.

## Test plan

- One test that drives the client's retry/reconnect via the injected `sleep`
  (no real timers). Assert the sleep is invoked with the expected delay and that
  the loop re-checks its guard after the sleep (so a cancelled client doesn't
  busy-loop).

## Done criteria

- [ ] `content-mcp` client's inline sleeps route through an injected default
- [ ] `cd packages/content-mcp && bun run typecheck && bun run test` pass
- [ ] Only `content-mcp` changed (`git status`)
- [ ] `plans/README.md` status row for 018 updated

## STOP conditions

Stop and report if:
- The client's sleeps turn out to already be injectable (drift) — then there is
  nothing to do; report.

## Maintenance notes

- If plan 019's shared request-parsing module materializes as a natural leaf
  home, a shared cancellation-aware `sleep` could live there later — but do not
  create one for this alone.
- Reviewer should confirm no other package's sleep was "consolidated."
