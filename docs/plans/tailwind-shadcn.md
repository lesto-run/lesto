# First-class Tailwind v4 + shadcn/ui — implementation plan

Derived from **ADR 0037**. The committed build-now is **Phase 1**: a Tailwind v4 CSS build
step — a new `@lesto/styles` package whose pure `buildStyles(options, deps)` orchestrates
over an injected `StyleCompiler` seam (the real `@tailwindcss/node` + `@tailwindcss/oxide`
wiring isolated in a coverage-excluded edge, exactly as `@lesto/assets`'s `bun.ts` isolates
`Bun.build`), wired into the CLI's `build` + `dev` flows with a live-reload CSS hot-swap,
auto-injected at render, gated by a `ui.css` config key, and scaffolded into new apps.
**Phase 2** (shadcn compatibility — scaffold a Lesto app as a *generic* shadcn project +
a thin island-wrapping `lesto add`) is gated on Phase 1's pipeline existing. **Phase 3**
(ship `@lesto` as a hosted shadcn registry + pre-wire the shadcn MCP) is gated on Phase 2.
**Phase 4** (DTCG/Figma token bridge; `--monorepo` scaffold) is **deferred** — recorded, not
scheduled. Build in order; commit Phase 1 increments now.

**Packages:** `@lesto/styles` (**new** — the pure `buildStyles` + `StyleCompiler` seam, the
only fully-100%-gated surface here, plus the coverage-excluded `tailwind.ts` engine edge);
`@lesto/cli` (**modified** — `ui.css` resolution, the `buildStyles` call in `build`, the dev
watch broadened past `app/islands/` + the CSS hot-swap on `buildLiveReload`, and Phase 2's
`lesto add`; declares `@lesto/styles` an **optional `peerDependency`**, lazily imported —
mirroring `@lesto/content-core`, `cli/package.json:39-50`); `@lesto/web` (**modified** —
auto-inject the stylesheet `<link>` via the existing `RenderPageOptions` head-tag seam,
`render-page.tsx:237-238`); `@lesto/create-lesto` (**modified** — scaffold the CSS entry,
`components.json`, `cn()`, tsconfig paths, theme CSS, `.mcp.json`, deps); plus a small
`@lesto` registry Worker (Phase 3).

> **The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on
> touched packages (the `@tailwindcss/*` engine edge in `@lesto/styles`'s `tailwind.ts` is
> the `bin`-equivalent, coverage-excluded exactly as `@lesto/assets`'s `bun.ts` is —
> `bun.ts:6-9` — and covered by an integration test that compiles a real fixture);
> `bun run ws:typecheck` + the serial coverage gate (`bun scripts/coverage-gate.ts`) green;
> coded errors (`StylesError`, the `LestoError<Code>` closed-union pattern,
> `packages/queue/src/errors.ts`); truthful doc comments; one conventional single-line commit
> on `main`. Layering invariants, grep-asserted: the Tailwind native engine never enters the
> CLI's **eager** graph — `@tailwindcss/*` appears **only** in `@lesto/styles`'s
> `dependencies`, and `@lesto/cli` reaches it **only** via a lazy `await import("@lesto/styles")`
> guarded by a CSS-entry check, with `@lesto/styles` declared an **optional `peerDependency`**
> (not in `cli/package.json` `dependencies`, no top-level `from "@lesto/styles"`). The CSS
> build is a **standalone filesystem scan**, never a `Bun.build` plugin. `buildStyles` is
> **pure** over the injected `StyleCompiler` — no `@tailwindcss/*` import, no `fs`/`process` in
> the decision path (grep-asserted). shadcn support targets the **`react`** dialect (no preact
> claim).

(Commits are conventional single-line `type(scope): summary` on `main` — **no**
Co-Authored-By / "Generated with Claude" / 🤖 trailer.)

## Increments

### Phase 1 — the Tailwind v4 CSS build (committed)

1. **`@lesto/styles` skeleton + the `StyleCompiler` seam + pure `buildStyles`** — `[keystone]`
   Files: `packages/styles/package.json` (new), `packages/styles/src/index.ts` (new),
   `packages/styles/src/build-styles.ts` (new — `buildStyles` + `BuildStylesOptions` +
   `BuildStylesDeps`/`StyleCompiler`), `packages/styles/src/errors.ts` (new —
   `StylesError extends LestoError<StylesErrorCode>`), `packages/styles/test/…` (new).
   A pure `buildStyles(options, deps)` mirroring `buildClient` (`build-client.ts:212`): read
   the CSS entry via an injected reader → `deps.compiler.compile({ entryCss, resolveBase,
   scanRoot, mode })` → measure gzip via an injected `gzipSize` (the same unit
   `build-client.ts:143` uses) → write `out/styles.css` via an injected `write` → narrate via an
   injected `BuildReport` → enforce an optional `budgetBytes` → `STYLES_BUDGET_EXCEEDED`.
   **The `StyleCompiler.compile` request carries TWO distinct roots** — `scanRoot` (the app
   source, `app/`, where utility classes are scanned) and `resolveBase` (the project root,
   where `@import "tailwindcss"`/`tw-animate-css` resolve from node_modules); conflating them
   breaks `@import` resolution. **`BuildMode` (`"development" | "production"`) and `BuildReport`
   (`(line) => void`) are defined LOCALLY** in `@lesto/styles` — they are trivial enough that
   importing them from `@lesto/assets` would add a `styles → assets` package edge for a 2-member
   union, which is not worth it (the shapes match `build-client.ts:29,77-78` by convention, not
   by import). No `@tailwindcss/*` import here; no disk; the compiler/reader/writer/gzip are all
   seams.
   Acceptance: `buildStyles` is pure (grep-asserted: no `@tailwindcss/*`, no `fs`/`process`
   import in `build-styles.ts`); given a fake compiler returning fixture CSS it writes
   `out/styles.css`, returns the path + gzip size + the dependency list, and narrates one
   report line; a missing entry throws `STYLES_ENTRY_NOT_FOUND`, a compiler throw surfaces as
   `STYLES_COMPILE_FAILED`, an over-budget result throws `STYLES_BUDGET_EXCEEDED`; tests branch
   on the **code**, never the message; 100% coverage.

2. **The real `@tailwindcss/node`+`oxide` `StyleCompiler` (coverage-excluded edge)** — `[order-critical]`
   Files: `packages/styles/src/tailwind.ts` (new — `tailwindStyleCompiler()` returning the
   default `BuildStylesDeps`), `packages/styles/test/tailwind.integration.test.ts` (new — the
   real-fixture compile), `packages/styles/package.json` (pin the **engine**
   `@tailwindcss/node` + `@tailwindcss/oxide` to one exact version in `dependencies`; declare
   `tailwindcss` a **`peerDependency`**), `packages/styles/vitest.config.ts` + the repo
   coverage-gate convention (this file is the `bin`-equivalent, excluded from the serial gate as
   `bun.ts` is).
   Wire `compile()` to `@tailwindcss/node`'s `compile()` (with `base: resolveBase` so
   `@import "tailwindcss"` resolves from the app) + `optimize()` (Lightning CSS minify in
   production) and `@tailwindcss/oxide`'s `Scanner` over `scanRoot`, returning the compiled CSS
   + the dependency paths (from the compiler's `onDependency`) for watch invalidation.
   **`tailwindcss` ownership (ADR 0037 *Decision Phase 1* #2):** the framework owns the
   **engine** (deps), but `tailwindcss` itself is a **peer** resolved from the app (one
   instance; shadcn Phase 2 expects it resolvable in the app, scaffolded in Inc 6 to the same
   4.x train as the engine). **The unstable-API discipline:** the engine versions pinned exact;
   everything behind the `StyleCompiler` interface so a `@tailwindcss/cli` shell-out fallback
   could replace this file with no caller change.
   Acceptance: an integration test compiles a real fixture CSS (`@import "tailwindcss"` + a
   tiny `@theme`) against a fixture `app/` (with `resolveBase` = the fixture root so the import
   resolves) and asserts the output contains the expected utilities + the `:root` token vars and
   reports a non-empty dependency list; the engine `@tailwindcss/*` versions are pinned (exact,
   not ranged) and identical, and `tailwindcss` is declared a peer; `tailwind.ts` is excluded
   from the serial coverage gate (documented like `bun.ts:6-9`); `ws:typecheck` green.

3. **CLI: `ui.css` resolution + the `buildStyles` call in `build`, behind a lazy optional-peer import** — `[committed]`
   Files: `packages/cli/src/bin.ts` (resolve `ui.css`; the `buildStyles` call alongside
   `buildClientAssets`, `bin.ts:378`), `packages/cli/package.json` (declare `@lesto/styles`
   an **optional `peerDependency`** — `peerDependencies` + `peerDependenciesMeta.optional`,
   mirroring `cli/package.json:39-50`).
   Read a new `ui.css` key from `lesto.app.ts` (default convention `app/styles/app.css`); when
   it resolves to an existing file, **lazily `await import("@lesto/styles")`** and run
   `buildStyles({ entry, outDir: "out", scanRoot: "app", mode })` writing `out/styles.css`
   next to `out/client.js`; when absent, skip the CSS build entirely (Tailwind stays opt-in).
   The lazy import keeps the native engine out of the CLI's eager graph. **Stable filename:**
   both modes write `out/styles.css` (a stable name, like `client.js`) — threaded to render as a
   constant (Inc 5), which is what makes it work on the edge (no request-time manifest read).
   **No serving change is needed:** `.css` is already a passthrough asset extension
   (`sites-dev.ts:50`), so `/styles.css` → `out/styles.css` in dev, and prod serves `out/` via
   Workers Assets. (Content-hashing is **out of scope** for Phase 1 — it rides the asset-optim
   epic, which must add the build-time worker-baked asset manifest the edge needs; see ADR 0037.)
   Acceptance: with a CSS entry present, `lesto build`/`dev` writes `out/styles.css` (driven with
   a fake `@lesto/styles`/injected build in test); with **no** CSS entry, no import is attempted
   and no CSS is written; `@lesto/styles` is **absent from `cli/package.json` `dependencies`
   but present as an optional `peerDependency`**, and there is **no top-level
   `from "@lesto/styles"`** (both grep-asserted); 100% on the touched `@lesto/cli` paths.

4. **CLI: broaden the dev watch past `app/islands/` + a CSS hot-swap on the live-reload channel** — `[committed]`
   Files: `packages/cli/src/bin.ts` (the dev watch + `buildLiveReload`, `bin.ts:396,417-433`),
   `packages/cli/src/dev-overlay.ts` or the covered live-reload core (the *when-to-swap*
   decision).
   In `dev`, also rebuild CSS on change. Because Tailwind classes appear in routes,
   components, **and** islands (not just `app/islands/`, which `watchIslands` watches,
   `bin.ts:396`), watch the broader `app/` source set (the compiler's returned `dependencies`
   name the exact files; debounce like the island watcher, `WATCH_DEBOUNCE_MS`,
   `bin.ts:163-164`). On a successful CSS rebuild, push a **`style-update`** message through
   the existing `buildLiveReload` channel (alongside `notify`/`notifyError`, `bin.ts:428-433`)
   that swaps the stylesheet `<link>` in place — **no full reload**, preserving island state;
   the client snippet **cache-busts the swapped href** (`/styles.css?t=<n>`) since the stable
   name is otherwise cached. A CSS compile failure routes through the existing `notifyError`
   overlay. The decision of
   *when* to swap/notify lives in the covered core (the existing reload/overlay split); the
   WebSocket send + the client snippet are the coverage-excluded bin.
   Acceptance: the covered core's `style-update` decision is unit-tested (a successful CSS
   rebuild emits a swap signal; a failure emits an error signal); the injected client snippet
   gains a branch that swaps the `<link>` href on `style-update` without reloading
   (asserted on the covered seam, the dev-overlay test discipline); editing a class in a
   **route or component** (not just an island) triggers a CSS rebuild (asserted on the watch
   seam); 100% on the covered paths.

5. **`@lesto/web`: a `.styles()` builder + auto-inject the `<link>` (mirror the client-module seam)** — `[committed]`
   Files: `packages/web/src/lesto.ts` (add `.styles(src)` → `clientStylesSrc`, threaded as a
   `clientStyles` render option — mirroring `.client(src)` → `clientModuleSrc` → `clientModule`,
   `lesto.ts:350,615`), `packages/web/src/render-page.tsx` (`headElements` emits the `<link>`;
   `RenderPageOptions` gains `clientStyles`, sibling of `clientModule` at
   `render-page.tsx:242-243,373-375`).
   **The injection seam is the `lesto()` builder, not just the renderer** (chief-architect
   correction — the client URL flows `lesto().client("/client.js")` → `clientModuleSrc` →
   `clientModule` option → `<script>`, `lesto.ts:350,615`/`render-page.tsx:373-375`). Add the
   exact sibling: `lesto().styles("/styles.css")` → `clientStylesSrc` → a `clientStyles` option
   → `<link rel="stylesheet">` in `headElements` (`render-page.tsx:202`). The hand-authored
   `metadata.links` path (`render-page.tsx:216`) stays for extra stylesheets. The value is a
   **stable constant** (`/styles.css`) baked into the worker JS exactly like `/client.js` — so
   it works on the edge with no request-time manifest. `@lesto/web` just head-tags whatever it
   is given; it knows no naming policy.
   Acceptance: `.styles("/styles.css")` sets `clientStylesSrc` and threads `clientStyles` into
   the render options (mirroring the `.client()` test); with `clientStyles` set the rendered
   `<head>` contains exactly one framework stylesheet `<link>` (deduped against any
   `metadata.links` entry by `renderMetadata`); with it unset, none is injected; the
   charset/viewport ordering is unchanged (`render-page.tsx:204-205,218-220`); 100% on
   `@lesto/web` touched paths.

6. **Scaffold the CSS entry + `ui.css` wiring + a dogfood example** — `[committed; per gallery-as-QA-gate]`
   Files: `packages/create-lesto/src/templates.ts` (a `styles/app.css` template + the
   `ui.css` line in `lestoApp()` + `@lesto/styles`/`tailwindcss` in `packageJson()`),
   `packages/create-lesto/src/scaffold.ts` (add `app/styles/app.css` to the file list,
   `scaffold.ts:114-129`), an `examples/` app that uses it (the QA gate).
   Scaffold `app/styles/app.css` (Phase 1: just `@import "tailwindcss";` + a starter `@theme`
   — the full shadcn OKLCH block lands in Phase 2 Inc 7), wire `ui: { css: "app/styles/app.css" }`
   in `lesto.app.ts`, **add the `.styles("/styles.css")` call next to the existing
   `.client("/client.js")`** in the scaffolded app/worker config (so the `<link>` is injected,
   Inc 5), and add `@lesto/styles` + `tailwindcss` (**pinned to the same 4.x train as
   `@lesto/styles`'s engine** — the peer it resolves, Inc 2) to the app `package.json`. Ship the
   scanner gotcha in a scaffold comment (static class strings only; `@source inline(...)` for
   dynamic classes). The feature is not done until a scaffolded example **builds locally and
   deploys** with `out/styles.css` present and linked (gallery-as-QA-gate).
   Acceptance: a fresh scaffold contains `app/styles/app.css`, the `ui.css` config, the
   `.styles("/styles.css")` call, and the deps (with `tailwindcss` matching the engine train);
   `lesto build` on it emits `out/styles.css` and the served page links it; the example
   builds + deploys with styling applied; the scaffold manifest test (`scaffold.ts:131-145`)
   asserts the new files; 100% on `@lesto/create-lesto` touched paths.

### Phase 2 — gated on Phase 1: a Lesto app is a generic shadcn project

7. **Scaffold `components.json` + `cn()` + tsconfig paths + the v4 OKLCH theme block + deps** — `[gated on Inc 6]`
   Files: `packages/create-lesto/src/templates.ts` (new `components.json`, `lib/utils.ts`
   `cn()`, the full shadcn v4 theme block replacing the Inc 6 starter `app/styles/app.css`,
   the `tsconfig.json` `paths` addition, and `clsx`/`tailwind-merge`/`tw-animate-css`/
   `lucide-react` in `packageJson()`), `packages/create-lesto/src/scaffold.ts` (add
   `components.json`, `app/lib/utils.ts` to the file list).
   Emit `components.json` (`style: "new-york"`, `tailwind.config: ""`,
   `tailwind.css: "app/styles/app.css"`, `cssVariables: true`, `baseColor: "neutral"`,
   `iconLibrary: "lucide"`, `aliases` → `@/components`, `@/components/ui`, `@/lib/utils`,
   `@/lib`, `@/hooks`); add `"paths": { "@/*": ["./app/*"] }` to the scaffolded
   `tsconfig.json` (app code lives under `app/`, so `@/lib/utils` → `app/lib/utils` and
   `@/components/ui` → `app/components/ui`; a root-level `./*` would resolve `@/lib/utils`
   to a non-existent `./lib/utils` and fail the typecheck-resolves acceptance below);
   replace `app/styles/app.css` with the shadcn v4 block
   (`@import "tailwindcss"; @import "tw-animate-css"; @custom-variant dark (&:is(.dark *));`
   + `@theme inline { … }` + `:root`/`.dark` OKLCH tokens + `@layer base`); write
   `app/lib/utils.ts` with `cn()`; add the deps. Components install **in-app** under
   `app/components/ui` (the decided default).
   Acceptance: a fresh scaffold contains a valid `components.json` (schema-conformant — a test
   asserts the required fields), the `cn()` util, the `@/*` tsconfig path, and the v4 theme
   CSS; `bun run typecheck` resolves `@/lib/utils`; the deps are present; the scaffold manifest
   test asserts the new files; 100% on touched paths.

8. **`lesto add` — delegate to `shadcn add` + island-wrap interactive primitives** — `[gated on Inc 7]`
   Files: `packages/cli/src/add.ts` (new — the `runAdd` core + the client-only primitive set
   + the island-wrap transform), `packages/cli/src/bin.ts` (dispatch `add`),
   `packages/cli/src/errors.ts` (extend the closed `CliErrorCode` union with any `CLI_ADD_*`
   codes *before* the throwing code compiles).
   `runAdd(args, deps)` shells out to `npx shadcn add <names>` (the shell-out is an injected
   seam, tested with a fake), then **post-processes**: for each installed primitive in the
   known client-only set (Dialog, DropdownMenu, Popover, Sheet, Sonner, …), emit a Lesto
   `defineIsland` wrapper **preserving `data-slot`**; static-safe primitives are left as direct
   server-renderable components. Refusals (no `components.json`, shadcn CLI failure) throw a
   coded `CliError`.
   Acceptance: `lesto add button` resolves to `runAdd` and (via a fake shell-out + fake fs)
   installs a static primitive with no island wrapper; `lesto add dialog` produces an island
   wrapper preserving `data-slot`; a missing `components.json` throws a coded `CliError`
   (test branches on the code); the shell-out + fs are injected (no real `npx`, no disk in the
   covered core); 100% on `@lesto/cli` touched paths.

### Phase 3 — gated on Phase 2: the `@lesto` registry + the shadcn MCP

9. **A hosted `@lesto` shadcn registry (a Lesto Worker) — primitives, island-wrapped interactives, a `registry:theme`** — `[gated on Inc 8]`
   Files: a new top-level registry app (e.g. `registry/` — a Lesto Worker serving
   `/r/[name].json`), `registry/registry.json` (`name: "lesto"`), per-component
   `registry-item.json` files (use `cssVars`/`css`, not the deprecated `tailwind` field;
   `registryDependencies` to reuse `@shadcn` primitives; interactive primitives shipped
   pre-wrapped as Lesto islands), a `registry:theme` item carrying the Lesto OKLCH tokens.
   Build with `shadcn build`; serve the flattened JSON from the Worker (dogfooding Lesto's
   routing/assets). Hosting + deploy is the gallery-as-QA-gate: not done until the registry
   Worker deploys and `npx shadcn add @lesto/<item>` resolves against it.
   Acceptance: `shadcn build` produces valid `/r/[name].json`; the Worker serves them and a
   `/r/registry.json` catalog; a test resolves a Lesto item end-to-end (item JSON →
   `registryDependencies` → files with `target`s); the `registry:theme` item's `cssVars` are
   OKLCH and tweakcn/Figma-compatible; the registry deploys (QA gate).

10. **Pre-wire `@lesto` + the shadcn MCP in the scaffold** — `[gated on Inc 9]`
    Files: `packages/create-lesto/src/templates.ts` (add `registries: { "@lesto": "https://lesto.run/r/{name}.json" }`
    to `components.json`; a `.mcp.json` template), `packages/create-lesto/src/scaffold.ts`
    (add `.mcp.json` to the file list).
    Add the `@lesto` namespace to the scaffolded `components.json#registries` and ship
    `.mcp.json` with `{ "mcpServers": { "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] } } }`.
    The shadcn MCP then discovers/installs `@lesto` components with no custom MCP server.
    Acceptance: a fresh scaffold's `components.json` registers `@lesto` and `.mcp.json`
    declares the shadcn MCP server; the scaffold manifest test asserts both; a documented
    smoke test (manual, recorded) confirms the shadcn MCP lists `@lesto` items once the
    registry (Inc 9) is live; 100% on touched scaffold paths.

## Layering invariants (grep-asserted; folded into the bar block)

- The Tailwind native engine never enters `@lesto/cli`'s **eager** graph — `@tailwindcss/*`
  lives **only** in `@lesto/styles`'s `dependencies`; `@lesto/cli` reaches `@lesto/styles`
  **only** via a lazy `await import("@lesto/styles")` guarded by a CSS-entry check, with
  `@lesto/styles` declared an **optional `peerDependency`** (mirroring `@lesto/content-core`,
  `cli/package.json:39-50`). Grep: no `@lesto/styles` in `cli/package.json` `dependencies`,
  no top-level `from "@lesto/styles"` in `@lesto/cli`.
- `buildStyles` is **pure** over the injected `StyleCompiler` — no `@tailwindcss/*` import, no
  `fs`/`process` in the decision path (grep-asserted); the real engine lives only in the
  coverage-excluded `tailwind.ts`.
- The CSS build is a **standalone filesystem scan**, never a `Bun.build` plugin (Tailwind
  scans source as text, not the module graph) — so the dev watch covers **all of `app/`**,
  not just `app/islands/` (`bin.ts:396`).
- The **engine** `@tailwindcss/node`/`@tailwindcss/oxide` are pinned to **one exact, identical
  version** (deps of `@lesto/styles`) and `tailwindcss` is a **peer** (the app's instance);
  everything sits **behind the `StyleCompiler` interface** so a shell-out fallback is swappable
  with no caller change.
- `BuildMode`/`BuildReport` are **defined locally** in `@lesto/styles` — **no** `styles → assets`
  package edge for a 2-member union / trivial fn type (grep: no `from "@lesto/assets"` in
  `@lesto/styles`).
- The CSS is a **stable `/styles.css`** threaded to render as a compile-time constant (like
  `client.js`) — **no** content-hashing in Phase 1 (it needs an edge worker-baked asset
  manifest, owned by the asset-optim epic), and **no** serving change (`.css` is already a
  passthrough asset extension, `sites-dev.ts:50`; prod serves `out/` via Workers Assets).
- shadcn support targets the **`react`** dialect; no code path claims preact-dialect support
  (the matched pair, `build-client.ts:221-250`).
- Generated/scaffolded artifacts are byte-stable; the scaffold manifest test
  (`scaffold.ts:131-145`) asserts every new file.

## Owned elsewhere (do not duplicate)

- **The island-client build pattern** — `@lesto/assets`'s `buildClient`/`BuildClientDeps`
  (`build-client.ts:212,118`), `BuildMode`/`Dialect`/`BuildReport`
  (`build-client.ts:29,26,77-78`), and the coverage-excluded `bun.ts` wiring (`bun.ts:1-10`).
  `@lesto/styles` **mirrors** this shape; `BuildMode`/`BuildReport` are **redefined locally**
  (trivial union / fn type) to avoid a `styles → assets` package edge — the shapes match by
  convention, not by import.
- **The client-asset head-tag seam** — the `lesto()` builder's `.client(src)` → `clientModuleSrc`
  → `clientModule` render option (`lesto.ts:350,615`) + `headElements`'s emission
  (`render-page.tsx:202,373-375`). Inc 5 adds the **sibling `.styles()` → `clientStyles`** the
  same way; it does not open a second injection path.
- **The dev live-reload channel** — the CLI's `buildLiveReload` (`bin.ts:417-433`) with
  `notify`/`notifyError`/the injected client snippet, and the covered reload/overlay decision
  core. Inc 4 **adds a `style-update`** to it; it does not build a second channel.
- **The shadcn CLI + registry + MCP** — `npx shadcn add`/`build`/`mcp` and the registry
  resolution. Inc 8 **delegates** to `shadcn add`; Inc 9 **builds** a registry with
  `shadcn build`; Inc 10 **points** the shadcn MCP at it. We reimplement none of it.
- **The optional-peer + lazy-import discipline** — the `@lesto/content-core`/`@lesto/content-store`
  precedent (`cli/package.json:39-50`). Inc 3 follows it for `@lesto/styles`.
- **Coded errors** — the `LestoError<Code>` closed-union pattern (`packages/queue/src/errors.ts`,
  the reference package). `StylesError`/`CLI_ADD_*` follow it.

## Deferred (per ADR 0037 — not in this plan)

- **A DTCG/Figma token bridge — `lesto theme import tokens.json`** → emit the `:root`/`.dark`
  OKLCH block, warning on token paths that don't map to a Tailwind namespace. Gated on the
  Phase 2 theme block being the stable contract; a genuine batteries-included differentiator
  (no first-party Tailwind DTCG importer exists; closest is Terrazzo's `@terrazzo/plugin-tailwind`).
- **The `--monorepo` scaffold** — per-app `components.json` → shared `packages/ui`. Gated on a
  real multi-app consumer (Phase 1–3 are single-app, the decided default).
- **preact-dialect shadcn** — gated on a Radix-on-`preact/compat` audit + a consumer.
- **General (non-Tailwind) CSS optimization — critical-CSS inline/defer, per-route/island
  code-split, island-style scoping, AND content-hashing** — the asset-optimization epic's CSS
  task (`L-d50de411`, parent `L-03b682b7`), **rescoped to build on `@lesto/styles`** (which owns
  compile + Lightning-CSS optimize + a **stable** `/styles.css`), gated on Phase 1 (TW6).
  **Content-hashing is NOT in Phase 1** (chief-architect correction): on the Cloudflare edge a
  hashed href can't be read from a manifest at request time — it must be **baked into the worker
  bundle** via a build-time-generated asset module (the `routes.gen.ts`/`regenerateRoutes`
  pattern), a *general* mechanism the unhashed `client.js` needs too. That mechanism + CSS/JS
  content-hashing + precompression (`.br`/`.gz`, `L-c921aa8a`) + SRI on the `<link>`
  (`L-8ee1e193`) all live in the asset-optim epic and compose with the stable `/styles.css`
  `@lesto/styles` emits.
