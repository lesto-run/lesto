# ADR 0008 — Pluggable server renderer (`ssr: true` under Preact)

- **Status:** Accepted (capability + end-to-end proof in `@keel/ui`; no app wired yet)
- **Date:** 2026-06-10
- **Context:** closes the named follow-up from [ADR 0007](./0007-preact-compat-client-alias.md). ADR 0007 added an opt-in `react`→`preact/compat` alias for the **client** island bundle and proved it shrank `/client.js` ~92% — but only for **deferred (`ssr: false`)** islands, which mount fresh with `createRoot` against a placeholder shell and so have no server markup to hydrate against. `ssr: true` islands were explicitly left unsafe under the alias because the **server** still rendered on real React: Preact's `hydrateRoot` would try to adopt markup produced by `react-dom/server`, and the two renderers' output does not match. This ADR records the seam that lets the server render in the same dialect the client hydrates in.
- **Relates to:** ADR 0007 (the client alias whose `ssr: true` gap this closes); `@keel/ui`'s `render.tsx` (`renderPageMarkup`) and `hydrate.tsx`'s existing injectable `mount` seam, which this mirrors.
- **Scope note:** this is a `@keel/ui` **capability** plus an end-to-end proof, not an app change. No example was rewired — estate has no `ssr: true` island (its lone `Account` island is deferred and already correct under the client-only alias), so there was nothing to switch. The remaining step to "Preact by default" — an app picking the matching server+client dialect — is documented under "Consequences" but deliberately not taken here.

## Context

Keel SSRs every page through `@keel/ui`'s `renderPageMarkup`, and the dialect was hard-wired: `render.tsx` imported `renderToString`/`renderToStaticMarkup` straight from `react-dom/server`. That was fine while the client was also React — server and client spoke the same dialect, so `ssr: true` islands hydrated cleanly.

ADR 0007 broke that symmetry on the client side only. With the `react`→`preact/compat` alias on, the browser hydrates with **Preact's** `hydrateRoot`, but the server markup it adopts was still emitted by **React's** `react-dom/server`. That is safe for a *deferred* island — its shell holds only a fallback the client throws away and re-mounts fresh — but it is a latent mismatch for an `ssr: true` island, whose whole point is that the client *reuses* the server DOM rather than re-rendering it.

The mismatch is not hypothetical and it is not cosmetic. `hydrateRoot` pairs the server tree to the client tree by walking the text-segment comment markers (`<!-- -->`) React emits between adjacent text children. React and Preact delimit those segments **differently** — Preact does not emit React's markers at all. So the instant a component renders two or more adjacent text segments under one parent (the everyday interpolated-text shape, `'Hi, ', name`), Preact's hydration finds markup it did not produce, fires `onRecoverableError`, and re-renders the whole island — defeating `ssr: true` entirely. The single-text-child case happens to survive, which is exactly the trap: the common shape is the broken one, so this would pass a trivial smoke test and fail in production.

The fix is not to reconcile two renderers' output. It is to **render the server in the same dialect the client hydrates in.** A Preact client wants Preact-emitted server markup; a React client wants React's. The dialect choice has to be a per-page decision the caller makes — the same caller that decided to ship a Preact client bundle in the first place — not a global the engine reaches for.

## Decision

Make `@keel/ui`'s server renderer **pluggable** behind an injectable `ServerRenderer` seam, defaulting to real `react-dom/server` so every existing caller is byte-for-byte unchanged, and ship a `preact-render-to-string` adapter behind a subpath so a Preact-client app can render its server markup in Preact too.

The mechanism, precisely as implemented:

### 1. A `ServerRenderer` seam in `render.tsx`, defaulting to React

`render.tsx` now declares the seam and the default:

```ts
export interface ServerRenderer {
  renderToString(node: ReactElement): string;
  renderToStaticMarkup(node: ReactElement): string;
}

export const reactServerRenderer: ServerRenderer = { renderToStaticMarkup, renderToString };
```

The interface is the **same two-function surface** `react-dom/server` exposes, narrowed to exactly what this module calls — so the default (`reactServerRenderer`) is a thin pass-through, not a translation layer. `renderPageMarkup` gained an optional second argument:

```ts
export function renderPageMarkup(page: Page, renderer: ServerRenderer = reactServerRenderer): string
```

Its mechanical rule is unchanged: **if any island in the manifest is `ssr: true`, the body is rendered with `renderToString`** (to keep the hydration markers the client needs); otherwise `renderToStaticMarkup` (smaller, marker-free, for shells that are mounted fresh and never hydrated). `renderPageMarkup` now just calls *through* the injected renderer instead of reaching for `react-dom/server` directly. No other `render.tsx` surface changed — `renderPage` and `buildIsland` are untouched, because an `ssr: true` island's real output is already placed **lazily** (`createElement`, not an eager call) and only walked when the chosen server renderer renders the tree at `renderPageMarkup` time. The dialect choice therefore lives entirely in `renderPageMarkup`; everything upstream is dialect-agnostic by construction.

This deliberately mirrors `hydrate.tsx`'s injectable `mount` seam: the piece that varies by runtime is **injected, never a global**. Both halves of the hydration contract — what the server emits and how the client mounts — are now chosen by the same explicit, visible decision rather than by what a barrel import happens to resolve to.

### 2. The Preact adapter lives in a new subpath-only module (`server-preact.ts`)

`src/server-preact.ts` is the adapter half — `preactServerRenderer`, backed by `preact-render-to-string@6`, forwarding `renderToString`/`renderToStaticMarkup` one-to-one. `preact-render-to-string` mirrors `react-dom/server`'s exact two entry points, so the adapter is a direct binding, not a shim. It is the **only** module that imports `preact-render-to-string`, and it is **not** re-exported from `index.ts` — so the core barrel never pulls Preact's renderer into a default (React) build. An adopter reaches for it explicitly: `import { preactServerRenderer } from "@keel/ui/server-preact"`.

The adapter carries one honest cost named in its prose: an `as` cast at the call boundary. `@keel/ui` builds its tree with React's `createElement`, and under the `preact/compat` alias those calls resolve to Preact vnodes at runtime — so the node arrives typed as `ReactElement` but *is* a Preact vnode wherever this adapter is meaningfully wired. The cast names that bridge rather than widening either library's public types.

### 3. Packaging: subpath export + optional peer dependency

`package.json` adds the `./server-preact` subpath export and lists `preact-render-to-string` as an **optional peer dependency** (`peerDependenciesMeta.optional: true`). So `@keel/ui`'s core stays dialect-agnostic with no heavy hard runtime dependency: a default React server importer drags in nothing new, and `preact-render-to-string` need only be present when an adopter actually imports `@keel/ui/server-preact`. `index.ts` exports `reactServerRenderer` and the `ServerRenderer` type; `server-preact` stays subpath-only.

### Why dialect-matching is the fix (and the only honest one)

The mismatch is a property of the *output*, not the *engine*. Two correct renderers that emit different bytes cannot be made to agree by patching one of them — the only fix that does not lie is to have both sides speak the same dialect. So the seam does not try to normalize React and Preact markup; it lets the caller pick the renderer whose output its client will hydrate against. A Preact-client page passes `preactServerRenderer`; the server then emits Preact's markup, the Preact client `hydrateRoot`s markup it recognizes, and the interpolated-text trap simply does not arise.

## What this is and isn't

- **Is:** an injectable `ServerRenderer` seam on `renderPageMarkup` (default `reactServerRenderer`, real `react-dom/server`), plus a `preactServerRenderer` adapter shipped from the new `@keel/ui/server-preact` subpath, with `preact-render-to-string` as an **optional** peer dependency. It closes ADR 0007's named `ssr: true` follow-up: a Preact-client app can now render its server markup in Preact so `ssr: true` islands hydrate without mismatch. Proven end-to-end by `server-preact.test.tsx`.
- **Isn't:** a change to the **default** build — with no `renderer` argument the bytes and behavior are exactly as before, real React on both the buffered and stream paths. It is **not** a server-renderer swap forced on anyone, **not** a per-call way to make the *engine* itself Preact (that needs build-time `react`→`preact/compat` aliasing of the whole module graph, not an injected function), and **not** an estate change — estate has no `ssr: true` island, so nothing was rewired. "Preact by default" is still unbuilt: it requires an app to choose the matching server+client dialect itself (see Consequences).

## A note on the proof test

`server-preact.test.tsx` proves the seam end-to-end, but it does **not** drive `@keel/ui`'s engine under a Preact-aliased module graph — making the engine Preact requires build-time aliasing of `react`→`preact/compat` across the whole graph (not a per-call choice), which a single vitest file cannot do honestly. Instead it reconstructs the exact island shell `buildIsland` emits, with each dialect's own `createElement`, and feeds it through the **real** `renderPageMarkup` and the **real** `preactServerRenderer`. So the seam — the injected renderer and `renderPageMarkup`'s marker rule — is exercised verbatim, even though the upstream tree-build is reconstructed rather than driven. A future integration test under a Preact-aliased vitest project could drive the full engine; that is a larger setup, called out so the proof's boundary is not mistaken for the seam's.

## Consequences

- A Preact-client app (the opt-in `react`→`preact/compat` client alias from ADR 0007, e.g. `examples/estate/build-client.ts --preact`) that wants `ssr: true` islands must now **also** pass `preactServerRenderer` to `renderPageMarkup`, so server and client dialects match. The two halves are a matched pair: pick one renderer for the server and the matching alias for the client, together. Pass only one and `ssr: true` mismatches exactly as before — this seam makes the right choice *possible*, it does not make a half-configured app safe.
- Deferred (`ssr: false`) islands remain safe under the client-only alias with **no** server change, exactly as ADR 0007 shipped them — their shells are replaced wholesale, so the server dialect is irrelevant to them. The new requirement applies only to `ssr: true` islands.
- The default path is untouched and remains the safe, supported build: `renderPageMarkup` with no renderer is real `react-dom/server`, and a default React importer of `@keel/ui` pulls in nothing new. `preact-render-to-string` loads only when `@keel/ui/server-preact` is imported.
- The remaining gap to **"Preact by default"** is no longer in `@keel/ui` — the engine now supports both dialects on both sides. What is left is an *application* decision: an app must select the matching pair (the `--preact` client alias **and** `preactServerRenderer` for its server render) and accept ADR 0007's standing correctness traps (`react-aria`-class library breakage under compat; dev/prod alias divergence). Keel does not flip that switch for anyone; the seam keeps the choice explicit and per-app, mirroring why the client alias itself is opt-in.
- **Companion `@keel/ui` change (separate concern, recorded for the integrator):** alongside this seam, `@keel/ui` gained opt-in **visible (lazy) island hydration**, mirroring how `ssr` already threads a per-component flag onto the wire. `ClientComponentDef` gained `hydrate?: HydrationStrategy` (`"load" | "visible"`, default `"load"`) and `IslandMount` gained `strategy?: HydrationStrategy`, emitted by `buildIsland` **only** for `"visible"` (omitted for the default so existing manifests, their serialized `<script>` bytes, and the tests pinning them are byte-for-byte unchanged). `hydrateIslands` gained an injectable `observe?: ObserveFn` seam (`(container, onVisible) => Disconnect`, defaulting to an `IntersectionObserver` wrapper — the same injection style as `mount`) and a `HydrationResult.deferred: string[]` for visible islands found-but-not-yet-mounted (distinct from `mounted`/`missing`/`failed`, none of which is truthful for a region whose shell is present but whose work was deliberately postponed). A `"visible"` island defers its **mount work** — its render, effects, and any on-mount fetch (e.g. the Account island's `/mls/api/session` call) — until the region first scrolls into view, via the same `mountOne` helper the eager path uses, so deferred mounts inherit identical `onMountError`/`failed` resilience; their later success/failure is reflected by mutating the caller-held result arrays. The runtime owns the one-shot guard and calls the returned `Disconnect` after mount, so an injected `ObserveFn` need not self-disconnect. It does **not** defer bundle **bytes**: Keel ships one `client.js`, so the code already arrived; `"visible"` only postpones running it. True byte/code deferral needs per-island code-splitting — a separate, larger follow-up, not claimed here. This change is additive and independent of the server-renderer seam, but worth recording because it extends the same hydration contract and threads a per-component flag onto the wire the same way `ssr` does.
