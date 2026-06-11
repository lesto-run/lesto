# ADR 0010 — Island data sources (data arrives with the document)

- **Status:** Accepted — Phase 1 (declarative API + parallel-primer default + estate migration). Edge-SSR / cookie-gated dynamic personalization is a documented follow-up (Phase 2), not built here.
- **Date:** 2026-06-11
- **Context:** estate — the *simplest possible* Keel app — shipped a textbook request waterfall: `document → /client.js → mount → useEffect(fetch /mls/api/session) → re-render`. Nothing in the framework caused it, and that is precisely the indictment. Keel offered an island primitive but **no data-loading surface at all**, so an author's path of least resistance was a hand-rolled `useEffect(fetch)` — and the easy path was the slow path. This is the Next.js trap ("render trees so complex that footguns like request waterfalls are impossible to avoid") arriving on day one of the simplest app. The mandate: make a waterfall something you have to go *out of your way* to write.
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
// server only — bind the implementation to the token on the keel() app.
keel().data(sessionSource, async (c) => {
  const user = await currentUser(c);            // estate: SignedSessions.verify — pure HMAC, no I/O
  return user === undefined ? null : { id: user.email, name: displayNameFor(user.email) };
});
// The framework auto-exposes every registered source at GET /__keel/data/<name>.
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
| Dynamically rendered (per-request `renderDocument`/dev server) | loaders run at render with the request context; resolved values inlined straight into the manifest props | **0 extra requests** |
| Static / prerendered + a server in the path (estate's marketing zone) — **the default this ADR ships** | the document carries an unresolved **`bind`** plus an inline **primer** (`window.__keel.<name> = fetch("/__keel/data/<name>", { credentials: "same-origin" })`) emitted *before* the module script; `hydrateIslands` awaits the primed promise and mounts with the value | **1 RTT, parallel** — the data request starts at HTML-parse, concurrent with `client.js`; collapses `doc → js → fetch` (3 serial) to `doc → max(js, fetch)`. One fully CDN-cacheable artifact; portable to node, Workers, and any dumb CDN; *cannot* be misconfigured into cache poisoning |
| Static, authed-first-paint-matters (Phase 2, deferred) | cookie-gated edge SSR: anonymous → pristine cached shell; authed → per-request render with an `ssr: true` island | flicker-free authed paint; ~free for a stateless signed-token session, but adds session-resolution latency to TTFB for an I/O-backed one |

The **default is the parallel primer**, not edge prop-injection. The skeptic proved why: estate's island is `ssr: false`, so the server markup *is* the fallback until hydrate — rewriting serialized props at the edge changes nothing visible, while forfeiting the zero-Worker-invocation anonymous path. The primer is the honest default: it fixes the network-dependency chain framework-wide, portably, safely. It does **not** remove the fallback→live repaint (that needs per-request *markup* — Phase 2). We do not pretend otherwise.

### 4. The irreducible truths (stated, not hidden — this is what "foolproof" demands)

1. **A shared-cached document cannot carry per-user bytes.** Per-user bytes require per-user compute *somewhere* on the path; you only choose *where*. After the document (client fetch) keeps TTFB CDN-fast and lands personalization one RTT later; before first byte (edge SSR) puts the data in the document but adds resolution latency to every authed response's TTFB. estate's stateless signed token is what makes the "before" path cheap — that is a **precondition**, not the general case.
2. **The no-extra-compute floor is one parallel RTT, not zero.** The primer makes it concurrent with JS; it does not make it free.
3. **`fetch` cannot be banned.** A hand-written `useEffect(fetch)` inside an island is still possible. Mitigation: the default is *less* code, plus (future) a lint rule flagging fetch-in-effect inside a `defineClient` component. This is the residual footgun every framework carries.

### 5. Security rules (binding on any current/future delivery tier)

- All injected/serialized data goes through `@keel/ui`'s `serializeManifest` escaping (script-context-safe: `<`, `>`, `&`, U+2028/9), emitted only as `type="application/json"` and revived with `JSON.parse`. Never an executable inline script carrying user data. estate's duplicate `safeJson` is retired in favor of the shared seam.
- **Allowlisted DTO only** — a loader returns `{ id, name }`, never the session token, the raw cookie, or a spread of the session object.
- A personalized response (Phase 2) is `Cache-Control: private, no-store` **with its asset ETag/Last-Modified stripped** (or a post-login 304 re-serves the anonymous document), and is **never** written to a shared cache. `Vary: Cookie` is *not honored* by Cloudflare's cache, so "do not cache" — not a cache key — is the only defense.
- **Fail open to anonymous:** a malformed/forged cookie resolves to the source's anonymous value, never an error or another identity.
- Precondition for Phase 2: estate's `POST /mls/api/sign-in?as=<id>` mints a signed session for any id with no credential check — that hole must be closed before any cookie-gated personalization ships on top of it.

## Consequences

- **Extends, never replaces.** `island()` + static props are untouched; `data` is an optional field on `ClientComponentDef`; the manifest gains an optional `bind` field, absent unless used — the same byte-for-byte-stable rule ADR 0009 applied to `strategy`, so every existing manifest, serialized payload, and shape-pinning test reads unchanged.
- **Composes with 0008/0009.** A dynamically-rendered `ssr: true` island with `data` paints personalized with no fallback flash (the full prize, Phase 2). A lazy (`load:`) island with a `bind` kicks its chunk fetch and its data fetch in parallel and mounts when both land — 0009's lesson applied in reverse. A `hydrate: "visible"` bind is primed/fetched on first intersection, not on load.
- **Phase 1 scope:** the primitives (`@keel/ui`), `.data()` + the auto-route (`@keel/web`), and estate's marketing Account migrated to the primer default — deleting `session-client.ts`, the `/mls/api/session` route, and the island's effect. The `.page` renderer does not yet emit islands (that is the routing migration's Phase 4), so page-level data resolution rides in when islands-through-pages lands.
- **Lineage:** Remix's parallel loader semantics + Qwik's state-in-the-document delivery + Astro's island granularity, carried on Keel's existing serialized-props channel — explicitly rejecting RSC's "any node may await" model as the very thing that makes Next's waterfalls unavoidable.
