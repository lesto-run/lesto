# ADR 0011 — Optimized-by-default ("pit of success") pipeline

- **Status:** Accepted — **Increments 1 and 2 BUILT** (updated 2026-06-16, Wave 5 `ui-client#6`/`#7`).
  - **Increment 1 — the wire, proven end-to-end.** `defineIsland`/`hydrateDocumentIslands` ship; `render-page.tsx` emits the `<head>` client module tag (config-driven via `volo().client(...)`, per the 2026-06-11 amendment below); `@volo/assets` synthesizes the client entry from the `app/islands/` convention; `examples/blog` ships a live `ssr: true` data-bound island on `/posts` (the canonical-island proof, ADR 0012). The remainder-of-Increment-1 + the review bug list + ADR 0012's inversion landed as `docs/plans/island-data-hardening.md`.
  - **Increment 2 — estate convergence (the regression gate) DONE.** estate authors all three islands (`Account`, `LiveListing`, `DeferredPanel`) as one-`defineIsland`-per-file modules under `examples/estate/app/islands/`, the same convention `@volo/assets` synthesizes — so its client entry is the canonical synthesized shape, not a bespoke hand-list. The two island PATHS are converged: the `.page`/`defineIsland`/`hydrateDocumentIslands` path is CANONICAL; the Registry/`UiNode`/`renderPage`/`hydrateIslands`-array path is DEMOTED to the AI-/DB-content niche (its sole proof is the `@volo/e2e` fixture). Both emit the byte-identical `IslandMount` through the one shared `islandMount` author, so the island invariants live in exactly one emission site. `Registry.defineClient` typing is resolved by DECISION (it stays erased on purpose — the typed authoring path is `defineIsland`'s `IslandDef<P, D>`).
  - **Diagnostics (`ui-client#7`):** `RenderError` carries the thrown error (`detail`/`cause`) on `render_threw` and surfaces `validateProps` failures as `invalid_props`; `@volo/assets` refuses a malformed `app/islands/` module (`ASSETS_BAD_ISLAND_MODULE`) and a blown gzip budget (`ASSETS_BUDGET_EXCEEDED`), narrating per-artifact gzip sizes; the Registry warns on cross-namespace shadowing.
  - **Remaining:** Increment 3 (scaffold flip — `create-volo` emits `app/islands/` + `ui:{dialect:"preact"}`) and Increment 4 (dev tree-lint + compat-risk check; the rest of Increment 4 — inline-data tier, content-hashed entry, size heuristic, dialect-pair errors — already landed across `island-data-hardening` + `ui-client#7`).
- **Date:** 2026-06-11 (status refreshed 2026-06-16)
- **Context:** over this session `examples/estate` was hand-tuned to a near-perfect Lighthouse — a Preact client (~11 KB vs React's ~118 KB), per-island code-splitting, island data via a parse-time primer (ADR 0010, no waterfall), minified/prod bundles, deferred non-blocking scripts, correct `<head>` + a `<main>` landmark. But it got all of it from **six bespoke estate-owned files** (`build-client.ts`, `build.ts`, `dev.ts`, `src/document.ts`, `src/production.ts`, `worker.ts`). A *new* Volo app — the `create-volo` scaffold, or the canonical `volo() + .page` path (`examples/blog`) — gets **none of it**. The framework has the *capabilities* (in `@volo/ui`) but not the *defaults*.
- **Relates to:** ADR 0007 (preact alias), 0008 (pluggable server renderer), 0009 (per-island code-splitting), 0010 (island data sources). This ADR makes their wins the *default composition*, not opt-in per-app wiring. It is the framework-level realization of the "assets substrate" bet in `docs/ATTACK-PLAN-2026.md`.
- **Informed by:** two independent Fable advisors — one designing the pipeline architecture, one (the skeptic) ruling the default-vs-opt-in matrix. Their reframe (below) is the load-bearing idea.

## The reframe

**"Pit of success" is NOT "optimize everything by default."** It is:

1. **Safe *mechanism* defaults** baked in once, for everyone, with no escape hatch needed — because they preserve meaning (minify, the document shell, the data primer, `modulepreload` hints).
2. **Each *meaning* the author alone can know** reduced to **one cheap, visible line** — and the framework **shouts when that line is a lie** (a dev warning / build error / lint), never silently guesses.

estate's score came from **correct per-case decisions** — including the decision to *un-split* its island (ADR 0009) — not maximal optimization. The framework's job is to make each decision one cheap line and to make the wrong one loud. Four hard rules keep this a pit of success and not a "pit of magic":

- **Defaults may choose *mechanisms*, never *meanings*.** Topology-derived data delivery (ADR 0010) is a fine default — semantics-preserving. The Preact alias changes *which code runs* — a meaning — so it needs a visible declaration.
- **Dev/prod parity is non-negotiable for a default.** Any optimization that manifests only in the production artifact (an alias, an auto-split, a prod-only break) is an ambush. A default must run in dev or it isn't a default.
- **Variance through injected seams, never globals** (the codebase's own best pattern: `ServerRenderer`, `mount`, `observe` are injected). A default expressed as a visible config value is inspectable; one expressed as a resolver plugin the author never sees is not.
- **The wire stays plain data, and the build narrates what it decided** (dialect, per-island sizes, chunks, why-split). That auditability is what lets an author trust the magic.

## Diagnosis

Every optimization exists in `@volo/ui` as an injectable *capability*; the gap is **composition** — it lives in estate's six files, so the framework knows *how* but no framework path *does*. The fix is to own three seams.

## Decision — three framework-owned seams

### Seam 1 — Document emission: islands through pages, self-describing (the Phase-4 unblock)

`render-page.tsx` hard-codes `islands: []` because a `.page` is a plain React tree with nothing to walk (the Registry/`UiNode` walk is the DB-content path and stays there). Don't bolt a walk on — make islands **self-describing at render time**.

A new `defineIsland(def)` in `@volo/ui` wraps a `ClientComponentDef` and returns a React component usable directly in any `.page`/layout JSX (`<AccountIsland />`). When server-rendered it emits, **co-located in the stream**:

1. the marked shell — `<div data-volo-island={id}>` holding the fallback (deferred) or the real output (`ssr: true`), exactly `buildIsland`'s contract, `id` from `useId()`;
2. an adjacent `<script type="application/json" data-volo-island-mount>` carrying *its own* `IslandMount` JSON (through the existing `serializeManifest` escaping — one mount-script per island, not one page-wide array);
3. for each bound data source, a guarded inline primer (`w[name] ||= fetch(href,…)`) — idempotent, so duplication across concurrent `<Suspense>` boundaries is harmless. *(Correction 2026-06-11: `defineIsland` shipped this primer **unguarded** and without a `response.ok` check — `dataPrimerScript` emitted `w[name]=fetch(...)`, violating this very spec. Fixed in the island-data-hardening plan, items 2–3.)*

**Why co-located beats estate's single `#volo-islands` array:** it is **streaming-safe by construction**. A mount inside a late `<Suspense>` boundary flushes with its own markup; there is no "emit the manifest after the body" ordering problem, and a primer fires the instant the parser reaches its island. (Astro's `<astro-island>` proves this wire shape at scale.)

The document chrome (`renderPageResponse`, which already owns charset/viewport/metadata/`<html lang>`) gains one thing: when the page rendered **any** island, emit `<script type="module" src="/client.js">` **in `<head>`** — a head module downloads immediately and executes *after* the full parse, so every co-located mount-script is present when the runtime runs. Strictly better than estate's end-of-body tag and than React's `bootstrapModules` (which injects `async`, racing the stream). No MutationObserver needed.

*(Amendment 2026-06-11: "when the page rendered any island" is unimplementable under streaming — the `<head>` flushes before the body renders, so island presence cannot gate a head tag retroactively. The decision: the tag is **config-driven** — `volo().client("/client.js")` declares the app's client module once, and every `.page` response emits the head tag when it is set. An island-less page on a client-configured app pays one cached, deferred module fetch; the alternative — buffering the body to detect islands — would forfeit streaming. The visible one-line declaration also fits the "meanings are declared" rule: shipping a client runtime is an app-level fact, not a per-page guess.)*

`@volo/ui/client` gains `hydrateDocumentIslands(registry)`: scan `script[data-volo-island-mount]`, parse each, feed the existing `hydrateIslands` machinery (binds, strategies, mount resilience — all unchanged).

### Seam 2 — Client bundling: a new `@volo/assets` package

Absorbs estate's `build-client.ts` wholesale (it is framework infrastructure masquerading as an app file), including the **preact alias plugin and both `react-dom` shims**:

- `buildClient({ projectRoot, outDir, mode, dialect })` — `Bun.build`, `splitting: true`, `--minify` + `NODE_ENV=production` in prod, stale `chunk-*.js` sweep, the alias plugin when `dialect: "preact"`.
- `synthesizeEntry(islandsDir)` — generates the client entry estate hand-writes as `client.tsx`, from a **one-island-per-file `app/islands/` convention**: import each island module, read its def, emit a **static import for an eager island** (bytes inline) and a **`load: () => import(...)` for a `hydrate:"visible"` island** (its own chunk). The author never writes `load:`; the framework decides bytes from the declaration (ADR 0009's rule, mechanized).

**Dialect is one config key, not four flags.** `volo.config` grows `ui: { dialect: "preact" | "react" }` that atomically drives the client alias, the server `ServerRenderer`, the wrangler alias, and the dev server — so the matched pair (ADR 0008) is one decision, and the half-configured mismatch is unrepresentable. `volo dev` runs the configured dialect, so **dev == prod** (closing the divergence estate has today).

### Seam 3 — The CLI owns the loop

`volo build` runs `buildClient` (prod) into each static site's out dir when `app/islands/` exists; `volo dev` runs it unminified on boot + a debounced watcher; `volo deploy` composes `build`. estate's `build.ts`/`dev.ts`/`production.ts` *become* these commands.

## The default-vs-opt-in matrix

| Optimization | Ruling |
|---|---|
| Minify + `NODE_ENV=production`, mount resilience, stale-chunk sweep, ADR 0010 data primer, the document shell | **Safe default** — semantics-preserving |
| `modulepreload` for the eager chunk chain | **Safe default** (currently missing) — kills the discovery hop without killing the cache; the cache-preserving answer to the residual "network dependency tree" insight (never inline `client.js`) |
| Dev-time **tree-lint** (missing `<main>`, skipped heading, CLS-risk fallback) | **Safe default** — Volo renders walkable `UiNode`/island JSON, so structure is *mechanically auditable* — a check no React framework can do |
| **Preact runtime** | **Opt-in for existing apps; scaffold-default-with-hatch on the bundled target.** One visible `ui:{dialect}` key, flipped atomically, **only where dev==prod**. Never an ambient global flip — the failure mode (`react-aria`/Radix break under `compat`, React-19 resource-hint shims no-op) is silent and prod-only. Discovery aids: dev runs the same dialect; an install-time compat-risk package check; the `onRecoverableError`/`onMountError` sinks promoted to a dev overlay. |
| **Per-island code-splitting** | **Declaration-driven default + build advisor.** `visible`/lazy → split; eager/`ssr:true` → inline. The framework also fixes the shared-runtime-chunk hop (ADR 0009) via the `modulepreload` it now owns. A build size report shouts "Island X: 87 KB eager — consider `load:`." Never "always split." |
| Inline `client.js` into HTML | **Trap — not a default.** Re-sends the bundle every pageview, welds cacheable to uncacheable, weakens CSP. Narrow opt-in at most. |
| `ssr: true` | **Opt-in as a declaration, forever** — an author *promise* the framework can't fully verify, so the boolean never flips silently. *(Amended by ADR 0012:)* it is now also the **canonical recommendation** — for an eager island with `data` on a dynamically rendered page, the framework resolves the loaders at render and feeds the *identical* resolved props to the server render and the client hydrate, shrinking the promise to "the component is a pure function of its props" — which the data-source design already enforces structurally. The tax is removed; the line stays visible. Loud-when-wrong: a dev double-render diff (future); recoverable-mismatch overlay. |
| Per-user vs shared data scope | **Opt-in declaration, private-by-default.** **Adopted (2026-06-11):** `scope: "private" \| "shared"` on `defineDataSource`, default private; the auto-route emits `Cache-Control: private, no-store` (private) / `public, max-age=0, must-revalidate` (shared) — see ADR 0010 §3a. **Refuse** (not warn) to inline a private source into a shared-cacheable document; lint a loader returning a session spread (ADR 0010 §5). |
| `hydrate:"visible"` / semantic `<main>`/headings | **Opt-in authoring** (meaning), made cheap by the vocabulary + loud by the build advisor / tree-lint. |

## Sequencing

1. **Increment 1 — the wire, proven on blog (this ADR's build). ✅ BUILT.** `defineIsland` + co-located emission + head module tag in `render-page.tsx` + `hydrateDocumentIslands` + a first-cut `@volo/assets.buildClient` + `volo build`/`dev` hooks. **Exit met:** blog's `/posts` ships a live data-bound island with ~~primer-delivered~~ **inline** data (*amended by ADR 0012: blog's `/posts` is dynamically rendered, so the proof demonstrates the canonical 0-RTT tier — `ssr: true` + render-time-resolved data; the primer remains proven by estate's static zone*) and a ~10 KB client, written as `volo()+.page` + one island file — **zero bespoke scripts**. The wire is the constraining design (document emission, client runtime, and entry synthesis all hang off how a mount reaches the browser), so it lands first and on the *canonical* app, not the hand-tuned one.
2. **Increment 2 — estate convergence (the regression gate). ✅ DONE (Wave 5 `ui-client#6`).** estate's islands move to the canonical one-`defineIsland`-per-file `examples/estate/app/islands/` convention (`Account`/`LiveListing`/`DeferredPanel`), so its client entry is the framework's synthesized shape rather than a bespoke island hand-list; the `src/ui/*-island` modules become thin compatibility re-exports. estate keeps its bespoke WORKER on purpose (the whole-process Preact alias + `preactServerRenderer`, ADR 0008) — convergence is of the island AUTHORING/emission, not the deploy harness; estate's hand-tuned `document.ts` was already retired into the shared `render-page` chrome in a prior wave. The two island paths now converge onto one emission author (`islandMount`); estate's Lighthouse/hydration posture holds (its island tests are green).
3. **Increment 3 — scaffold flip.** `create-volo` emits `app/islands/` + a data-bound island + `ui:{dialect:"preact"}`. Every new app is born optimized.
4. **Increment 4 — hardening.** ~~Dynamic-render inline data tier (ADR 0010 tier 1)~~ — **pulled forward** into Increment 1 by ADR 0012 (the inline tier is the canonical island, so it ships with the blog proof, not after it); content-hashed `client.<hash>.js` + asset manifest + `modulepreload`; the build-time size heuristic; dialect-pair enforcement errors per target; the dev tree-lint and compat-risk check.

## Consequences

- **Additive and byte-stable.** `defineIsland` is a new authoring path alongside `island()` + the Registry; the co-located mount-script is a new wire form that coexists with estate's single-manifest path until estate migrates (Increment 2). Nothing existing breaks.
- **A new convention** (`app/islands/`, one island per file) is load-bearing for entry synthesis — convention over config, Astro-shaped. Documented, not magic.
- **The Phase-4 "islands through pages" gap closes** for the data/island path as a side effect of Seam 1.
- **What stays the author's** is exactly the *what* (which islands, which data is per-user, the `ssr:true` promise, the semantic structure), never the *how* — and each is one cheap line the framework audits.
