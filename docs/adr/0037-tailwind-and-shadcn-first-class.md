# ADR 0037 — First-class Tailwind v4 + shadcn/ui (a styling pipeline, a compatible scaffold, and a Lesto-flavored component registry agents can install)

- **Status:** Proposed (2026-06-23). **Phase 1** (a Tailwind v4 CSS build step — a new
  `@lesto/styles` package whose pure `buildStyles(options, deps)` orchestrates over an
  injected `StyleCompiler` seam, the real `@tailwindcss/node` + `@tailwindcss/oxide` wiring
  living in a coverage-excluded edge exactly as `@lesto/assets`'s `bun.ts` does, plus CLI
  build/dev-watch/hot-swap wiring, auto-injection at render, a `ui.css` config key, and a
  scaffolded CSS entry) is the **committed build-now** and the foundation everything else
  needs. **Phase 2** (shadcn compatibility by scaffolding a Lesto app as a *generic*
  shadcn project — a valid `components.json`, path aliases, a `cn()` util, the v4 OKLCH
  theme CSS, and a thin `lesto add` wrapper that island-wraps interactive primitives) is
  designed here and gated on Phase 1's CSS pipeline existing. **Phase 3** (ship `@lesto` as
  a hosted shadcn **registry** of islands-aware, Workers-safe components + pre-wire the
  **shadcn MCP** in the scaffold so humans *and agents* can discover/install them) is the
  differentiator and gated on Phase 2's compat being real. **Phase 4** (a DTCG/Figma
  `lesto theme import` token bridge; the `--monorepo` scaffold) is **deferred** — recorded,
  not scheduled. Commit only Phase 1 now.
- **Date:** 2026-06-23
- **Deciders:** tech lead + owner (ratification pending)
- **Builds on / touches:** ADR 0011 (optimized-by-default pipeline — the CSS build is a
  *sibling* of the island-client build it defines; it reuses that pattern verbatim:
  `buildClient` is pure orchestration over injected `BuildClientDeps`
  (`packages/assets/src/build-client.ts:212`) with the real `Bun.build` + `node:fs` wiring
  isolated in a coverage-excluded edge (`packages/assets/src/bun.ts:1-10,116`), a gzip-size
  `BuildReport` narration, and an optional `budgetBytes` → `ASSETS_BUDGET_EXCEEDED`
  (`build-client.ts:46-54,351-363`). The CSS build mirrors this exactly). ADR 0008
  (matched-pair server/client dialect — the CLI reads the single `ui.dialect` key
  (`packages/cli/src/bin.ts:378-392`); shadcn support targets the **`react`** dialect, see
  *Non-goals*). ADR 0023 (file-based routing — the CSS scanner walks the same `app/` tree
  the routes/islands conventions live under, `bin.ts:161,185`). ADR 0035 / the agent-native
  wave (0031–0034, ratified 2026-06-23) — Phase 3's shadcn-MCP-+-`@lesto`-registry is the
  *UI* leg of the same "agent-native" positioning, and reuses the same scaffold
  (`packages/create-lesto/src/scaffold.ts:114`) that 0035 emits `AGENTS.md` into. The dev
  live-reload channel (`buildLiveReload`, `bin.ts:417-433`, with its `notify` / `notifyError`
  / injected `script` seams) gains a CSS hot-swap. Render-time head-tagging reuses the
  existing `RenderPageOptions` seam that already head-tags the island client module
  (`packages/web/src/render-page.tsx:202,216,237-238`). The CLI's **optional peerDependency**
  pattern (`@lesto/content-core`/`@lesto/content-store`, `packages/cli/package.json:39-50`,
  lazily imported) is the precedent for keeping the heavy Tailwind native binaries **out of
  the CLI's eager graph**. Makes real the long-deferred `ARCHITECTURE.md` line — "UI
  components — shadcn/ui (Radix + Tailwind)" and "Tailwind — required for shadcn" — which
  has been a *Proposed/deferred* bet since before this wave.

## Context

Lesto has **no CSS pipeline at all today**. `@lesto/assets` bundles island hydration JS via
`Bun.build` and touches no stylesheets (`build-client.ts`, `bun.ts` — there is no CSS path
anywhere in the package). A freshly-scaffolded app ships **no** CSS file: the scaffold's
file list (`scaffold.ts:114-129`) has `app/routes/page.tsx`, `app/routes/layout.tsx`, an
island, config, and a worker — and zero styling; the route templates use bare `className`
strings with nothing backing them. The only styling-adjacent config is `ui.dialect`
(`bin.ts:378`). So this is greenfield: there is no legacy CSS system to migrate, and the
two named differentiators in `ARCHITECTURE.md` — Tailwind and shadcn/ui — are both still
*aspirational*.

Three concrete demands, in priority order:

1. **There is no way to ship CSS.** An app cannot use Tailwind (or any stylesheet built
   from source) because nothing compiles or serves one. The injection seam half-exists —
   `headElements` renders `metadata.links` as `<link rel="stylesheet">`
   (`render-page.tsx:216`) — but no stylesheet is ever *generated*. The framework needs a
   first-class CSS build step that compiles Tailwind v4, serves the result alongside
   `out/client.js`, hot-swaps it in dev, and injects it automatically.

2. **shadcn's CLI does not know Lesto exists** — and it does not need to. shadcn is
   copy-the-code, not an npm dependency; `npx shadcn add <component>` works against **any**
   project that has four things: a valid `components.json`, path aliases backed by
   `tsconfig#paths` *or* `package.json#imports`, a Tailwind v4 CSS entry, and a `cn()` util.
   The shadcn CLI's framework *detection* only gates its own `init` scaffolding (a closed
   template list — `next | vite | astro | …`, no `custom`). So the cheap, robust play is
   **not** to get Lesto added upstream; it is to scaffold those four things so a Lesto app
   *is* a generic shadcn project. The single genuinely Lesto-specific wrinkle: shadcn
   components are React **client** components, and Lesto's client interactivity is **islands**
   — so an interactive shadcn primitive (Dialog, DropdownMenu, Popover, Sheet, Sonner) must
   be wrapped as a `defineIsland`, while static-safe primitives (Button, Card, Badge, …)
   render server-side directly.

3. **"Agent-native" should extend to UI, and we should dogfood.** The agent-native wave
   (ADRs 0031–0035) makes a Lesto app legible and observable to coding agents. The shadcn
   **MCP server** (shipped by the shadcn CLI itself — `npx shadcn mcp` — exposing
   search/view/get-add-command/audit tools over whatever registries `components.json`
   declares) means an agent can discover and install components with **zero** custom MCP
   work on our side: pre-wire a `@lesto` registry namespace + ship a `.mcp.json`, and the
   same MCP server serves Lesto-flavored components. And a `@lesto` registry — itself a
   tiny Lesto Worker serving `/r/[name].json` — is a dogfood of our own routing/assets.

What this is **not**: not a CSS-in-JS runtime; not a bespoke component library competing
with shadcn (we *adopt* shadcn, we don't reinvent it); not a Tailwind *fork* or a vendored
copy of the engine; not a visual theme editor (we point at tweakcn/Figma kits); not a
promise that every shadcn component works under the `preact` dialect (see *Non-goals*).

## The core idea: a CSS build that is the island build's twin, and shadcn adopted by being a normal shadcn project

Two named abstractions, each the *minimal* sound one:

**(A) `buildStyles` is `buildClient`'s sibling.** Tailwind v4's content detection scans the
**filesystem as plain text**, independent of the JS module graph — so the CSS build is a
*standalone* step that walks `app/` and emits one optimized stylesheet, **not** a `Bun.build`
plugin entangled with the island bundle. That makes it a near-exact copy of the proven
`@lesto/assets` shape:

| `@lesto/assets` (islands, today) | `@lesto/styles` (CSS, this ADR) |
|---|---|
| `buildClient(options, deps)` — pure orchestration (`build-client.ts:212`) | `buildStyles(options, deps)` — pure orchestration |
| `BuildClientDeps` injected seams (`build-client.ts:118`) | `StyleCompiler` injected seam (compile + scan + optimize) |
| real `Bun.build` wiring in coverage-excluded `bun.ts` (`bun.ts:1-10`) | real `@tailwindcss/node`+`oxide` wiring in coverage-excluded `tailwind.ts` |
| gzip `BuildReport` + `budgetBytes` → `ASSETS_BUDGET_EXCEEDED` | gzip `BuildReport` + `budgetBytes` → `STYLES_BUDGET_EXCEEDED` |
| writes `out/client.js` (+ hashed chunks) | writes `out/styles.css` |
| coded `AssetsError` (`packages/assets/src/errors.ts`) | coded `StylesError` (the `LestoError<Code>` pattern, `packages/queue/src/errors.ts`) |

The pure orchestration is 100%-testable with a fake `StyleCompiler` (no native engine, no
disk), exactly as `build-client.ts` is tested without `Bun.build`; the real engine wiring is
the `bin`-equivalent edge the coverage gate already excludes for `bun.ts`, exercised by an
integration test that compiles a real fixture (the way the bundle-size script exercises real
`Bun.build`).

**(B) A Lesto app is a generic shadcn project.** We do not teach the shadcn CLI about Lesto;
we scaffold the four things `shadcn add` requires and let it run unmodified. The only code
Lesto writes is (1) the scaffold of those four things, and (2) a thin `lesto add` that
delegates to `shadcn add` and post-processes interactive primitives into islands. Everything
else — the registry of primitives, the theme tokens, the MCP server — is shadcn's existing
machinery pointed at a `@lesto` namespace we host.

## Decision

### Phase 1 — build now: a Tailwind v4 CSS build step (`@lesto/styles`) wired into the CLI

Five integration points, each on the right side of the existing layering:

1. **A new `@lesto/styles` package: pure `buildStyles` over an injected `StyleCompiler`.**
   `buildStyles(options, deps)` mirrors `buildClient` (`build-client.ts:212`): read the CSS
   entry → ask the compiler to scan `app/` and compile → measure gzip → write `out/styles.css`
   → narrate + enforce an optional budget. The `StyleCompiler` seam is the single impure
   surface:
   ```ts
   export interface StyleCompiler {
     /** Compile `entryCss`, resolving its @imports (e.g. "tailwindcss",
      *  "tw-animate-css") from `resolveBase` (the project root, where node_modules
      *  lives) and scanning `scanRoot` (the app source, "app/") for class usage;
      *  return the optimized CSS and the source paths the build depends on (watch). */
     compile(req: {
       entryCss: string;
       resolveBase: string;       // project root — where @import "tailwindcss" resolves
       scanRoot: string;          // app source — where utility classes are scanned
       mode: BuildMode;           // a local "development" | "production" union (not a cross-package import)
     }): Promise<{ css: string; dependencies: readonly string[] }>;
   }
   ```
   (`resolveBase` and `scanRoot` are **distinct** — class-scanning roots at `app/`, but
   `@import "tailwindcss"`/`tw-animate-css` resolve from the project root. `BuildMode`/
   `BuildReport` are trivial enough — a two-string union and a `(line) => void` — that
   `@lesto/styles` **defines them locally** rather than importing from `@lesto/assets`, so it
   gains no `styles → assets` package edge for a 2-member union.)
   No native engine in the decision path; `buildStyles` is pure over whatever the fake
   compiler returns, so the order, the budget verdict, and the gzip report are unit-tested
   to 100% — the `build-client.ts` discipline.

2. **The real engine wiring in a coverage-excluded edge (`@lesto/styles`'s `tailwind.ts`).**
   The default `StyleCompiler`, wired to `@tailwindcss/node`'s `compile()` (+ `optimize()` =
   Lightning CSS minify/prefix) and `@tailwindcss/oxide`'s `Scanner` over `scanRoot`. This is
   the `bin`-equivalent of the package — excluded from the serial coverage gate exactly as
   `bun.ts` is (`bun.ts:6-9`) — and covered by an integration test that compiles a real
   fixture CSS. **The accepted cost, stated loudly:** `@tailwindcss/node` + `@tailwindcss/oxide`
   are officially **internal/unstable** APIs (no semver guarantee). We therefore (a) **pin the
   engine** — `@tailwindcss/node` + `@tailwindcss/oxide` to one exact version (they ship as one
   release train) as **dependencies of `@lesto/styles`** — and declare **`tailwindcss` a
   `peerDependency`** of `@lesto/styles`, because the app's CSS does `@import "tailwindcss"`
   and shadcn (Phase 2) expects `tailwindcss` resolvable in the app: the **app** pins
   `tailwindcss` (scaffolded, Inc 6) to the **same 4.x train** as the engine, and the compiler
   resolves the import from the app's `resolveBase`. (One `tailwindcss` instance — the app's —
   wrapped by the framework-owned engine; the same-train constraint is documented + asserted in
   the scaffold deps.) And (b) keep them **behind the `StyleCompiler` interface** so a
   shell-out-to-`@tailwindcss/cli` fallback can replace the edge without touching `buildStyles`
   or any caller if a 4.x bump breaks the programmatic API. The chosen path (programmatic over
   shell-out) is deliberate: it composes with Lesto's existing in-process watch loop and gives
   the sub-10ms incremental rebuilds Lesto's DX pitch rests on.

3. **CLI wiring: build + dev-watch + hot-swap — Tailwind stays opt-in via a lazy import.**
   `@lesto/styles` declares `@tailwindcss/*` (the heavy native binaries) as its deps; the CLI
   declares **`@lesto/styles` an optional `peerDependency`** (mirroring `@lesto/content-core`,
   `cli/package.json:39-50`) and **lazily `await import("@lesto/styles")`** only when a CSS
   entry exists — so an app that uses no Tailwind never pulls the native engine and the CLI's
   eager graph stays clean. The CSS entry is resolved from a new `ui.css` config key (default
   convention: `app/styles/app.css`); its presence enables the CSS build exactly as
   `app/islands/`'s presence enables the client build (`bin.ts:161`). In `build`, run
   `buildStyles` alongside `buildClientAssets` (`bin.ts:378`), writing `out/styles.css`. In
   `dev`, broaden the watch from `app/islands/`-only (`watchIslands`, `bin.ts:396`) to the
   source set the compiler's returned `dependencies` name (routes, components, islands —
   classes appear everywhere), debounced like the island watcher, and on a CSS rebuild push a
   **hot-swap** message through the existing `buildLiveReload` channel (`bin.ts:417-433`) — a
   new `style-update` alongside `notify`/`notifyError` that swaps the stylesheet `<link>`
   without a full reload (preserving island state), **cache-busting the href with a `?t=`
   query** since `/styles.css` is a stable, cacheable name. The *when-to-swap* decision lives in
   the covered core; the WebSocket wiring is the coverage-excluded bin, exactly as the existing
   reload/overlay split already is. (Serving needs **no** change: `.css` is already an asset
   extension the dev server passes through from `out/`, and prod serves `out/` via Workers
   Assets automatically — `/styles.css` → `out/styles.css` on both, see *Reviews*.)

4. **Auto-injection at render via the existing builder seam.** A built `out/styles.css` is
   head-tagged through the **same builder mechanism that already wires the client module** —
   not a new path. Today `lesto().client("/client.js")` sets `clientModuleSrc` (`lesto.ts:350`),
   threaded as the `clientModule` render option (`lesto.ts:615`) and emitted as a
   `<script type="module">` (`render-page.tsx:373-375`). Add a **sibling
   `lesto().styles("/styles.css")`** → a `clientStyles` render option → a
   `<link rel="stylesheet">` in `headElements` (`render-page.tsx:202`). The hand-authored
   `metadata.links` path stays for extra stylesheets. **The name is a stable
   compile-time constant** (`/styles.css`), threaded into the worker's JS exactly like
   `/client.js` — which is what makes it work **identically on node and the Cloudflare edge**:
   the edge render has no request-time filesystem, so the href must be a baked constant, not a
   manifest read (see *Reviews* — this is the corrected design). This is consistent with
   `client.js`, which is also unhashed today; served with a revalidating `Cache-Control`.
   **Content-hashing for long-cache immutability is deferred to the asset-optimization epic**
   (it requires a build-time-generated asset-manifest module baked into the worker bundle — the
   `routes.gen.ts`/`regenerateRoutes` codegen pattern — a *general cross-asset* mechanism that
   the unhashed `client.js` needs too, **not** a CSS-only Phase-1 concern).

5. **Scaffold the CSS entry + config + the `.styles()` call.** `create-lesto`
   (`scaffold.ts:114`) gains `app/styles/app.css` (the shadcn v4 theme block — Phase 2), wires
   `ui.css` in `lesto.app.ts`, adds the **`.styles("/styles.css")`** call next to the existing
   `.client("/client.js")` in the scaffolded app/worker config (so the `<link>` is injected),
   and adds `@lesto/styles` + the pinned `tailwindcss` (same 4.x train as the engine) to the
   app's `package.json`. Documented gotcha shipped in the scaffold comments: Tailwind's scanner
   **cannot** see interpolated class strings (`bg-${x}`) — emit complete static class strings;
   use `@source inline(...)` for runtime-dynamic classes.

- **Coded errors / fail-loud.** Every refusal — a missing/unreadable CSS entry when `ui.css`
  is set, a compile failure, a blown CSS budget — throws a stable `StylesError` code
  (the `LestoError<Code>` closed-union pattern, `packages/queue/src/errors.ts`; e.g.
  `STYLES_ENTRY_NOT_FOUND`, `STYLES_COMPILE_FAILED`, `STYLES_BUDGET_EXCEEDED`). Tests branch
  on the code, never the message.

Phase 1 is additive, introduces no new **eager** dependency (the Tailwind engine is an
optional peer, lazily imported), and the pure `buildStyles` is 100%-testable with a fake
compiler. It is **shippable at the full bar** (it compiles CSS; it calls no model).

### Phase 2 — designed here, gated on Phase 1: a Lesto app is a generic shadcn project

Scaffold the four things `shadcn add` needs, plus the island-aware glue:

1. **`components.json`** at the app root — `style: "new-york"`, `tailwind.config: ""`
   (v4 has no JS config), `tailwind.css: "app/styles/app.css"`, `cssVariables: true`,
   `baseColor: "neutral"`, `iconLibrary: "lucide"`, and `aliases` with
   `components: "@/components"`, `ui: "@/components/ui"`, `utils: "@/lib/utils"`,
   `lib: "@/lib"`, `hooks: "@/hooks"`. Components land **in-app** under `app/components/ui`
   (the decided default — Tailwind detection then "just works" with no `@source` for a
   workspace package, and it matches shadcn's single-app docs exactly).
2. **Path aliases** — extend the scaffolded `tsconfig.json` (`scaffold.ts:124`) with
   `"paths": { "@/*": ["./*"] }` so the `@/…` aliases resolve. (ESM `package.json#imports`
   is the alternative shadcn supports; tsconfig paths is the lower-friction default for a
   single app.)
3. **The v4 OKLCH theme CSS** is what `app/styles/app.css` contains — the shadcn v4 block:
   `@import "tailwindcss"; @import "tw-animate-css"; @custom-variant dark (&:is(.dark *));`
   then `@theme inline { --color-*: var(--*); --radius-*: … }`, the `:root` + `.dark` OKLCH
   token sets, and an `@layer base` applying `border-border`/`bg-background`. This is the
   exact contract tweakcn and the Figma kits produce/consume.
4. **`cn()`** at `app/lib/utils.ts` (`clsx` + `tailwind-merge`), and the deps
   (`clsx`, `tailwind-merge`, `tw-animate-css`, `lucide-react`) added to the app
   `package.json`.
5. **`lesto add` — a thin wrapper.** Delegates to `npx shadcn add` (so we inherit the whole
   CLI + registry resolution for free) and runs a **post-process** that, for the known
   client-only primitives, emits a Lesto **island** wrapper preserving `data-slot`; static-safe
   primitives are left as direct server-renderable components. This is the only Lesto-specific
   code in Phase 2 and the only place the islands×shadcn boundary is handled.

After Phase 2, `npx shadcn add button` (or `lesto add button`) works in a Lesto app with
**zero** upstream changes.

### Phase 3 — gated on Phase 2: ship `@lesto` as a registry + pre-wire the shadcn MCP

1. **A hosted `@lesto` registry.** Author a `registry.json` (`name: "lesto"`) + per-component
   `registry-item.json` files, built with `shadcn build` to `/r/[name].json` and **served by a
   small Lesto Worker** (dogfooding routing/assets). Use `cssVars`/`css` (the v4-native fields,
   not the deprecated `tailwind` field) for tokens/layers, `registryDependencies` to reuse
   upstream `@shadcn` primitives, and **ship the interactive primitives pre-wrapped as Lesto
   islands** (the Phase 2 boundary, solved once in the registry). Ship the Lesto theme as a
   `registry:theme` item so it is tweakcn/Figma-compatible.
2. **Register the namespace** in the scaffold's `components.json`:
   `"registries": { "@lesto": "https://lesto.run/r/{name}.json" }`. Then
   `npx shadcn add @lesto/data-table` resolves a Lesto-flavored component, pulling upstream
   primitives via `registryDependencies`.
3. **Pre-wire the shadcn MCP** — ship `.mcp.json` in the scaffold with
   `{ "mcpServers": { "shadcn": { "command": "npx", "args": ["shadcn@latest", "mcp"] } } }`.
   Because the shadcn MCP reads `components.json#registries`, its tools (search/view/
   get-add-command/audit) discover and install `@lesto` components with **no custom MCP server
   to build**. This is the UI leg of the agent-native positioning, sitting next to ADR 0035's
   `AGENTS.md`/docs-MCP in the same scaffold.

## Non-goals

- **No CSS-in-JS runtime.** Tailwind is compile-time; the build emits a static stylesheet,
  no runtime style injection.
- **No reinvented component library.** Lesto *adopts* shadcn (copy-in components + a `@lesto`
  registry of Lesto-flavored variants); it does not ship a competing primitives package. The
  private `@lesto/ui-kit` stub stays internal and is not the public story.
- **No vendored/forked Tailwind engine.** We depend on the published `@tailwindcss/*` train
  (pinned), behind the `StyleCompiler` seam — never a copy of the engine.
- **No guarantee shadcn works under the `preact` dialect (v1).** shadcn primitives are React +
  Radix; the matched-pair `preact` dialect (`build-client.ts:221-250`) aliases to
  `preact/compat`, where Radix is a known risk. Phase 1–3 **target the `react` dialect**;
  preact-dialect shadcn is *Deferred* (gated on a real consumer + a Radix-on-preact audit).
- **No visual theme editor.** Theming is OKLCH CSS variables; we point at tweakcn + the Figma
  kits, and ship the theme as a `registry:theme` item — we do not build an editor.
- **No upstream shadcn framework-template entry (v1).** Generic-project compat is sufficient;
  getting Lesto into shadcn's `init` template enum is *Deferred* and unnecessary.
- **No content-hashed CSS filename (Phase 1).** `/styles.css` is a stable constant (like
  `client.js`, also unhashed today); content-hashing + the build-time worker-baked asset
  manifest it requires on the edge is the asset-optimization epic's job (*Deferred*).

## Deferred — recorded, not scheduled; each gated on a real consumer

- **A DTCG/Figma token bridge — `lesto theme import tokens.json`.** Figma variables →
  DTCG `tokens.json` → emit the `:root`/`.dark` OKLCH block (+ `@theme` for primitives),
  **warning on token paths that do not map to a Tailwind namespace** (they silently become
  utility-less vars). No first-party Tailwind DTCG importer exists (closest is Terrazzo's
  `@terrazzo/plugin-tailwind`), so this is a genuine batteries-included differentiator —
  but it is a fast-follow, gated on Phase 2's theme block being the stable contract.
- **The `--monorepo` scaffold** — per-app `components.json` whose `ui`/`utils` aliases point
  at a shared `packages/ui`, v4 CSS in the shared package. Gated on a real multi-app
  consumer; Phase 1–3 are single-app (the decided default).
- **General (non-Tailwind) CSS optimization — critical-CSS inline/defer, per-route/island
  code-split, island-style scoping, AND content-hashing** — these are the asset-optimization
  epic's CSS task (`L-d50de411`, parent `L-03b682b7`), now **rescoped to build *on*
  `@lesto/styles`** rather than as a parallel pipeline (see *Reviews*). `@lesto/styles` owns
  compile + Lightning-CSS optimize + emitting a **stable** `/styles.css`; the
  critical-CSS/split/scope/**content-hash** concerns layer on top of it. **Content-hashing the
  CSS** (and `client.js`, also unhashed) requires a *new general* mechanism the repo lacks
  today: a build-time-generated asset-manifest module **baked into the worker bundle** (the
  `routes.gen.ts`/`regenerateRoutes` codegen pattern), because the edge render has no
  request-time filesystem to read a manifest from. Per-asset precompression (`.br`/`.gz`,
  `L-c921aa8a`) and SRI on the emitted `<link>` (`L-8ee1e193`) compose with that hashed
  artifact once it exists. (Chief-architect review finding — see *Reviews*.)
- **preact-dialect shadcn** — gated on a Radix-on-preact/compat audit + a consumer.

## Reviews

- **Internal adversarial pass (2026-06-23) — surfaced and folded in:**
  - **Layering:** the Tailwind native engine must **not** enter the CLI's eager graph (it
    would force the `@tailwindcss/oxide` platform binaries on every Lesto install, Tailwind
    or not). Fixed by making `@lesto/styles` an **optional peerDependency** lazily imported
    only when a CSS entry exists — the `@lesto/content-core` precedent
    (`cli/package.json:39-50`).
  - **Correctness:** the CSS build is **not** a `Bun.build` plugin — Tailwind scans the
    filesystem as text, not the module graph, so it is a standalone step. This also means the
    dev watch must cover **all of `app/`**, not just `app/islands/` (`watchIslands`,
    `bin.ts:396`), or class edits in routes/components would not trigger a CSS rebuild.
  - **Stability risk (stated, not hidden):** `@tailwindcss/node`+`oxide` are unstable APIs.
    Mitigated by a hard version pin + the `StyleCompiler` seam (shell-out fallback swappable
    with no caller change). The alternative — shell out to `@tailwindcss/cli` from the start —
    was considered and rejected for v1 (out-of-process, a second watcher, worse incremental
    DX), but kept as the documented fallback the seam enables.
  - **Scope:** *cut* building a bespoke component library and a visual theme editor (adopt
    shadcn + point at tweakcn); *cut* teaching the shadcn CLI about Lesto (generic-project
    compat suffices); *kept* the one irreducible Lesto-specific piece — island-wrapping
    interactive primitives — and localized it to the `@lesto` registry + the `lesto add`
    post-process.
  - **Sequencing:** Phase 1 (the CSS pipeline) blocks everything; Phase 2 (scaffold compat)
    blocks Phase 3 (registry + MCP); the token bridge and monorepo are genuinely independent
    fast-follows, so they are *Deferred*, not in the committed cut.

- **Reconciliation with the Asset Optimization epic (2026-06-23).** A pre-existing board-only
  epic — `L-03b682b7` (no ADR/plan) — contains a **CSS pipeline task `L-d50de411`**
  ("extract/bundle/minify (lightningcss) + code-split + critical-CSS inline + scoping") that
  starts from the *same audit* as this ADR ("`@lesto/assets` does NOT process CSS at all").
  Left independent, the two would build **competing CSS pipelines**. Resolution: **`@lesto/styles`
  is the single CSS-build foundation** — it owns compile (Tailwind-aware), Lightning-CSS
  optimize (free via `@tailwindcss/node`), and emitting a **stable** `/styles.css`; `L-d50de411`
  is **rescoped** to the genuinely-additive, non-Tailwind concerns (critical-CSS inline/defer,
  code-split, island-style scoping, **and content-hashing**) **layered on `@lesto/styles`**, and
  is gated on Phase 1 (a `blocks` edge from TW6). The asset-optim CSS task is naive to Tailwind
  (no source scanning / `@theme` / content-detection) and a naive "Bun.build CSS plugin" reading
  of it is **architecturally incompatible** with Tailwind's filesystem-scan model — so the CSS
  architecture of record is *this ADR*, which the rescoped task references. Precompression
  (`L-c921aa8a`) and SRI (`L-8ee1e193`) compose with the stable `/styles.css` `@lesto/styles`
  emits (and, later, with the content-hashed artifact `L-d50de411` adds). Font optimization
  (`L-086711e8`) coordinates with the Tailwind `--font-*` theme tokens (Phase 2).

- **Chief-architect review (2026-06-23) — one P0 + three P1s, all folded in.** An independent
  code-grounded trace of the asset-serving + render path (both node and the Cloudflare edge)
  corrected this ADR:
  - **P0 (correctness): the content-hashed CSS decision was unbuildable on the edge as drafted.**
    A prior revision said production reads a manifest (`out/.lesto-styles.json`) to thread the
    hashed `styleHref`. But the edge render runs per-request in the Worker with **no
    filesystem** — the client URL today (`/client.js`) is a **compile-time constant baked into
    the worker** (`lesto().client(...)` → `clientModule`, `lesto.ts:350,615` →
    `render-page.tsx:373-375`), and nothing resolves asset paths at request time
    (`routes.gen.ts` bakes route imports, not assets). **Fix:** Phase 1 ships a **stable
    `/styles.css`** threaded as a constant exactly like `/client.js` (works identically on node
    + edge, zero new mechanism); **content-hashing is moved to the asset-optim epic** (it needs
    a *new, general* build-time asset-manifest module baked into the worker bundle — the
    `routes.gen.ts` pattern — which `client.js` itself also lacks). Corollary caught: a hashed
    name must be **dot-delimited `styles.<hash>.css`** to be recognized by `hasContentHash`
    (`http-cache.ts:127`) for immutable caching — a dash form is served `no-cache`, silently
    defeating it.
  - **P1 (under-specified seam): the injection seam is the `lesto()` builder, not just
    `render-page`.** The plan named only `render-page.tsx`. **Fix:** add a sibling
    `lesto().styles("/styles.css")` → a `clientStyles` render option (mirroring `.client()` →
    `clientModule`), plus the scaffold call site — touching `packages/web/src/lesto.ts`, not
    only the renderer.
  - **P1 (interface): `StyleCompiler.compile` conflated two roots.** Class-scanning roots at
    `app/` but `@import "tailwindcss"`/`tw-animate-css` resolve from the project root. **Fix:**
    the interface exposes both `scanRoot` and `resolveBase`.
  - **P1 (dependency contradiction): `tailwindcss` ownership.** A prior revision said the
    framework owns the version *and* the app pins it. **Fix:** the **engine**
    (`@tailwindcss/node`/`oxide`) is a `@lesto/styles` dep; **`tailwindcss` is a `peerDependency`**
    of `@lesto/styles` and the **app** pins it (shadcn expects it resolvable) to the same 4.x
    train.
  - **Nits folded:** `BuildMode`/`BuildReport` are defined **locally** in `@lesto/styles` (no
    `styles → assets` package edge for a 2-member union); the dev hot-swap **cache-busts** the
    `<link>` href (`?t=`); and a *validation* — dev/prod serving need **zero** changes (`.css`
    is already a passthrough asset extension, `sites-dev.ts:50`; prod serves `out/` via Workers
    Assets), so `/styles.css` → `out/styles.css` on both.
  - **Adjacent gap surfaced (not owned here):** the JS entry `client.js` is **also** unhashed +
    served revalidating today, and nothing owns hashing it; it needs the *same* edge
    asset-manifest mechanism. Flagged for the asset-optim epic.

## Consequences

- A Lesto app can ship Tailwind v4 styling out of the box — a real CSS pipeline that is the
  exact twin of the proven island-client pipeline, 100%-tested at the pure-orchestration
  layer, with the unstable engine isolated behind a swappable seam and kept out of the eager
  dependency graph.
- `npx shadcn add` works in a Lesto app, and `lesto add` additionally handles the
  islands×shadcn boundary — so the framework's batteries finally include the component
  ecosystem developers actually want, without us maintaining a component library.
- Agents get a UI story: the shadcn MCP + a hosted `@lesto` registry let them discover and
  install components with no custom MCP server — the UI leg of the agent-native positioning,
  dogfooded on a Lesto Worker.
- Cost, stated: the Tailwind engine edge rides an officially-unstable API (pinned + sealed
  behind `StyleCompiler`); shadcn support targets the `react` dialect only in v1; the
  Figma/DTCG token bridge and the monorepo scaffold are deferred to real consumers. Slow
  iteration upheld — only the CSS build (Phase 1) is the committed keystone; Phases 2–4 are
  gated.
