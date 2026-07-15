# Plan 023: Spike — widen the dev pipeline to Vite 8

> **Executor instructions**: This is an INVESTIGATE/SPIKE plan — the deliverable
> is a findings report and a go/no-go, not a shipped migration. Do the
> investigation, record results, and STOP for a decision before widening the
> published ranges. Update `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/assets/ packages/island-dev/ packages/content-vite/`

## Status

- **Priority**: P3 (investigate)
- **Effort**: M (spike)
- **Risk**: MED (Vite majors have broken plugin APIs)
- **Depends on**: none
- **Category**: dependencies / migration
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

A "current-tooling"-positioned framework caps Vite at `^7` as a **hard
dependency** in its dev pipeline while Vite 8 is current — so an app scaffolded
into a Vite-8 ecosystem drags a second Vite. The tracked Vite Environments work
(`L-37fe99e6`, Phase 3) will widen the gap if built against 7. This spike
determines whether Vite 8 is adoptable and what breaks.

## Current state

- `packages/assets/package.json:27` and `packages/island-dev/package.json:27` —
  `"vite": "^7.0.0"` as **dependencies** (not peer).
- `packages/content-vite/package.json:46` — peer `^5.0.0 || ^6.0.0 || ^7.0.0`.
- `island-dev` also exact-pins `@prefresh/vite: 3.0.1` and
  `@vitejs/plugin-react: 4.7.0` (dependencies — patch fixes never flow).
- `npm view vite version` → 8.x. The island dev server depends on undocumented
  Vite internals (see the `island-dev-cold-start-504-flake` memory), so this
  needs real verification, not a range edit.

## What to produce

A short report (append to this plan or a `plans/notes/023-vite8.md`) covering:
1. Does `bun install` with Vite 8 resolve across `assets`, `island-dev`,
   `content-vite` (and their pinned plugins)?
2. Does the island hydration path work under Vite 8? (Run the island
   Fast-Refresh / hydration e2e in `packages/e2e` — the safety net.)
3. What plugin-API breakage appears (the `@prefresh/vite` / `@vitejs/plugin-react`
   pins, any Vite-internal usage in `island-dev/src/vite.ts`)?
4. Go/no-go + estimated effort to widen ranges to `|| ^8.0.0`, and whether to
   fold it into the `L-37fe99e6` Environments work so it's done once.

## Steps

### Step 1: Spike branch install

In a throwaway/spike checkout, bump `vite` to `^8` in `assets` + `island-dev`,
widen `content-vite`'s peer, `rm -f bun.lock && bun install`. Record resolution
errors.

### Step 2: Run the island e2e — and a static fallback if it can't run

Run the island hydration / Fast-Refresh e2e (`packages/e2e`). Record failures and
whether they trace to Vite-8 plugin-API changes.

**The sandbox likely blocks this** (server-starts + Playwright). So ALSO do a
static pass regardless, so the spike yields signal either way: read
`packages/island-dev/src/vite.ts` and enumerate its **Vite-internal** usage, then
diff that against the Vite 8 changelog/migration guide. Record which internals
moved or were removed. That, plus the resolution result, is enough for a go/no-go
even without the e2e.

### Step 3: Assess the pinned plugins

Check whether `@prefresh/vite` and `@vitejs/plugin-react` have Vite-8-compatible
releases; note the required bumps.

### Step 4: Write the report + recommendation

Record findings + go/no-go. **STOP** — do not widen the published ranges without
a decision (that's the follow-up build plan).

## Done criteria

- [ ] A report answering the four questions above exists
- [ ] The island e2e was run under Vite 8 and its result recorded
- [ ] A go/no-go + effort estimate is stated
- [ ] No published version ranges changed in the main tree (spike only)
- [ ] `plans/README.md` status row for 023 updated (with the recommendation)

## STOP conditions

- The spike environment can't run the island e2e (sandbox/browser limits) —
  report what could and couldn't be verified.
- Vite 8 requires reworking `island-dev`'s Vite-internal usage substantially —
  record it as the headline finding and recommend coupling to `L-37fe99e6`.

## Maintenance notes

- Whoever picks up the follow-up build plan should widen ranges (not hard-bump)
  so apps on Vite 7 still resolve, and unpin the two plugins to `^`.
