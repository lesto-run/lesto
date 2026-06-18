# ADR 0012 — The canonical island: server-rendered, with inline data

- **Status:** Accepted — decision + design (2026-06-11). Implementation is sequenced in `docs/plans/island-data-hardening.md` (items 7–11). Supersedes the delivery-tier defaults of ADR 0010 §3 on dynamic topology; amends ADR 0011's `ssr: true` matrix row.
- **Date:** 2026-06-11
- **Context:** a senior architecture review (Solid creator's lens) of the islands/data/pipeline work. Its #1 recommendation: *invert the island default*. Today the DEFAULT island is a fallback shell + a fresh `createRoot` re-render — CSR-in-a-box, where the server's render contributes nothing the client keeps. The actual islands story — server-rendered content the client *hydrates and keeps* — is `ssr: true`: opt-in, taxed (the author must hand-guarantee server/client prop equality), partly unsupported (`ssr: true` + `data` is a guaranteed hydration mismatch with no guard — review finding F1), and fed by a dynamic-data tier (`resolveIslandData`) that was exported and called by nothing.
- **Relates to:** ADR 0008 (matched renderer dialects — the precondition for ssr islands under preact), ADR 0009 (eager/lazy union — `ssr: true` requires the eager form), ADR 0010 (data sources — this ADR re-aims its delivery tiers), ADR 0011 (this ADR amends its matrix and pulls its Increment-4 inline tier forward).

## The decision: invert, phased — invert the canon and the machinery now; keep the `ssr` boolean explicit

We **adopt the inversion**. The canonical Volo island — what the docs teach, what the blog proof demonstrates, what `create-volo` will scaffold — becomes:

```tsx
// app/islands/reactions.tsx — the canonical island
export default defineIsland({
  name: "Reactions",
  component: Reactions,          // eager: the server holds it (ADR 0009)
  ssr: true,                     // server-render the REAL output; client hydrates and keeps it
  data: { counts: reactionsSource }, // per-request data, resolved AT RENDER and inlined
});
```

On a dynamically rendered page (`volo().page(...)`, any per-request render), the framework:

1. runs each bound source's registered loader **during the render** (one run per distinct source per request, memoized — the parallel-batch/no-chaining semantics of ADR 0010 §2 are preserved exactly);
2. renders the island's real component **with the resolved values merged into its props** — the server markup is the per-user truth, no fallback flash;
3. emits the mount script with the values **inlined into `props` and no `bind`** — zero extra requests;
4. the client `hydrateRoot`s the shell with byte-identical props (they crossed the wire through the one audited JSON seam), so hydration succeeds *by construction*: both sides rendered the same pure function over the same JSON.

The **primer is demoted, not deprecated**: it is the cache-split fallback — the delivery the framework selects automatically when no render-time resolver is in scope (a static build, a prerender, any shared-cacheable document). On that topology it remains *correct and unbeatable*: a shared-cached document cannot carry per-user bytes (ADR 0010 §4, truth #1), so the parallel 1-RTT fetch is the floor. Delivery stays topology-derived and author-invisible; what changes is which tier is the blessed, taught, scaffolded one.

### What "invert" does NOT mean: the `ssr` boolean does not flip silently

The runtime default for an island that declares nothing stays `ssr: false`. Three reasons, each load-bearing:

1. **ADR 0011's own rule: defaults choose mechanisms, never meanings.** `ssr: true` runs the *author's component on the server*. An existing `ssr: false` island is allowed to close over browser globals at render (`window`, `matchMedia`); silently flipping it from "runs only in the browser" to "runs on the server first" is a prod-only ambush, the exact failure mode the matrix forbids.
2. **The dialect pairing (ADR 0008).** An `ssr: true` island demands the server renderer match the client bundle's dialect and forces `renderToString`'s hydration markers. That pairing is configured; a silent flip would activate it unconfigured.
3. **The residual promise is real, just small.** With data inlined, server/client prop equality is guaranteed — but render *purity* (no `Date.now()`, no `Math.random()`, no locale-dependent formatting) is still the author's promise. It stays a visible line until the dev double-render mismatch diff (Phase C) makes a broken promise loud in development.

So the inversion is delivered as: **the machinery lands now and removes the tax; the recommendation, examples, and scaffold flip to the canonical form; the boolean stays a declaration.** "Canonical" means it is the form with the best behavior and the least ceremony — one extra word (`ssr: true`) buys keep-the-server-markup — not that the framework assumes it.

## Phases

- **Phase A (now — `docs/plans/island-data-hardening.md` items 7–11):** the render-time resolver; `ssr + data` becomes the supported canonical combination on dynamic pages; emission-time guard everywhere else; blog ships the proof; `volo().client()` head module tag; CLI→`@volo/assets` wiring.
- **Phase B (estate convergence — ADR 0011 Increment 2):** estate's `.page` migration adopts the canonical island where its topology is dynamic; the marketing zone **stays on the primer on purpose** (see "What this does to estate").
- **Phase C (future, explicitly deferred):** the dev double-render mismatch diff (render the island twice in dev, diff the markup, overlay the divergence). Only after it exists do we *consider* defaulting `ssr: true` for eager + `data` islands, and only as a scaffold/config default — never an ambient flip for existing apps. Also deferred: the `TriggerFn` generalization of the hydration-strategy vocabulary, and the CSP-nonce seam for inline scripts.

## Mechanism: a render-time resolver replaces (and deletes) `resolveIslandData`

`resolveIslandData(manifest, resolve)` — ADR 0010's 0-RTT tier — mutated the manifest *after* the render walk. That shape can inline props for a *deferred* island (the client mounts fresh with full props), but it arrives **too late to feed an `ssr: true` island's server markup**, which is rendered during the walk. It structurally cannot serve the canonical island, and it shipped with no caller. It is **deleted** (pre-1.0; no consumer exists) in favor of:

```tsx
// @volo/ui (server): packages/ui/src/data-resolve.tsx (new)
export interface SourceResolver {
  /** Resolve a source by name; memoized — one loader run per source per request. */
  resolve(source: string): Promise<unknown>;
}
export function createSourceResolver(
  load: (source: string) => Promise<unknown> | unknown,
): SourceResolver;
export const IslandDataProvider: FC<{ resolver: SourceResolver; children: ReactNode }>;
```

- `defineIsland`'s component reads the context. **Resolver present** (dynamic render): each bound source is resolved via React's `use()` (the render suspends; `renderPageStream`'s Suspense plumbing and 10s deadline already own that), values merge into the mount's props, `bind` is omitted, and an `ssr: true` island renders its real component **with** the data. **Resolver absent** (static emission): today's behavior — `bind` + primer — for deferred islands, and a **loud refusal** (`UI_ISLAND_SSR_DATA_UNRESOLVED`) for `ssr: true` + `data`, because that configuration on a shared-cacheable document is per-user bytes in a shared cache: impossible, not inconvenient. A static build containing it fails the build; it does not ship a guaranteed mismatch.
- `volo().data(source, loader)` keeps registering the `/__volo/data/<name>` route (the primer/fallback tier and `visible` islands still need it) **and** records the loader in a name→loader map. `renderPageResponse` builds a per-request memoized resolver over that map and wraps the page tree in `IslandDataProvider`. `.route()` merges a sub-app's loader map (sources must be registered effectively at the root — ADR 0010 corrections #8).
- Loader semantics are unchanged: a loader receives only the request context, never another source's value — chaining still has no API to exist through. Memoization replaces the "one parallel batch" with "one run per source, started on first use, shared by every island" — the same dedupe guarantee, now compatible with streaming.

## What this does to estate

- **The marketing zone does not move.** `/` and `/about` are prerendered, CDN-cached, zero-Worker-invocation for anonymous visitors. The Account island stays `ssr: false` + `bind` + primer — on this topology that *is* the canonical form; ADR 0010 §4's truths are untouched. No estate code changes from the inversion itself (estate picks up the bug fixes: guarded/ok-checked primer via the shared `dataPrimerScript`, and the head placement fix in `document.ts`).
- **The dynamic `/mls` zone** has no data-bound island today (its auth control, `SignInPanel`, is a server component fed by the route handler — already 0-RTT, already correct). When estate converges on `.page` (ADR 0011 Increment 2), any island it grows on dynamic routes adopts the canonical form. The Registry/`renderDocument` walk does **not** gain a resolver seam now — it would be a third data path with no consumer; if estate's convergence needs it, that is a one-page follow-up.
- **The wire is untouched.** `IslandMount`, `bind`, the primer contract, `hydrateIslands`/`hydrateDocumentIslands` all keep their shapes; the canonical island simply ships `props` complete and `bind` absent — a shape the client already handles (it is the "server-resolved" branch `IslandMount.bind`'s doc always promised).

## Consequences

- The "two kinds of island" story becomes honest and ordered: **canonical** (dynamic topology: server markup + inline data, hydrated and kept) and **cache-split** (static topology: fallback shell + primer-parallel data, mounted fresh) — and the framework, not the author, picks per topology. The author's only choices remain the meanings: which component, which data, `ssr`'s purity promise, `hydrate: "visible"`.
- `examples/blog` becomes the canonical proof (plan item 11): a data-bound `ssr: true` island on `/posts` with inline data, a ~10 KB client, zero bespoke scripts — ADR 0011 Increment 1's exit criterion, now demonstrating the *inverted* default.
- F1's interim define-time refusal (`UI_CLIENT_SSR_DATA_UNSUPPORTED`) is shipped first as a bug fix and **removed** when the resolver lands; the permanent invariant is emission-time (`UI_ISLAND_SSR_DATA_UNRESOLVED`), where topology is actually known.
- `defineIsland` gains real prop typing (review F8): generic over the component's props, with `data` typed as `{ [K in keyof P]?: DataSource<P[K]> }` and the returned island component accepting the non-bound remainder — the token's phantom type finally reaches the component. `Registry.defineClient` typing is deferred to estate's convergence (its storage is erased `Map`s; generics there are cosmetic until the registry path is migrated or retired).
- Risks accepted: render-time loaders put data latency inside the streamed render (bounded by the existing 10s deadline, surfaced per-island by Suspense rather than blocking TTFB); `use()` ties the resolver to React 19 semantics (already Volo's floor); deleting `resolveIslandData` breaks no one (zero callers, pre-1.0).
