# Plan 026: Design — deliver `lesto add <component>` and resolve the `add` command collision

> **Executor instructions**: DESIGN plan — the deliverable is a short design doc +
> the routing decision, and (if the decision is simple) the thin-wrapper
> implementation. Resolve the command-name conflict FIRST (it's a decision to
> record), then build only the thin wrapper the ADR describes. Update
> `plans/README.md` when done.
>
> **Drift check (run first)**: `git diff --stat 164bcaa..HEAD -- packages/cli/src/add.ts packages/cli/src/bin.ts docs/adr/0037-tailwind-and-shadcn-first-class.md docs/adr/0039-mcp-auth-batteries-capstone.md`

## Status

- **Priority**: P2 (direction)
- **Effort**: coarse S–M
- **Risk**: LOW
- **Depends on**: none
- **Category**: direction / dx
- **Planned at**: commit `164bcaa`, 2026-07-11

## Why this matters

**Framing correction (verified — read this before you believe the urgency):**
ADR 0037 (Tailwind + shadcn first-class) is **Status: Proposed** (2026-06-23) and
ADR 0039 (MCP-auth) is **Status: Proposed** — *neither is ratified*, and
`AGENTS.md` is explicit that "Proposed ≠ shipped." So this is **not** a broken
promise, a regression, or a collision between two shipped owners. `lesto add
button` failing today is simply the expected state of **unimplemented proposed
work** (the shadcn wrapper is ADR 0037's Phase-2 / TW8, still unbuilt), while
`lesto add mcp-auth` shipped from a different proposed ADR.

What IS true and worth doing: ADR 0037 sketches a thin `lesto add` shadcn wrapper
("`lesto add button` works in a Lesto app"), while `add` today routes to a closed
`INTEGRATIONS` list — so the command name has **two prospective owners**, and
someone should decide the routing *before* the wrapper is built rather than
discover the conflict during implementation. The "agent, add a button" on-ramp is
genuinely valuable for the launch audience, but this is **forward routing design
with latitude**, not an urgent conflict-resolution — do not treat it as
launch-gating.

## Current state

- The collision: `packages/cli/src/bin.ts:1292` routes `add` to `runAdd`;
  `packages/cli/src/add.ts:357` `const INTEGRATIONS = ["mcp-auth"] as const;`,
  and `add.ts:439` throws `CLI_ADD_UNKNOWN_INTEGRATION` for anything else — so
  `lesto add button` errors.
- ADR 0037 (`docs/adr/0037-*.md:259,265,422`) — the thin-wrapper design and the
  `lesto add button` promise; ADR 0037:354 describes island-wrapping localization
  for the added component.
- Prior session notes mark TW8 (`lesto add`) as the next Tailwind-initiative step.

## What to produce

A short design doc (append here or `plans/notes/026-lesto-add.md`) that:
1. **Resolves the name conflict.** Decide the routing between ADR 0039's
   `add <integration>` (closed list) and ADR 0037's `add <component>`
   (shadcn registry). Options to weigh:
   - fall-through: `add <name>` tries the integration list first, else delegates
     to `shadcn add <name>`;
   - namespacing: `lesto add integration <name>` vs `lesto add <component>`;
   - separate verbs: keep `add` for integrations, introduce `lesto ui add` or
     `lesto component add` for shadcn.
   Record the decision (and, if it changes a shipped command shape, note it for
   an ADR amendment).
2. **Specifies the thin wrapper** per ADR 0037: delegate to `npx shadcn add`,
   apply the ADR-0037:354 island-wrapping/localization, and the `@/*`→`./app/*`
   path convention (the known gotcha).
3. Lists open questions (registry config, offline behavior, where components land
   in a Lesto app tree).

## Steps

### Step 1: Decide routing

Write the decision with rationale. Both ADRs are **Proposed**, so you have
latitude — there is no ratified command shape to contradict; record the routing
in whichever ADR is ratified first. **Fall-through** (try the integration list,
else delegate to `shadcn add`) is the option that satisfies both ADRs' sketches
without changing either's stated command shape; namespacing or a separate verb
would require amending one.

Two hazards to spec if fall-through is chosen:
- A **typo'd integration name** now falls through into a network registry lookup;
  on `shadcn` failure the error must name **both** namespaces (integration AND
  component) and stay coded (`CLI_ADD_*`), per the errors-carry-codes bar.
- **Integration names permanently shadow registry components** (a future shadcn
  component named `mcp-auth` would be unreachable) — document the reservation.

### Step 2: Spec the wrapper

Define the arg routing, the shadcn delegation, and the island/localization step
from ADR 0037:354.

### Step 3: (If the decision is simple) implement the thin wrapper

If routing is a clean fall-through/namespacing that doesn't need ADR sign-off,
implement the thin wrapper + tests (the CLI package is 100%-coverage-gated). If it
needs an ADR amendment or owner decision, STOP after the design and report.

## Done criteria

- [ ] A design doc with the routing decision + wrapper spec + open questions exists
- [ ] The ADR-0037-vs-0039 command-name conflict is explicitly resolved (or the
      needed ADR amendment is named)
- [ ] If implemented: `lesto add button` (or the decided command) works, with
      tests, and `cd packages/cli && bun run test:cov` is green
- [ ] `plans/README.md` status row for 026 updated (with the decision/status)

## STOP conditions

- The routing decision turns out to need an owner call (e.g. someone ratifies
  0037 or 0039 mid-flight with a conflicting shape) — deliver the design and STOP.
  (As of planning, both are Proposed, so you have latitude.)
- `shadcn add` can't be delegated to cleanly in a Lesto app tree — record it as
  the headline open question.

## Maintenance notes

- Keep the wrapper thin (ADR 0037's explicit intent) — do not re-implement the
  shadcn registry.
- Reviewer should confirm the command name no longer has two conflicting owners.
