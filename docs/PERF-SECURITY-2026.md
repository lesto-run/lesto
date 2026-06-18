# Volo — Performance & Security Landscape (mid-2026) and Native-Tools Plan

> Companion to `docs/ATTACK-PLAN-2026.md` and `docs/REVIEW-2026-06-09.md`. Goal: be the most
> performant and secure JS framework using **node/browser-native primitives** — minimal deps.
> Grounded in a five-stream landscape scan (server frameworks · React SSR · caching · local-first ·
> the PHP incumbents) + a code recon of Volo's current state.
>
> **Verification note:** the research agents cite sources, but the adversarial verification pass
> from the original run stalled and was not re-run. The time-sensitive version facts below
> (React 19.2 Node `renderToReadableStream`, Node zstd in v23.8.0, Zero 1.0 GA, PowerSync v1.0)
> align with prior verified research but should be double-checked before they're load-bearing.

## TL;DR — two keystones unblock almost everything

Every stream pointed at the same two structural changes:

1. **Response body: `string` → `ReadableStream | Buffer | string`** (and let `applyResponse` send a
   bodiless 304). Today `VoloResponse.body` is a string and `applyResponse` is `writeHead + end(body)`
   (`packages/runtime/src/response.ts`). That one line blocks **streaming SSR, compression, binary
   responses, and conditional-GET 304 — simultaneously**. It is the prerequisite for the whole
   perf story.
2. **A middleware pipeline + `AsyncLocalStorage` request context.** Volo has no interception point,
   so the already-built `@volo/csrf`, `@volo/cors`, `@volo/ratelimit` are **dead code** — nothing
   can mount them. `AsyncLocalStorage` (`node:async_hooks`) carries request id / user / trace /
   tenant without prop-drilling, enables request-scoped dedup, and pre-empts the long-lived-worker
   state-leak class (the bug Laravel Octane spent years learning to contain — Node inherits the
   win *and* the hazard for free).

The happy surprise: **a large batch of high-impact wins needs neither** — they work with today's
buffered `renderToStaticMarkup` and `node:http` (Tier 0 below).

---

## Gap matrix

`✗ = missing · ◐ = partial · ✓ = have`. "Native" = the node/browser primitive to build it (no dep).

### Server / transport
| Capability | Who ships it | Native primitive | Volo | Impact/Effort |
|---|---|---|---|---|
| Web-standard `Request`/`Response` + streaming bodies | Hono (Web-std core) | WHATWG `Request`/`Response` + `ReadableStream`; `@hono/node-server`-style bridge over `node:http` | ✗ (string-only) | High/L |
| Middleware / interception pipeline | Hono onion, Express 5, Fastify hooks, Nest | function composition + `await next()` | ✗ | High/M |
| Per-request context | ecosystem (ALS) | `node:async_hooks` AsyncLocalStorage | ✗ | High/S |
| Response compression (brotli/zstd/gzip) | Express 5, Hono `compress`, Fastify | `node:zlib` `createBrotliCompress` + **`createZstdCompress` (Node v23.8.0)** | ✗ | High/S–M |
| ETag + conditional 304 | Hono, Fastify, Express | `node:crypto` hash → ETag; read `If-None-Match` → bodiless 304 | ✗ | Med/S |
| HTTP/2 | Fastify (`http2:true`) | `node:http2` `createSecureServer` | ✗ (h1.1) | Med/M (deferrable behind proxy) |
| Trust-proxy / X-Forwarded | Fastify, Express | config-gated header parse → `request.ip`/proto | ✗ | Med/S |
| Signed / encrypted cookies | Fastify `@fastify/cookie`, Express | `node:crypto` HMAC + AES-GCM (already used in `auth/signed-sessions.ts`) | ◐ | Med/S |
| Schema-compiled validation + fast serialize | Fastify | Ajv + `fast-json-stringify` (codegen) | ✗ | Med/M |
| Body limits + timeouts | all | timers + byte tally | ✓ (just shipped) | parity |

### React SSR
| Capability | Native primitive | Stable? / who | Volo | Notes |
|---|---|---|---|---|
| **Streaming SSR** | `renderToReadableStream` (now **Node too, React 19.2 Oct 2025**) / `renderToPipeableStream` + `<Suspense>` | stable; Next/RR7/TanStack | ✗ | **pivotal** — needs keystone #1; keep `allReady` buffered branch for crawlers |
| Real hydration | `hydrateRoot` | stable | ✗ (uses `createRoot` placeholder-swap) | **no streaming needed** — reuses server DOM, gains React 19 resilience |
| Selective/progressive hydration | `<Suspense>` + `hydrateRoot` during stream | stable behavior | ✗ | after streaming + hydrateRoot |
| Resource preloading | `react-dom` `preload`/`preinit`/`preconnect`/`prefetchDNS` + `fetchpriority` + `modulepreload` | stable (React 19) | ✗ | **works TODAY** with `renderToStaticMarkup` (React hoists into buffered `<head>`) — highest ROI |
| Document-metadata hoisting | render `<title>`/`<meta>` anywhere → hoisted | stable (React 19) | ✗ | **works TODAY**; React does NOT dedupe → need a convention |
| Per-request dedup | React `cache()` / ALS-keyed memo | stable (server) | ✗ | kills duplicate DB calls/request |
| `use()` + Suspense data | `use(promise)` + `<Suspense>` | stable (React 19) | ✗ | full value after streaming |
| RSC | `@vitejs/plugin-rsc` (Vite-native), Next App Router | **stable only in Next 16**; Vite plugin/RR7/TanStack = preview | ✗ | **defer** — heaviest lift; framework-neutral path is the Vite plugin |
| PPR (static shell + dynamic holes) | `<Suspense>` over a cached shell | stable in Next 16 ("Cache Components") | ✗ | pattern adoptable after streaming + ISR |
| Resumability (Qwik) | — | non-React | n/a | **skip** — React 19 selective hydration captures most of it |

### Caching (three layers — SWR + tag-purge is the dominant model)
| Layer | Capability | Native primitive | Volo | Impact/Effort |
|---|---|---|---|---|
| Browser | immutable cache for hashed assets | `Cache-Control: public, max-age=31536000, immutable` | ✗ | High/S |
| Browser | ETag/Last-Modified + 304 for HTML | `node:crypto` hash + `If-None-Match` | ✗ | High/S |
| Browser | stale-while-revalidate / stale-if-error | a `Cache-Control` string | ✗ | High/S |
| Browser | bfcache eligibility | client runtime: `pagehide`/`pageshow`, never `unload` | ◐ | Med/S |
| Browser | Service Worker Cache API / offline | `caches.open/match/put`, IndexedDB | ✗ | Med/L |
| Edge | tag-based purge (Surrogate-Key) | emit `Cache-Tag`/`Surrogate-Key` header | ✗ | High/L |
| Edge | Workers edge cache | `caches.default` + `ctx.waitUntil` SWR | ✗ (adapter does bare `new Response`) | High/M |
| Edge | 103 Early Hints | `node:http2` + `res.writeEarlyHints` | ✗ | Med/L (needs HTTP/2) |
| Server | data cache + `use cache`/cacheLife | memoizing wrapper over `@volo/cache` keyed by args | ✗ | High/L |
| Server | ISR / on-demand revalidate | revalidation store (ts + tag index) + bg regen on `@volo/sites` | ✗ | High/L |
| Server | full-page + fragment cache | render memoized in `@volo/cache`, tag-indexed | ✗ | High/L |
| Server | request-scoped memo/dedup | ALS + `Map` | ✗ | High/M |
| Server | Vary-aware keys | `Vary: Accept-Encoding/Cookie` | ✗ | Med/S |

### Security hardening (beyond the basic four we shipped)
| Capability | Native primitive | Volo | Impact/Effort |
|---|---|---|---|
| Full headers: CSP / COOP / COEP / Permissions-Policy | header strings + sane defaults + per-route override | ◐ (only nosniff/Referrer/X-Frame/HSTS) | High/S |
| Wire csrf into the pipeline (default-on for state-changing methods) | existing `@volo/csrf` + `node:crypto`, session-bound | ◐ (exists, unwired) | High/S once pipeline exists |
| Wire cors + rate-limit into the pipeline | existing packages | ◐ (exist, unwired) | High/S once pipeline exists |
| Trust-proxy (correct client IP for rate-limit/logging) | config-gated `X-Forwarded-*` parse | ✗ | Med/S |
| Escape-on-output by default + context encoders | React-style default-escape, explicit opt-out | ◐ (React escapes; no framework invariant) | High/S–M |
| Signed URLs (tamper-evident, time-limited links) | `node:crypto` `createHmac` + `timingSafeEqual` (already used) | ✗ helper | Med/S |
| Encrypted cookies by default | `node:crypto` AES-GCM | ◐ (signing only) | Med/S |
| Atomic locks (anti cache-stampede) | Postgres advisory locks / `INSERT … ON CONFLICT` | ✗ | High/M |
| Single-flight request coalescing | `Map<key, Promise>` in `cache.remember()` | ✗ | High/S |

### Local-first / offline — **the moat**
The category bifurcated: **Postgres-replication engines (ElectricSQL, Zero 1.0 GA, PowerSync v1.0)
structurally require a DB substrate** — which Next/Remix/TanStack lack and Volo uniquely has. Supabase
acquired Triplit; the DB vendors are absorbing local-first. **Volo can ship it natively because it
owns the substrate.**

| Piece | Native primitive | Maturity | Volo fit |
|---|---|---|---|
| Read-path query sync on the one Postgres | logical-replication/WAL → auth-scoped "shapes" → CDN-cacheable HTTP stream (Electric pattern) | Electric prod-core, Zero 1.0 GA, PowerSync v1.0 GA | **Excellent — unique to the substrate** |
| Client store | in-memory + incremental view maintenance (TanStack DB style); opt-in **SQLite-wasm + OPFS** (Chrome 102+/FF 111+/Safari 16.4+, Safari<17 VFS caveat) | TanStack DB beta→1.0; OPFS broadly avail | mirrors Volo's local SQLite |
| Writes | optimistic apply → POST through existing ORM/queue → server-authoritative reconcile | proven (Zero/TanStack) | reuses Volo batteries; no CRDT needed in v0 |
| Cross-tab plumbing | **Web Locks** (leader election), **BroadcastChannel** (fan-out), `navigator.storage.persist()` (anti-eviction) | GA all evergreen | required, not optional |
| Collaborative fields | Yjs / Loro / Automerge CRDT, opt-in per-column | production | later, per-field only |
| Background write flush | Background Sync API | **Chromium-only — NOT Safari/Firefox** | **out of scope** — use in-page retry queues |

---

## The sequenced plan

### Tier 0 — ship now, no structural change (perf-per-line + security) — ✅ SHIPPED
All `node:http setHeader` / `node:crypto` / React-hoisting; no rewrite. Delivered across
`@volo/runtime`, `@volo/ui`, `@volo/cache` (each 100% covered; full suite green). What shipped:
- ✅ **HTTP cache headers** (`@volo/runtime/http-cache.ts`): `immutable` for content-hashed assets / `no-cache` for HTML via `cacheControl()` + `hasContentHash()`; content-hash **ETag → bodiless 304** (`etagFor`/`etagMatches`/`respondNotModified`, ETag stripped of `Content-Length`); SWR/`stale-if-error` directives; `Vary`. `VoloResponse.body` stays a string (304 bypasses `applyResponse`).
- ✅ **React resource preloading** (`@volo/ui/resources.ts`): `preload`/`preinit`/`preinitModule`/`preconnect`/`prefetchDNS` + `lcpImage` (`fetchpriority=high`) + `modulePreload` — hoist into the buffered `<head>` (verified empirically).
- ✅ **Document-metadata** (`@volo/ui/metadata.ts`): title/meta/link helpers + `dedupeMetadata` (charset promoted to front for the first-1024-bytes rule).
- ✅ **Security headers**: COOP + restrictive Permissions-Policy now default; **CSP** opt-in (`csp` option, enforce/report-only, `RECOMMENDED_CSP`) and **COEP** opt-in — *deliberately not default* (a strict CSP breaks the island inline-JSON bootstrap; COEP breaks cross-origin subresources).
- ✅ **bfcache** (`@volo/ui/bfcache.ts`): `observePageLifecycle` uses only `pagehide`/`pageshow`/`visibilitychange`.
- ✅ **Single-flight coalescing** (`@volo/cache` `remember()`): `Map<key, InFlight>` with a per-lead token so a `delete`/`clear` mid-flight wins the race (no stampede resurrection).
- ✅ **`createRoot` → `hydrateRoot`, made opt-in per island** (`ssr?` flag on `ClientComponentDef`, carried on the `IslandMount` wire). Volo islands server-render only a *fallback* by design (auth-aware static), so a blanket swap would mismatch; `ssr:true` makes the server render the real component and the client `hydrateRoot`s it. **Pitfall fixed:** the page must be serialized with the new `renderPageMarkup(page)` (uses `renderToString` when any island is `ssr:true` — `renderToStaticMarkup` strips the `<!-- -->` text-segment markers hydration needs).

**Deferred out of Tier 0** (clean follow-ups): **signed-URL** helper + **escape-on-output** encoders (cheap, deferred to keep Tier 0 conflict-free); switching **`examples/estate`** to `renderPageMarkup` (estate is correct as-is — its island is `ssr:false` — and the parallel track owns that example).

*Exit (met):* immutable assets + preloaded LCP + `fetchpriority`, 304s on repeat HTML, configurable CSP/COOP/Permissions-Policy, opt-in true hydration — all on the current buffered architecture.

### Tier 1 — the two keystones
- ✅ **A. Response body widened — SHIPPED.** `VoloResponse<B extends VoloBody = string>` where `VoloBody = string | Uint8Array | ReadableStream` (a `string` default keeps every existing consumer non-breaking). `applyResponse` writes all three arms (string→end, Uint8Array→Buffer, ReadableStream→`Readable.fromWeb().pipe` with source/destination error handling that destroys the socket, never crashes); ETag/304 skips streams (can't hash without draining). Binary-safe static serving: `nodeStaticReader` reads bytes, `contentTypeOf`/`isBinaryType` cover image/font/media/wasm, body kind reconciled to extension. `Controller.bytes()` helper added. Cloudflare adapter passes the body straight to a Web `Response`. **Verified:** the real server returns a PNG byte-for-byte (incl. a `0xFF` byte) + a streamed body; ws:typecheck + ws:test green (2688), web/runtime/cloudflare 100% covered, examples untouched. This unblocks streaming SSR + compression + binary + conditional GET.
- ✅ **B. Middleware pipeline + `AsyncLocalStorage` request context — SHIPPED.** Per-request ALS context in `@volo/web` (`runWithContext`/`currentContext()`; placed there to avoid a circular dep — runtime establishes, controllers read); strictly per-request via `AsyncLocalStorage.run` (no cross-request leak — verified with interleaved + concurrent-socket tests). Onion middleware pipeline (`Middleware`/`runPipeline`; `AppConfig.middleware`); `secureStack()` in `@volo/kernel` composing cors + rate-limit (safe defaults) + **opt-in** CSRF. `trust-proxy` in `@volo/runtime` (configurable; derives client ip/proto, off by default; spoofing-documented); `requestId` minted per request and added to the access log. `@volo/csrf`/`@volo/cors`/`@volo/ratelimit` now ship mountable middleware. **Backward-compat:** no-middleware apps unchanged; **CSRF never auto-on** (the estate tokenless sign-in still works). 6 packages 100% covered. **Follow-up:** the `@volo/cloudflare` edge handler must wrap dispatch in `runWithContext` + route through `applyResponse` to inherit the context + hardening (tracked in the server-streaming CVE review; owned by the edge track).

*Exit (met):* the pipeline exists and `secureStack` mounts cors+rate-limit+opt-in-CSRF; one request carries a `requestId` through the access log via ALS; the response path streams (Keystone 1). **(A and B both done.)**

### Tier 2 — built on the keystones
- ✅ **Streaming SSR — SHIPPED.** `@volo/ui` `renderPageStream(page)` → `ReadableStream` via React 19.2 `renderToReadableStream` (shell-first, `<Suspense>` progressive reveal; carries the `<!-- -->` hydration markers ssr:true islands need), plus `renderPageStreamToString(page)` — the buffered `allReady` exit for crawlers/SEO/SSG that **fails loudly (`UI_STREAM_INCOMPLETE`) rather than serving a partial page** when a boundary errors. `Controller.streamTree()` returns a stream-bodied response (flows through the 1.B pipeline unchanged; ETag skips streams). `@volo/sites` prerender stays buffered (untouched). Buffered `renderPageMarkup`/`renderTree` unchanged. ui + web 100% covered; estate (incl. hydration) unchanged. *Remaining for full streaming value: `use()`/Suspense data-loading conventions in app code.*
- **Compression**: brotli (precompressed, max level, for static) + zstd/brotli (dynamic) via `node:zlib`, `Accept-Encoding` negotiation, `Vary`.
- **Request-scoped dedup**: React `cache()` and/or ALS-keyed memo.
- **Server cache wired into responses**: `use cache`-style memoizing wrapper + **tag index + `revalidateTag`** + **Cache-Tag/Surrogate-Key** headers (same tags drive CDN purge); **full-page + fragment cache**; **atomic locks** (Postgres advisory) for stampede safety.
- **ISR/SWR** on `@volo/sites` (static-with-background-regen).
- **Cloudflare adapter cache-aware**: `caches.default` + `ctx.waitUntil` SWR; pass through Cache-Control/ETag/Cache-Tag.
- **Encrypted cookies** by default; finish cookie signing/rotation.

### Tier 3 — bigger bets
- **HTTP/2** (`node:http2`) → unlock **103 Early Hints** (`res.writeEarlyHints`) for preload/preconnect during DB think-time.
- **PPR-style** static shell + streamed Suspense holes (combine SSG shell + Tier-2 streaming + ISR).
- **RSC** via `@vitejs/plugin-rsc` (framework-neutral, Bun/Vite-aligned) — **defer**; only Next-stable today.
- **Schema-compiled validation/serialization** (Fastify-style) at the transport edge.

### Tier 4 — the differentiator: `volo.live(query)`
Read-path query sync on the one Postgres's logical replication → auth-scoped shapes → CDN-cacheable
HTTP stream → in-memory (opt-in OPFS-SQLite) client store; optimistic writes reconciled through the
existing ORM/queue. Cross-tab via Web Locks + BroadcastChannel + `storage.persist()`. Yjs/Loro as
opt-in per-field later. **No background-sync dependency.** v0 = single-table + simple filters,
SQLite-local poll/triggers standing in for logical replication so the dev loop matches prod.

*Why it's the moat:* every Postgres sync engine requires a DB to tap. App frameworks have no
substrate, so they can only *consume* an external sync service; Volo can make `live()` a method on
the same ORM. Local-first becomes **a property of the substrate, not a bolted-on service.**

---

## One-paragraph positioning

Volo's path to "most performant + secure on native tools" is: ride React 19's native streaming +
preloading + hydration (`renderToReadableStream`, `preload`/`preinit`, `hydrateRoot`, `cache()`),
the Node platform's native transport + compression + crypto (`node:zlib` brotli/zstd, `node:http2`,
`node:async_hooks`, `node:crypto`), and the browser platform's native caching + offline + cross-tab
primitives (HTTP cache + SWR, Cache API, OPFS-SQLite, Web Locks, BroadcastChannel) — with a real
middleware pipeline that finally activates the security batteries, and a substrate-native
`volo.live()` sync engine no app framework can coherently match.
