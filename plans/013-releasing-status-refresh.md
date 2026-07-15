# Plan 013: Refresh the stale `RELEASING.md` status block (0.1.5 → 0.1.7)

> **Executor instructions**: Follow step by step. STOP on any "STOP conditions"
> item. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- RELEASING.md` and
> `npm view @lesto/queue version` to confirm the current published version.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

`RELEASING.md` opens "This is the source of truth" but its status block says
"**0.1.5 is live on npm as of 2026-07-09**" while the repo is on **0.1.7**
(`packages/queue/package.json` is `0.1.7`, npm serves 0.1.7) — and the same doc
elsewhere references "the 0.1.7 near-miss." A release doc that is wrong about the
current release erodes trust in the parts that are load-bearing (the DRAGONs, the
`release:cut` preconditions), and the next release cutter can't tell stale from
current. Two weeks before L1, the release runbook should be accurate.

## Current state

- `RELEASING.md:6-7` — the stale status line:
  > **Status:** the surface is **published**. `0.1.1` … → **`0.1.5` is live on
  > npm as of 2026-07-09** — **49 public packages** …
- `RELEASING.md:127` — "As of **0.1.5** the 48 public `@lesto/*` packages are …".
- `RELEASING.md:67` — references the "0.1.7 near-miss" (already assumes 0.1.7).
- Ground truth: `packages/queue/package.json` version is `0.1.7`; the package
  count is 49 public (48 `@lesto/*` + `create-lesto`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Confirm live version | `npm view @lesto/queue version` | `0.1.7` (or newer) |
| Confirm repo version | `grep '"version"' packages/queue/package.json` | matches |

## Scope

**In scope**:
- `RELEASING.md` (status block + the "as of 0.1.5" section).

**Out of scope**:
- The DRAGONs, `release:cut` steps, and the OIDC/Trusted-Publishing prose — do
  not rewrite the mechanics; only the version/status facts.

## Steps

### Step 1: Update the version facts

- Change the status line (`RELEASING.md:6-7`) to state the current published
  version (from `npm view @lesto/queue version`) and date, keeping the
  provenance / 13-battery / OIDC facts.
- Change the "As of 0.1.5 …" section (`:127`) to the current version. **Keep
  the count at 48** here — line 127 is scoped to `@lesto/*` packages (48); the
  49 figure is 48 `@lesto/*` + `create-lesto`. Change only the version, not 48→49
  (or reword to "48 `@lesto/*` packages, 49 including `create-lesto`").
- Do NOT invent a changelog; if unsure of intermediate versions, state only the
  current one plus a pointer to `CHANGELOG.md`.

**Verify**: `grep -n "0\.1\.5" RELEASING.md` returns no stale "is live" claim;
the status line names the version `npm view` reports.

### Step 2: Add a freshness convention

Add one line: the status block is updated as part of `release:cut`'s checklist
(so it can't drift again). If `release:cut` has a documented checklist in this
file or `scripts/dev/release.sh`, reference it.

**Verify**: `grep -n "release:cut" RELEASING.md` shows the status-update note.

## Test plan

- No tests. Verification is the greps above plus a human read that the status
  block matches `npm view @lesto/queue version`.

## Done criteria

- [ ] `RELEASING.md` status block states the current published version (matches `npm view @lesto/queue version`)
- [ ] `grep -n "0.1.5 is live" RELEASING.md` returns nothing
- [ ] A "keep this fresh via release:cut" note is present
- [ ] Only `RELEASING.md` changed (`git status`)
- [ ] `plans/README.md` status row for 013 updated

## STOP conditions

Stop and report if:
- `npm view @lesto/queue version` disagrees with `packages/queue/package.json`
  (a genuine repo/registry mismatch worth surfacing, not papering over).

## Maintenance notes

- Consider generating the status version from `npm view` in a future release
  script so it can never go stale (noted, not required here).
- Reviewer should confirm no mechanics prose was altered.
