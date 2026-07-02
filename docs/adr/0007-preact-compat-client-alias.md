# ADR 0007 — Opt-in `preact/compat` alias for the island client bundle

- **Status:** Accepted (opt-in flag implemented; default OFF)
- **Date:** 2026-06-10
- **Context:** continues the bundle-size work begun in ADR 0002 (Lesto on Cloudflare) — the island hydration client is the only JavaScript Lesto ships to the browser, and after `--minify` + `NODE_ENV=production` the React client is still ~118 KiB gzip on the wire (the reconciler, the scheduler, and a slice of `react-dom/server` pulled in by `@lesto/ui`'s barrel). This ADR records an optional way to shed most of it.
- **Relates to:** ADR 0002 (the Worker + Static Assets two-zone front door that serves `/client.js`); `@lesto/ui`'s hydration contract (`hydrateIslands`).
- **Scope note:** the implementation lives in `examples/estate` (not a coverage-gated workspace package). The accompanying per-island mount-resilience change to `@lesto/ui` is a separate, additive hardening of the hydration loop and is noted under "Consequences" rather than driving this decision.

## Context

Lesto SSRs every page on real React (`react-dom/server` in `@lesto/ui`'s `render.tsx`/`stream.tsx`), and ships a single island hydration client (`examples/estate/client.tsx` bundled to `/client.js`) so the deferred islands on an otherwise-static page can come alive in the browser. That client is the *only* JavaScript Lesto puts on the wire — the marketing zone is prerendered HTML served from Cloudflare Static Assets, and the dynamic `/mls` zone is SSR'd at the edge (ADR 0002).

We already cut that bundle hard: `build-client.ts` runs with `--minify` (strip + mangle) and `--production` (pin `NODE_ENV` so React tree-shakes its development-only warnings and invariants, which are the bulk of an un-minified client build). What remains after that is irreducible *React itself*: the reconciler, the scheduler, and — because `@lesto/ui`'s barrel reaches `react-dom/server` even from the client entry — a slice of the server renderer dragged into the client graph. Measured on the real deploy path (`bun run build.ts`):

- **Default (real React) `/client.js`:** `383575` bytes raw, `~118549` bytes gzip (the baseline grew ~282 bytes raw once ADR 0008's lazy-hydration runtime landed in the client; gzip varies a few bytes by zlib version).

React's own docs and the ecosystem put the floor for `react` + `react-dom` at roughly 100–150 KiB before gzip; Preact's compat layer covers the same component API in ~3–9 KiB. Astro documents the swap as routine for client-side-only components and the Vite ecosystem has long treated `react`→`preact/compat` as a standard alias for shipping less JS (typically a 33–48% reduction in those reports). The question for Lesto is not whether the swap shrinks the bundle — it plainly does — but whether it is *safe by default*, and the answer is no (see "Why optional, not default").

## Decision

Add an **opt-in** build flag that aliases `react` to `preact/compat` in the **client bundle only**. Default is OFF: with no flag, `build-client.ts` bundles the same real React every test and deploy already expect. The flag turns the alias on; nothing else changes.

The mechanism, precisely as implemented:

### 1. A Bun-API build script with a resolver plugin (`examples/estate/build-client.ts`)

The `bun build` *CLI* has no `--alias`/`--tsconfig-override` flag (only `--external`/`--conditions`), so aliasing requires the programmatic API. `build-client.ts` calls `Bun.build({ entrypoints, target: "browser", minify, define, plugins })` with a single `onResolve` plugin (`preactAliasPlugin`) that is installed **only when `--preact` is passed**. The plugin rewrites each React specifier with an **anchored `^…$` regex filter** per specifier — anchoring matters, because an unanchored `react-dom` rule would also swallow `react-dom/client` (first match wins) and drop the `createRoot`/`hydrateRoot` entry. Each match resolves its target with `Bun.resolveSync(target, projectRoot)` so the bundler receives a concrete path rather than a bare specifier it would try to alias again and loop on. The full map:

| specifier | aliased to |
| --- | --- |
| `react` | `preact/compat` |
| `react-dom/client` | `preact/compat/client` (the only non-`compat` target — it owns `createRoot`/`hydrateRoot`) |
| `react/jsx-runtime`, `react/jsx-dev-runtime` | `preact/jsx-runtime` (the estate tsconfig emits automatic-runtime imports) |
| `react-dom` | `./preact-react-dom-shim.ts` (local shim) |
| `react-dom/server` | `./preact-react-dom-server-shim.ts` (local shim) |

### 2. Two local shims are mandatory, not incidental

`@lesto/ui`'s index barrel — reached transitively from the client entry via `src/registry.tsx` — drags two server-only concerns into the client module graph, and a bare `react-dom`→`preact/compat` alias fails the bundle outright:

- **`preact-react-dom-shim.ts`** (for `react-dom`): `@lesto/ui`'s `resources.ts` imports React 19's resource hints (`preload`, `preinit`, `preinitModule`, `preconnect`, `prefetchDNS`) from `react-dom` — names `preact/compat` does not export, so the bundle fails with "no matching export" before tree-shaking runs. The shim re-exports everything `preact/compat` provides *plus* those five hints as no-ops. The hints are a server concern (they tell `react-dom/server` to emit `<link rel=preload>` during render); the client — least of all a deferred island mounting fresh — never invokes them, so the no-ops are inert, not lossy.
- **`preact-react-dom-server-shim.ts`** (for `react-dom/server`): `@lesto/ui`'s `render.tsx`/`stream.tsx` pull `renderToStaticMarkup`/`renderToString`/`renderToReadableStream` into the graph, and React's real `react-dom/server` runs top-level bootstrap (`ReactDOMSharedInternals.d`) that **throws** once `react` is aliased away to Preact. Server rendering is never invoked on the client — the browser only ever hydrates — so the shim provides inert stubs whose top-level code is harmless.

Both shims are sound for exactly one reason: **the client only hydrates; it never server-renders and never issues resource hints.** Calling either on the client would be a bug the client path does not commit.

> **Follow-up (2026-07-02, L-7b2ad4b2 / L-381d648b): the CLIENT alias no longer carries EITHER shim.** estate's client entry (`client.tsx`) imports the isomorphic `@lesto/ui` barrel + `@lesto/ui/client`, and neither reaches the server-render surface anymore: the `@lesto/ui` barrel split moved the page renderers (`render.tsx`/`stream.tsx` → `react-dom/server`) behind the `@lesto/ui/server` subpath, and commit `0f2c627` (L-381d648b) then moved the resource hints (`resources.ts` → bare `react-dom`) there too. So **both** the `react-dom` and `react-dom/server` alias entries were dropped from `build-client.ts`'s client `PREACT_ALIAS` — the `--preact` client bundle is byte-identical with both gone, matching the framework's own `@lesto/assets` `PREACT_ALIAS`, which deliberately carries neither. Both shim *files* remain: estate's SSR **worker** imports `@lesto/ui/server` (for `preactServerRenderer`), which still drags both `resources.ts` (bare `react-dom`) and the page renderers (`react-dom/server`) into its graph, so `wrangler.jsonc` keeps aliasing both specifiers to the inert shims (its alias set is now a strict superset of the client's, adding exactly those two).

### 3. The flag is `LESTO_PREACT=1`, read by the spawning files; the build script takes `--preact`

`src/production.ts` and `dev.ts` each `execFileSync("bun", ["build-client.ts", …])` — they *spawn* the build, they do not import it. That boundary is deliberate: the Bun-only `Bun.build` API lives in `build-client.ts` alone, behind a process boundary, so `src/production.ts`/`dev.ts` stay plain node-typed and vitest-importable. Both gate the alias on the environment: `process.env["LESTO_PREACT"] === "1"` appends `--preact` to the spawn argv, otherwise nothing is appended. The build scripts and shims are intentionally **outside** `tsconfig` `include` (they use the Bun global), so `tsc --noEmit` ignores them and stays green; `import type { BunPlugin } from "bun"` keeps oxlint's `consistent-type-imports` happy.

Default production flags (`--minify`, `--production`) and dev's unminified build are preserved exactly; `--preact` only adds the plugin.

### Measured result (the whole point)

On the real deploy path, with `--preact`:

- **`--preact` `/client.js`:** `30369` bytes raw, `~10241` bytes gzip (gzip varies by a few bytes across zlib versions).

That is a **`353206`-byte raw reduction (~92% smaller)** and roughly **108 KiB less gzip** than the default React bundle. The delta is larger than the headline "Preact is ~10 KiB" story because the alias path *also* drops `react-dom/server` — which `@lesto/ui`'s barrel otherwise pulls into the React client bundle — via the inert server shim.

Runtime correctness of the `--preact` bundle was verified for estate's lone deferred island: the minified Preact bundle was run in a jsdom window with a stubbed `/mls/api/session` fetch; the `account--fallback` shell was replaced by the live component, rendering the signed-in greeting ("Hi, Jade Mills ·") on the signed-in path and `account--out` on the signed-out path — confirming the live component mounted via `createRoot`.

## Why optional, not default

Three documented correctness traps make `react`→`preact/compat` unsafe to flip on for everyone, which is why it ships behind a default-OFF flag rather than as the standard build:

1. **The SSR-hydration boundary (the load-bearing reason — see below).** Server markup is emitted by real React; Preact-hydrated markup would have to match it byte-for-byte for `ssr: true` islands. It does not.
2. **`react-aria`-class libraries can break under compat.** Components that reach into React internals or rely on exact React behavior have a history of failing under `preact/compat`; Astro's tracker documents real breakage (`withastro/astro#4107`). Lesto ships only `@lesto/ui`'s own components today, but the alias must not be a silent global default that quietly breaks the moment an app pulls in such a dependency.
3. **Dev/prod alias-divergence is its own bug class.** Aliasing one build (here: production/preact-on) but not another (dev/preact-off) means the bytes that ship are not the bytes developed against — a class of bug the Vite ecosystem has had to fix explicitly (`vitejs/vite#15602`). Keeping the alias opt-in and explicit keeps that divergence visible and intentional rather than ambient.

There are also semantic differences — Preact's event system and its lack of React's concurrent features — that are immaterial for a fresh `createRoot` mount but would matter for richer islands. None of these block the *opt-in*; together they block making it the default.

### The SSR boundary (the explicit follow-up)

This alias is **safe only for deferred (`ssr: false`) islands** — those that mount fresh on the client with `createRoot` against a placeholder shell, with **no server-emitted markup to hydrate against**. estate's single island (`Account`) is exactly that, which is why the flag is safe for estate today.

It is **NOT yet safe for `ssr: true` islands.** Those hydrate React-emitted server HTML; under the alias, Preact's `hydrateRoot` would try to adopt markup produced by real React's `react-dom/server`, and the two renderers' output is not identical. Making `ssr: true` safe under Preact requires switching the **server** renderer too — `@lesto/ui`'s `render.tsx`/`stream.tsx` would move from `react-dom/server` to `preact-render-to-string` so the server- and client-emitted markup match. **We deliberately keep server rendering on real React** in this change; the server-renderer swap is out of scope (and `@lesto/ui` is owned by another agent). This is the known follow-up: a default-on Preact client is unblocked only once server and client render the same dialect.

> **Follow-up resolved (2026-06-10): see [ADR 0008](./0008-pluggable-server-renderer.md).** `@lesto/ui`'s server renderer is now pluggable: `renderPageMarkup` takes an injectable `ServerRenderer` (default real `react-dom/server`, so the default path is unchanged), and a `preactServerRenderer` adapter ships from `@lesto/ui/server-preact`. A Preact-client app that wants `ssr: true` islands passes that adapter to `renderPageMarkup` so server and client speak the same dialect. This closes the gap above; "Preact by default" now reduces to an app picking the matching server+client pair (and accepting the traps in "Why optional, not default"). estate still ships only the deferred `Account` island, so it was not rewired.

## What this is and isn't

- **Is:** an opt-in (`LESTO_PREACT=1`, default OFF) `react`→`preact/compat` alias for the **client** island bundle, implemented as a `Bun.build` resolver plugin in `build-client.ts`, with two mandatory inert shims for the `react-dom`/`react-dom/server` exports `@lesto/ui`'s barrel drags into the client graph. Measured: `383575`→`30369` bytes raw (~92% smaller) on the real deploy path, verified to hydrate estate's deferred `Account` island in jsdom.
- **Isn't:** a change to the **default** build (with no flag, the bytes and behaviour are exactly as before), and **not** a server-renderer change — server rendering stays on real React, so this is unsafe for `ssr: true` islands until the server is switched to `preact-render-to-string` (the named follow-up). It is also not a workspace package: it lives in `examples/estate`, which is not coverage-gated.

## Consequences

- An app whose islands are all deferred (`ssr: false`) can ship ~108 KiB less gzip to the browser by setting one env var, with no source changes — a real Lighthouse "Reduce unused JavaScript" win on the edge.
- The default path is untouched and remains the safe, supported build; the alias is an explicit, visible opt-in, so dev/prod divergence (trap 3) is a conscious operator choice, not an ambient surprise.
- Two shims now sit in `examples/estate` whose correctness depends on a single invariant — *the client never server-renders and never issues resource hints*. If a future island violates that (e.g. an island that calls a resource hint at runtime), the inert no-ops would silently do nothing under `--preact` while working under default React; the shims' prose comments flag this.
- A default-on Preact client remains blocked on switching `@lesto/ui`'s server renderer to `preact-render-to-string` so `ssr: true` markup matches. Tracked as the explicit follow-up above.
- **Companion `@lesto/ui` change (separate concern, recorded for the integrator):** alongside this work, `hydrateIslands` gained per-island mount resilience — each `mount()` is wrapped in try/catch, a throwing island is routed to an injectable `MountErrorSink` (`onMountError`, defaulting to a `consoleMountError` sink) and recorded in a new `HydrationResult.failed: string[]`, and the loop continues so one bad island no longer aborts hydration of the rest. The `UI_ISLAND_UNKNOWN_COMPONENT` drift throw stays *outside* the try — manifest/registry drift remains a fatal build-time programming error, not a per-visitor runtime fault. The change is additive (`failed` is an empty array on every success path), exported from the `@lesto/ui/client` barrel, and lands at 100% coverage with both new branches tested. It is independent of the Preact alias but worth documenting because it extends the hydration contract and `preact@10.29.2` was added as a root devDependency to support the alias build.
