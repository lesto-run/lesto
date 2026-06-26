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

---

## Phase 1 build — as built (2026-06-24, `L-9cc30811`)

**Owner decision (open decision 1):** **Phase-1-only.** Vite is the island bundler in
**dev only**; `lesto build` keeps `Bun.build`. The dev/prod bundler mismatch is
accepted and documented (see "Divergence + parity gate" below) rather than closed now;
Phase 2 (Vite prod build) closes it next. This is the narrower, lower-blast-radius
slice the task brief names.

### Package: `@lesto/island-dev` (new, optional peer of `@lesto/cli`)

Mirrors the `@lesto/styles` precedent exactly — heavy third-party tooling (here Vite +
the Fast-Refresh plugin) wrapped behind a pure seam, declared an **optional**
`peerDependency` of the CLI, lazy-imported ONLY for `lesto dev`. A default scaffold
that does not install it gets today's behaviour unchanged (Bun dev build + reload). An
app opts into Fast Refresh by installing `@lesto/island-dev`.

- **Covered (pure / fake-Vite orchestration):** `isViteOwnedPath` (the dispatch
  branch predicate — a single `startsWith(VITE_BASE)`), `dialectPluginSpec` (the
  ADR-0008 matched pair: `react` → `@vitejs/plugin-react`, `preact` → `@prefresh/vite`),
  `devEntrySource` (reuses `@lesto/assets` `synthesizeEntry` with `beacon.dev`),
  `viteIslandConfig` (the pure narrow-config builder), `viteQuery`/`proxyHeaders` (the
  pure pieces of the proxy), and `createIslandDevServer` (orchestration over an injected
  Vite factory). These are package-INTERNAL (the barrel exports only
  `createIslandDevServer` + `viteIslandDevDeps` + their types + the error).
- **Excluded (irreducible IO edge, the `bun.ts`/`tailwind.ts` twin):** `vite.ts` —
  the real `createServer(...)` + `server.listen()` on a loopback port, the dialect-plugin
  import, the virtual-entry plugin, and the `fetch`-proxy that forwards a Vite-owned
  request to that server.

### Integration shape (same-origin, app surface untouched)

The keystone constraint — *no dev-server machinery leaks into the app/request path* —
is honoured: the app's rendered HTML is **unchanged** (it still emits
`<script type="module" src="/client.js">`). Vite listens on its OWN internal loopback
port; the CLI dev path gains exactly two seams that adapt it to the runtime's
transport-free `handle(method, path) → LestoResponse` string contract (which is *why*
a proxy, not Vite's Connect `middlewares` — the runtime never exposes the raw socket
the Connect stack needs):

1. **Dispatch branch.** A request whose path `islandDev.ownsPath(p)` — `startsWith`
   the dedicated Vite base `"/@lesto-dev/"` — is `fetch`-PROXIED to the internal Vite
   server (server-side, so the browser only ever talks to the app's own origin);
   everything else routes to the app exactly as before. The base is dedicated and
   collision-proof: island modules live INSIDE the project root, so Vite serves them at
   **root-relative** URLs (NOT `/@fs/`), and only a dedicated base keeps that whole set
   ownable by one prefix without shadowing app routes. A virtual-module plugin maps the
   base-stripped `/client.js` to the synthesized dev entry.
2. **HTML transform.** Dev `text/html` responses pass through
   `vite.transformIndexHtml`, which injects the Vite client + the plugin's React-refresh
   **preamble** AND base-prefixes the app's existing `<script src="/client.js">` to
   `"/@lesto-dev/client.js"` — so the app's HTML needs no manual rewrite and the browser
   only ever requests `"/@lesto-dev/…"` URLs. This composes with the existing
   `withLiveReload` script injection (the streamed document is buffered to a string first,
   a documented dev-only cost). The body is proxied as raw BYTES so binary modules/assets
   aren't corrupted.

When `islandDev` is active, the CLI **skips** the Bun dev `buildClientAssets` and the
`watchIslands` rebuild — Vite owns the island module graph, its file watch, and HMR. A
Vite startup failure (a bound port) falls back to the Bun path with a logged note, never
crashing the dev boot. The existing Bun WebSocket stays for server-driven signals (error
overlay, CSS `style-update`, route partial-swap); Vite owns island module HMR on its own
dedicated HMR-WS port. (Open decision 3, "keep our WS, Vite owns island HMR" — taken.)

### Divergence + parity gate (open decision 1's required guard)

Phase 1 ships a **real dev/prod bundler mismatch**: islands are served by Vite in dev
and bundled by `Bun.build` in prod. This is the documented hazard, not a silent one.
The guard until Phase 2 closes it: `lesto build` is unchanged and remains the source of
truth for what ships; the dev path is additive and opt-in. A build-vs-dev parity smoke
test (a fixture island that compiles under BOTH bundlers and hydrates identically) is a
tracked follow-up before Vite-dev becomes the scaffold default.

### What this task does NOT do (tracked follow-ups)

- **Page-reload → partial-swap** (the cheaper second half) — deferred; it reuses the R1
  `data-lesto-layout` machinery and is independent of the island Fast-Refresh path.
- **Browser e2e proof** that an island edit preserves `useState` (and that
  `defineIsland`-wrapped default exports are valid Fast-Refresh **boundaries**, not
  reload-propagating modules). Two things ARE verified in-process (`middlewareMode` +
  `transformRequest`, no port bound): the Fast-Refresh **transform** emits the boundary
  footer, and — caught + fixed in wrap-up review — the entry's island import is
  rewritten to a **base-prefixed URL that `isViteOwnedPath` owns** (with `base: "/"` it
  was a root-relative `/app/…` URL the dispatch did NOT own → islands would have 404'd).
  The remaining gaps need a real browser the build sandbox cannot start: the live HMR
  WS round-trip, the cross-port HMR-WS Origin handshake, `optimizeDeps`/`resolve.dedupe`
  for the workspace `@lesto/*` (React de-dup), and the `@prefresh/vite` preact path.
- **Making Vite-dev the scaffold default** — gated on the e2e proof + the parity smoke.
- **Phase 2** (Vite prod build) and **Phase 3** (Environments / `ModuleRunner`).

---

## Phase 2 build — as built (2026-06-25, `L-01f9ba06`)

**Owner decision (open decision 1, now resolved):** the Phase-1 dev/prod bundler
mismatch is **closed for the default path.** `lesto build` now bundles islands with
**Vite/Rolldown**, the SAME bundler the `lesto dev` island server (`@lesto/island-dev`,
the scaffold default since `L-8d9c732a`) already serves them through — so dev and prod
share ONE bundler. `Bun.build` is retained ONLY as the dev FALLBACK for an app that opts
OUT of the island-dev Vite server (`bunBuildClientDeps`, `lesto dev`'s non-island-dev
path); it ships no `lesto build` artifact anymore.

### Where it lives: `@lesto/assets`, beside the Bun edge (NOT `@lesto/island-dev`)

The prod build is the direct sibling of `bunBuildClientDeps` — a new
**coverage-excluded** edge `packages/assets/src/vite-build.ts` exporting
`viteBuildClientDeps(appRoot)`, the same `BuildClientDeps` contract feeding the same pure,
bundler-agnostic `buildClient` orchestration (the stale-chunk sweep, the budget, the
dialect/SSR refusal — all unchanged). Only the `bundle` step is Vite's; island discovery
and every filesystem/gzip seam are reused VERBATIM from `bunBuildClientDeps`. It lives in
`@lesto/assets` (gaining a plain `vite` dep), NOT in `@lesto/island-dev`, because the PROD
build needs **only `vite`** — no Fast-Refresh plugin — so it must not drag the dev-only
`@vitejs/plugin-react` / `@prefresh/vite` peers into every `lesto build`. The CLI
`buildClientAssets` (`bin.ts`) selects the backend by MODE: `production` → Vite, `dev`
(fallback) → Bun.

### Parity reconciled (chunking / splitting / define / minify / dialect)

- **Chunk naming** — `output.chunkFileNames: "chunk-[hash].js"` + `hashCharacters: "hex"`
  so a lazy island's split is `chunk-<hex>.js`, matching `isChunkFile`
  (`/^chunk-[A-Za-z0-9]+\.js$/`) so the generation marker + stale-sweep track it. (Rollup's
  base64url default emits `-`/`_`, which that predicate rejects.)
- **Splitting** — a `hydrate: "visible"` island's dynamic `import()` becomes its own chunk
  automatically (ADR 0009), referenced from the entry by a RELATIVE `import("./chunk-x.js")`
  via `base: "./"` — resolving beside `/client.js` exactly as Bun's relative chunk imports.
- **define** — `mode: production|development` drives `process.env.NODE_ENV` (the React/Preact
  dead-code path); the verified PUBLIC_* inject map rides `define` verbatim.
- **minify** — `build.minify` gated on production, as Bun's.
- **dialect (ADR 0008)** — the preact dialect applies `PREACT_ALIAS` as `resolve.alias`
  (the Vite twin of Bun's `preactAliasPlugin`) + `dedupe` to force one runtime copy.
- **Artifacts** — `build({ write: false })`; the orchestration owns the write-then-sweep on
  disk (so a crash never strands a half-swept out dir).
- **`MISSING_EXPORT` leniency (Bun parity)** — a custom `onwarn` downgrades Rollup's
  namespace-member missing-export warning (`ns.missing` → `undefined` at runtime, which Bun
  bundles the same lenient way) back to a non-fatal warning that Vite otherwise escalates.
  The contained live case is `@lesto/ui`'s `React.use` under the preact dialect
  (`preact/compat` exports no `use`; only ever CALLED server-side — `define-island.tsx`). A
  genuine missing NAMED import stays a hard Rollup ERROR.

### Verified (real `lesto build`, no port needed — runnable in the build sandbox)

`examples/island-fast-refresh` (preact dialect) builds clean: no `react-dom/server` leaked,
`@lesto/ui` bundled inline, entry 15.6 KB gzip (vs Bun's 15.2 KB — a +0.4 KB cost of the
swap). A lazy island emits `chunk-<hex>.js` + records it in `.lesto-chunks.json` +
dynamic-imports it relatively. The `react` dialect builds at 64.0 KB gzip (vs Bun 63.2 KB).
100% coverage held on `@lesto/assets` + `@lesto/cli`; `ws:typecheck` green.

### What this task does NOT do (tracked follow-ups)

- **The `bundle-size` CI gate still measures the Bun bundle** (`scripts/bundle-size.ts`),
  i.e. the dev FALLBACK — not the Vite bundle prod now ships. It should measure Vite, but
  switching it is **blocked on a pre-existing preact budget creep**: the preact entry is
  already 15.2 KB gzip under Bun (over the 15.0 KB budget — main is at/over the edge
  already), and Vite is +0.4 KB, so the gate would harden the wrong way until the runtime is
  trimmed. File: trim the preact island runtime under 15 KB, then point the gate at Vite.
- **Prod-Vite browser e2e** — `lesto serve` does not serve `out/` (prod static is the
  Worker/CDN's job), so a built browser leg isn't reachable via the CLI; the existing
  Bun-dev-vs-Vite-dev parity smoke (`L-56f79043`) is unaffected and still holds.
- **Phase 3** (Vite Environments / `ModuleRunner`, retiring `dispatchSitesDev`).
