# DX parity round 2 — Dev loop: HMR + React Fast Refresh

**Origin:** the highest-priority Tier-1 gap left from the DX-parity round 2 sweep
(`L-9cc30811`). `lesto dev` today is a **full-page reload** on every JS edit: the
injected client sees a non-error WebSocket frame and calls `location.reload()`
(`packages/cli/src/dev-overlay.ts:18`), so every component edit destroys in-page
state — scroll, form input, open menus, an island's `useState`. Astro, Next
(Turbopack), and every Vite-based stack preserve state sub-second. This is the one
thing in the dev loop that still "feels a generation old."

This is a **design pass**, per the task. It does not write the implementation; it
picks the path, scopes the first buildable increment, and names the decisions an
owner must sign off before code starts. Nothing here ships until the bar below is met.

## The bar (non-negotiable, every commit of the eventual build)

- TypeScript, ESM, Bun. `oxlint`/`oxfmt` clean. **100% vitest coverage per touched
  package.** Coded errors. `bun run ws:typecheck` + the serial coverage gate green
  before a commit on `main`.
- **No dev/prod divergence that lies.** Whatever bundles islands in dev must produce
  output that hydrates identically to what `lesto build` ships, or the difference is
  documented exactly. A "works in dev, breaks built" gap is worse than a slow reload.
- The **edge Worker static-import map** (`routes.gen.ts`, the prod artifact the
  Worker imports because the edge has no request-time fs) stays a **separate concern
  from the Node dev path**. No dev-server machinery may leak into it (Workstream 3
  note in `docs/plans/dx-parity.md`).

---

## What "HMR" means here — scope it precisely first

Lesto renders **pages on the server** (React/Preact SSR) and ships **islands** as the
only client-interactive React (ADR 0011). So "preserve state on edit" splits cleanly:

- **Islands** (`app/islands/*`) — the ONLY place client component state lives. This is
  where **React Fast Refresh** is the real win: re-mount the edited island's module,
  keep its `useState`/`useReducer`. **This is the headline deliverable.**
- **Pages/layouts** (`app/routes/*`) — server-rendered; their "state" is server state.
  Their fast-path is a **server re-render + partial DOM swap** (the `data-lesto-layout`
  partial-swap machinery already scoped in DX-parity R1), NOT React Fast Refresh. A
  page edit can't lose client component state because there is none to lose; it only
  needs to avoid a jarring full reload.
- **CSS** — **already solved** and the proof the channel can do better than reload:
  a `{type:"style-update"}` frame swaps `<link href="/styles.css">` in place with a
  cache-busted href and never reloads (`dev-overlay.ts:15`). The island story is the
  same shape one layer up: targeted update, no reload.

So the task is really two moves: **(1) Fast Refresh for islands** (the hard, valuable
part) and **(2) demote the page/route reload to a partial swap** (cheaper, reuses R1).

## What exists to build on (grounded)

- **Per-island code splitting already ships.** `Bun.build({ entrypoints:[entry],
  splitting:true })` (`packages/assets/src/bun.ts:73`) emits a shared entry + a chunk
  per island (ADR 0009). A targeted re-import of one island's chunk is therefore
  already a meaningful unit — the bundler boundary HMR needs exists.
- **A live-reload transport already ships.** A Bun WebSocket server on a fixed port
  (`bin.ts:520`, `buildLiveReload`) with a typed message protocol (`error` →
  overlay, `style-update` → swap, else → reload) and a covered client renderer
  (`dev-overlay.ts`). Adding an `hmr` message type is additive.
- **Watchers already ship.** `watchIslands` (`bin.ts:498`) and `watchStyleSources`
  (`:503`) debounce-fire rebuilds today; the island watcher already knows exactly
  which tree changed.

The two missing pieces are the **Fast Refresh transform** (wrap each island module so
React can swap it preserving state) and the **client HMR runtime** (re-import the
changed chunk and call `performReactRefresh()` instead of `location.reload()`).

---

## The fork

### Option A — Full Vite 8 / Rolldown dev server (the attack-plan destination)

`docs/ATTACK-PLAN-2026.md` Bet III already commits to this: *"Replace `bun build`
with Vite 8 / Rolldown … HMR; one pipeline … Model server/client/edge as Vite
Environments + `ModuleRunner` for true dev/prod parity, retiring the bespoke dev
dispatcher."* Fast Refresh comes from `@vitejs/plugin-react` (or `@prefresh/vite`
for the Preact dialect) — mature, correct, not ours to maintain.

- **Pro:** the real destination; one pipeline; dev/prod parity; `content-vite` (already
  a Vite plugin) runs unchanged; we stop maintaining a bespoke dev path the attack
  plan says to delete.
- **Con:** large — Environment API is RC at Vite 8 (budget churn); retiring
  `dispatchSitesDev` and reconciling the edge static-import map is an epic, not one
  task. Doing it all at once is high-risk.

### Option B — Bespoke React Fast Refresh over the existing WebSocket

Keep `Bun.build`; add a Bun plugin that applies the `react-refresh/babel` transform to
island modules in dev, ship `react-refresh/runtime` in the dev entry, and on an island
edit rebuild that chunk, push `{type:"hmr", island, url}`, and have the client
re-import the chunk + `performReactRefresh()`.

- **Pro:** self-contained; no Vite; ships in one or two increments; reuses the per-island
  splitting and the existing transport verbatim.
- **Con:** **throwaway.** The attack plan explicitly says *don't rebuild dev infra* —
  every line of bespoke Fast-Refresh-over-Bun is deleted the moment we adopt Vite.
  Hand-rolling Fast Refresh boundary/registration semantics is precisely the subtle,
  bug-prone work Vite's plugin already gets right.

---

## Recommendation — Vite-first, phased; bespoke only as a documented fallback

**Do not build bespoke Bun-HMR as the destination.** Make the Fast-Refresh win the
**first concrete slice of Bet III**, introduced behind the CLI's existing seams so the
initial blast radius is the dev server only:

- **Phase 1 (this task's buildable increment): Vite dev server for islands + React
  Fast Refresh.** The CLI `dev` path runs Vite in middleware mode over the island
  module graph with `@vitejs/plugin-react` (Fast Refresh), wired behind the existing
  `buildClientAssets`/`watchIslands`/`liveReload` seams. **`lesto build` keeps
  `Bun.build`** for now (prod unchanged) — so the edge static-import map and the
  shipped bundle are untouched. Pages still re-render server-side; demote their reload
  to the R1 partial swap as the cheap second half.
- **Phase 2: Vite/Rolldown production build.** Replace `bun build client` so dev and
  prod share one bundler — closing the dev/prod-bundler mismatch Phase 1 knowingly
  opens. After this, retire any Phase-1 shims.
- **Phase 3: Vite Environments + `ModuleRunner`** for server/client/edge parity,
  retiring `dispatchSitesDev`. Gated on Environment API stability (RC today).

**Bespoke Fast Refresh (Option B) is the fallback** if standing up Vite-in-dev proves
too large for the first increment — and if taken, it ships **explicitly labelled
throwaway**, deleted at Phase 2. We do not silently keep two bundlers.

## Open decisions for the owner (before code)

1. **Phase-1 dev/prod bundler mismatch — accept or avoid?** Phase 1 alone means Vite
   in dev, Bun in prod — a real parity hazard (chunking, splitting, `define` inlining,
   and "compiles in dev, breaks built" can all diverge). Note this is NOT the industry
   norm to be sanguine about: Astro runs Vite in **both** dev and prod, and Next uses
   one toolchain end-to-end — neither carries this split. The alternative is doing
   Phase 1+2 together (one bundler in dev AND prod; a bigger but mismatch-free
   increment). **Recommendation: prefer Phase 1+2 together** so dev and prod share one
   bundler from the start; fall back to Phase-1-only (Vite dev, Bun prod) ONLY if the
   combined increment proves too large, and then gate it on a build-vs-dev parity smoke
   test and close the gap in Phase 2 immediately.
2. **Dialect (ADR 0008).** Fast Refresh differs by matched pair: `@vitejs/plugin-react`
   for `react`, `@prefresh/vite` for `preact`. The dev plugin must be selected from the
   same single `ui.dialect` key that picks the client alias + server renderer — the
   matched-pair invariant must hold in dev too.
3. **Transport ownership.** Keep the existing Bun WS (error overlay + style-update +
   page partial-swap) and let Vite own only island HMR? Or let Vite's HMR client
   subsume the channel? **Recommendation: keep our WS for server-driven signals
   (overlay, page swap, CSS) and let Vite own island module HMR** — least disruption,
   preserves the covered overlay/`notifyError` path.
4. **Coverage of the dev server.** Vite middleware wiring lands in `bin.ts` (already
   coverage-excluded as thin wiring), with the decision logic in covered `run.ts`
   seams — same split as `buildClientAssets`/`resolvePublicEnvDefine` today.

## Non-goals (this round)

- Retiring `dispatchSitesDev` / full Environment API adoption (Phase 3, separate epic).
- `@vitejs/plugin-rsc` streaming server-component islands (attack-plan "later").
- Any change to the edge Worker's `routes.gen.ts` static-import map.

## Next step

This doc unblocks the **build task**. Recommend filing it as its own Studio task
(blocked-by this design), scoped — per open decision 1 — to **Phases 1+2 together**:
Vite/Rolldown as the island bundler in BOTH dev (middleware server + Fast Refresh
behind the existing seams) and prod (`lesto build`), plus page-reload → partial-swap,
keeping the edge Worker static-import map untouched. Drop to Phase-1-only (Vite dev,
Bun prod) only if that combined increment proves too large. Phase 3 (Environments /
`ModuleRunner`, retiring `dispatchSitesDev`) is a follow-on task under the Bet III epic.
