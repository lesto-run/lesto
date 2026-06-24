# ADR 0010 — Island data sources (data arrives with the document)

- **Status:** Accepted — Phase 1 (declarative API + parallel-primer default + estate migration), **corrected 2026-06-11** (see "Corrections & amendments" below). The headline correction: the dynamic 0-RTT tier in §3 was *exported but never wired* — `resolveIslandData` had no caller, so every page today delivers data via the primer. The dynamic tier is now owned by **ADR 0012** (a render-time resolver that supersedes and deletes `resolveIslandData`), and the hardening work is sequenced in `docs/plans/island-data-hardening.md`. Edge-SSR / cookie-gated dynamic personalization remains a documented follow-up (Phase 2), not built here.
- **Date:** 2026-06-11
- **Context:** estate — the *simplest possible* Lesto app — shipped a textbook request waterfall: `document → /client.js → mount → useEffect(fetch /mls/api/session) → re-render`. Nothing in the framework caused it, and that is precisely the indictment. Lesto offered an island primitive but **no data-loading surface at all**, so an author's path of least resistance was a hand-rolled `useEffect(fetch)` — and the easy path was the slow path. This is the Next.js trap ("render trees so complex that footguns like request waterfalls are impossible to avoid") arriving on day one of the simplest app. The mandate: make a waterfall something you have to go *out of your way* to write.
- **Relates to:** ADR 0008 (`ssr: true` islands), ADR 0009 (eager/lazy `load:` islands). This composes with both; it neither replaces nor conflicts with them.
- **Informed by:** two independent Fable-model advisors — one designing the author API, one (the skeptic) pressure-testing the edge/caching mechanics. Their disagreement set the delivery default (see §4).

## Decision

### 1. The author declares data; the framework owns delivery

Three pieces. A typed, **implementation-free token** is shared between server and client; the server binds an implementation to it; an island binds a prop to the token. The component becomes a **pure function of its props** — there is no fetch site in it to waterfall through.

```ts
// data/session.ts — shared module: a NAME and a TYPE, zero implementation.
// (Implementation-free so importing it from the client bundle drags in no server code.)
export const sessionSource = defineDataSource<User | null>("session");
```

```ts
// server only — bind the implementation to the token on the lesto() app.
lesto().data(sessionSource, async (c) => {
  const user = await currentUser(c);            // estate: SignedSessions.verify — pure HMAC, no I/O
  return user === undefined ? null : { id: user.email, name: displayNameFor(user.email) };
});
// The framework auto-exposes every registered source at GET /__lesto/data/<name>.
// The hand-written /mls/api/session route is deleted.
```

```tsx
// registry — the island binds a prop name to a source token (typechecks the component's props).
.defineClient({
  name: "Account",
  component: Account,
  fallback: AccountFallback,
  data: { session: sessionSource },
})
```

```tsx
// account.tsx — the whole island. No useState, no useEffect, no session-client.ts.
export function Account({ session }: { session: User | null }): ReactElement {
  return session === null
    ? <a className="account account--out" href="/mls">Sign in</a>
    : <span className="account account--in">Hi, {session.name} · <a href="/mls/saved">Saved</a></span>;
}
```

The three-state `loading | out | in` union becomes **unrepresentable**: data is present when the component mounts, and the pre-data state is the `fallback` shell the framework already owns.

### 2. Why a waterfall is structurally impossible on the common path

1. **No author-side fetch site exists.** The component receives data as a prop; the loading state is not expressible in its types. To fetch client-side you must hand-write an effect — strictly *more* code than `data: { session: sessionSource }`.
2. **Loaders cannot chain.** A source loader receives only the request context — never another source's output — and the framework runs a page's full set in one parallel batch. An inter-loader waterfall has no API through which to exist (Remix's parallel-loaders discipline).
3. **Delivery is topology-derived, not authored.** The author has no surface with which to sequence requests; there is nothing to misuse. See §3.

### 3. Delivery tiers — chosen by the framework, never by the author

| Topology | Delivery | Extra cost |
|---|---|---|
| Dynamically rendered (per-request `.page` render / `renderDocument` / dev server) | loaders run at render with the request context; resolved values inlined straight into the island's props, `bind` omitted. **Correction 2026-06-11: this tier was designed here but never wired** — `resolveIslandData` shipped as a dead export. It is superseded by **ADR 0012**'s render-time resolver (`IslandDataProvider`), which — unlike the post-walk manifest mutation `resolveIslandData` was — resolves *during* the render, so it can also feed an `ssr: true` island's server markup, the canonical-island prize. `resolveIslandData` is deleted. | **0 extra requests** |
| Static / prerendered + a server in the path (estate's marketing zone) — **what actually shipped, and the only tier wired today** | the document carries an unresolved **`bind`** plus an inline **primer** (`w[name] = w[name] \|\| fetch("/__lesto/data/<name>", { credentials: "same-origin" }).then(ok-checked json)` on `window.__lestoData`, guarded so two islands sharing a source fetch once) emitted in `<head>` *before* the module script; `hydrateIslands` awaits the primed promise and mounts with the value. Islands with `hydrate: "visible"` are **excluded** from the primer — their bind is fetched on first intersection, or the whole point of "visible" is defeated. | **1 RTT, parallel** — the data request starts at HTML-parse, concurrent with `client.js`; collapses `doc → js → fetch` (3 serial) to `doc → max(js, fetch)`. One fully CDN-cacheable artifact; portable to node, Workers, and any dumb CDN; *cannot* be misconfigured into cache poisoning |
| Static, authed-first-paint-matters (Phase 2, deferred) | cookie-gated edge SSR: anonymous → pristine cached shell; authed → per-request render with an `ssr: true` island | flicker-free authed paint; ~free for a stateless signed-token session, but adds session-resolution latency to TTFB for an I/O-backed one |

The **default is the parallel primer**, not edge prop-injection. The skeptic proved why: estate's island is `ssr: false`, so the server markup *is* the fallback until hydrate — rewriting serialized props at the edge changes nothing visible, while forfeiting the zero-Worker-invocation anonymous path. The primer is the honest default: it fixes the network-dependency chain framework-wide, portably, safely. It does **not** remove the fallback→live repaint (that needs per-request *markup* — Phase 2). We do not pretend otherwise.

> **Amendment (2026-06-11, ADR 0012):** "default" above is scoped to the *static* topology, where it remains correct and is not deprecated. On a **dynamically rendered** page the canonical island is now `ssr: true` + `data` with the loader values resolved at render and inlined — no fallback flash, no extra RTT, server markup kept. The primer is the cache-split fallback the framework selects automatically when no render-time resolver is in scope (a prerender, a static build). Delivery stays topology-derived; only the blessed tier changed.

### 3a. Data source scope — `private` by default (adopted from ADR 0011's matrix)

`defineDataSource` accepts a second argument: `defineDataSource<T>(name, { scope: "private" | "shared" })`, defaulting to **`"private"`**. Scope is a *meaning* only the author can know (is this value per-user or the same for everyone?), so it follows ADR 0011's rule: one cheap visible line, with the dangerous configuration unrepresentable by default.

**The cache-header rule for the auto-exposed `GET /__lesto/data/<name>` route** (binding on `lesto().data()` and any future transport):

- `scope: "private"` (the default) → the response carries **`Cache-Control: private, no-store`**. A per-user JSON GET with no cache header is heuristically shared-cacheable — a session leak waiting for a CDN. The framework never emits that configuration.
- `scope: "shared"` → the response carries **`Cache-Control: public, max-age=0, must-revalidate`** — explicitly cacheable but always revalidated. The framework sets no TTL it cannot know; an author who wants one overrides the route deliberately.
- A `private` source is **refused** (coded error, not a warning) anywhere the framework would inline its value into a document it knows to be shared-cacheable (the static build). On the dynamic tier the document is per-request, so inlining a private value is correct — provided the *page response* itself is not cached; that remains rule §5.3.

### 4. The irreducible truths (stated, not hidden — this is what "foolproof" demands)

1. **A shared-cached document cannot carry per-user bytes.** Per-user bytes require per-user compute *somewhere* on the path; you only choose *where*. After the document (client fetch) keeps TTFB CDN-fast and lands personalization one RTT later; before first byte (edge SSR) puts the data in the document but adds resolution latency to every authed response's TTFB. estate's stateless signed token is what makes the "before" path cheap — that is a **precondition**, not the general case.
2. **The no-extra-compute floor is one parallel RTT, not zero.** The primer makes it concurrent with JS; it does not make it free.
3. **`fetch` cannot be banned.** A hand-written `useEffect(fetch)` inside an island is still possible. Mitigation: the default is *less* code, plus (future) a lint rule flagging fetch-in-effect inside a `defineClient` component. This is the residual footgun every framework carries.

### 5. Security rules (binding on any current/future delivery tier)

- All injected/serialized data goes through `@lesto/ui`'s `serializeManifest` escaping (script-context-safe: `<`, `>`, `&`, U+2028/9), emitted only as `type="application/json"` and revived with `JSON.parse`. Never an executable inline script carrying user data. estate's duplicate `safeJson` is retired in favor of the shared seam.
- **Allowlisted DTO only** — a loader returns `{ id, name }`, never the session token, the raw cookie, or a spread of the session object.
- A personalized response (Phase 2) is `Cache-Control: private, no-store` **with its asset ETag/Last-Modified stripped** (or a post-login 304 re-serves the anonymous document), and is **never** written to a shared cache. `Vary: Cookie` is *not honored* by Cloudflare's cache, so "do not cache" — not a cache key — is the only defense.
- **Fail open to anonymous:** a malformed/forged cookie resolves to the source's anonymous value, never an error or another identity.
- Precondition for Phase 2: estate's `POST /mls/api/sign-in?as=<id>` mints a signed session for any id with no credential check — that hole must be closed before any cookie-gated personalization ships on top of it.

### 5a. A `private` source is guarded by default — the auto-route bypass is closed at registration (2026-06-24)

A `.data()` source registers as its OWN route `GET /__lesto/data/<name>`, separate from any page. A page's file-route `middleware.ts` guard composes only into the page document's GET chain — it never reaches the data route. So an island binding a `scope: "private"` source on a guarded page would fetch the per-user data (the data most worth protecting) over the *least*-protected route: a developer writes an auth `middleware.ts`, believes the page is locked down, and ships a data leak. Auto-propagation was considered and rejected — islands bind sources by NAME at render time, so there is no static page→source map to propagate a page's `middlewareDepth` from, and the framework cannot distinguish a request-scoped loader (returns only the caller's own data) from one that needs an auth guard.

The rule, therefore: **`lesto().data(source, loader)` refuses a `scope: "private"` source registered with no guards** — a coded `WEB_PRIVATE_DATA_UNGUARDED` thrown at registration, before any request, so the dangerous fail-open configuration is unrepresentable by omission (the same posture §3a takes on the cache header). Two ways to satisfy it, each a visible decision rather than a silent default:

- **pass a guard chain** — `.data(source, loader, guards)` takes the same `Handler` chain `.page()` does; pass the page's `middleware.ts` guard(s) so the data route enforces the identical gate; or
- **declare the source request-scoped** — `defineDataSource(name, { access: "request-scoped" })` is the explicit opt-out asserting the loader derives its result solely from the caller's own request (cookie/session/params), so an unguarded route leaks nothing across users — the canonical "who am I" session source.

App-level `.use()` middleware does NOT exempt the source: it is global, ordering-dependent, and may not be a guard at all, so it cannot stand in for the explicit per-source decision. A `scope: "shared"` source is publicly cacheable by construction (§3a) and is never guarded on these grounds. This is a breaking change (pre-1.0 minor); it closes the red-team review's highest-priority finding.

## Consequences

- **Extends, never replaces.** `island()` + static props are untouched; `data` is an optional field on `ClientComponentDef`; the manifest gains an optional `bind` field, absent unless used — the same byte-for-byte-stable rule ADR 0009 applied to `strategy`, so every existing manifest, serialized payload, and shape-pinning test reads unchanged.
- **Composes with 0008/0009.** A dynamically-rendered `ssr: true` island with `data` paints personalized with no fallback flash (the full prize — *originally slated for Phase 2; pulled forward as the canonical island by ADR 0012*). A lazy (`load:`) island with a `bind` kicks its chunk fetch and its data fetch in parallel and mounts when both land — 0009's lesson applied in reverse. A `hydrate: "visible"` bind is primed/fetched on first intersection, not on load.
- **Phase 1 scope:** the primitives (`@lesto/ui`), `.data()` + the auto-route (`@lesto/web`), and estate's marketing Account migrated to the primer default — deleting `session-client.ts`, the `/mls/api/session` route, and the island's effect. The `.page` renderer does not yet emit islands (that is the routing migration's Phase 4), so page-level data resolution rides in when islands-through-pages lands.
- **Lineage:** Remix's parallel loader semantics + Qwik's state-in-the-document delivery + Astro's island granularity, carried on Lesto's existing serialized-props channel — explicitly rejecting RSC's "any node may await" model as the very thing that makes Next's waterfalls unavoidable.

## Corrections & amendments (2026-06-11)

A senior architecture review cross-checked this ADR against the shipped code. What it found, and what this document now reflects (fixes are sequenced in `docs/plans/island-data-hardening.md`; the strategic re-aim is **ADR 0012**):

1. **The dynamic tier was aspirational.** `resolveIslandData` (packages/ui/src/data.ts) was exported and called by nothing — every island today is delivered by the primer, including on dynamically rendered pages where the document could have carried the data. Worse, its shape (mutate the manifest *after* the render walk) arrives too late to feed an `ssr: true` island's server markup, so it could never have served the canonical island. **Decision: superseded and deleted.** ADR 0012's render-time resolver (`IslandDataProvider` + a memoized per-request source resolver) replaces it.
2. **`ssr: true` + `data` was a guaranteed hydration mismatch with no guard.** `islandMount` happily emits `ssr: true` alongside `bind`; both server paths (`buildIsland`, `defineIsland`) render the real component *without* the bound props; the client hydrates with `{...props, ...data}` — mismatch every time. Interim fix: a define-time refusal (`UI_CLIENT_SSR_DATA_UNSUPPORTED`, mirroring `UI_CLIENT_SSR_NEEDS_COMPONENT`); final state per ADR 0012: the combination is *the canonical island* on the dynamic tier, and an emission-time guard (`UI_ISLAND_SSR_DATA_UNRESOLVED`) refuses it where no resolver is in scope.
3. **The primer shipped unguarded and un-checked.** It assigned `w[name] = fetch(...)` (not `w[name] = w[name] || fetch(...)` — two islands binding one source means duplicate credentialed fetches), and neither it nor the client fallback fetch checked `response.ok` — a 401/429 JSON error body became the island's prop value. Both fixed; §3's snippet now shows the real contract.
4. **`hydrate: "visible"` binds were primed at parse time anyway** (`distinctSources` had no strategy filter), contradicting §Consequences ("primed/fetched on first intersection, not on load"). Fixed: visible islands are excluded from the primer; their bind resolves on intersection via the existing fallback fetch.
5. **The auto-route set no cache headers.** `lesto().data()` returned `c.json(...)` with only a content-type — per-user JSON, heuristically cacheable. Fixed by the §3a scope + cache-header rule.
6. **Estate emitted the primer at end-of-body** — after the entire HTML had parsed, surrendering most of the parallelism the primer exists for. Fixed: primer (and the module script) belong in `<head>`.
7. **No deadline on bind resolution.** A hung `/__lesto/data/<name>` left its island `deferred` forever (contrast the 10s stream deadline). Fixed: bind resolution races a 10s timeout (`UI_ISLAND_DATA_TIMEOUT`) and routes to `onMountError`/`failed`.
8. **Known limitation (documented, not fixed):** `.data()` registered on a sub-app mounted under a `.route(prefix, …)` prefix gets its *route* prefixed but its `bind.href` still points at the root `/__lesto/data/<name>` — register sources on the root app. A prefix-aware href is future work.
9. **Future seams noted, deliberately deferred:** a CSP nonce seam for the inline primer (no Lesto serving path enforces a CSP today; `RECOMMENDED_CSP` in `@lesto/web/harden` is opt-in), and generalizing `ObserveFn` to a `TriggerFn` so the hydration-strategy vocabulary can grow beyond `"load" | "visible"` (e.g. `"idle"`, `"media"`).

What the review **validated** (unchanged): the implementation-free token design, the parallel-batch/no-chaining loader semantics, the `serializeScriptJson` discipline, and §4's irreducible truths.
