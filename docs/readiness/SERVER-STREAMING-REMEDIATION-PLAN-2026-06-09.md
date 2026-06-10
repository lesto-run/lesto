# Server & Streaming hardening — remediation plan (2026-06-09)

Addresses the seven findings in `SERVER-STREAMING-CVE-REVIEW-2026-06-09.md`. Sequenced so the
quick, isolated wins land first and the one structural refactor (the shared hardening layer) is
done deliberately, since three other items touch it.

House rules apply to every item: TS/ESM, oxlint + oxfmt clean, vitest **100% coverage**, coded
errors (`RUNTIME_*` / package-prefixed), pure-function cores with injected seams, doc-comment the
*why*. Each item below lists its acceptance criteria in those terms.

## Sequencing overview

```
Wave 1 (quick, isolated, low-risk)          Wave 2 (structural)             Wave 3 (gated/future)
  #4 pipeStream → pipeline()                  #1 shared hardening layer        #7 AbortSignal + render
  #6 gate .map to dev                             ├ unblocks edge parity          timeout (lands with
  #5 router ReDoS guard                            └ prerequisite for #3 on edge   streaming SSR / SSE)
  #2 island escaper utility (+ wire later)    #3 zero-config CSRF default
```

Rationale: #4/#5/#6 are a few lines each with no dependents — do them first to shrink the risk
surface immediately. #2's *escaper* is independent and can land now even though the manifest
emission that consumes it is unbuilt. #1 is the linchpin (edge parity) and should precede #3 so the
new CSRF default is added once, in the shared layer, and is automatically live on both runtimes. #7
is gated on Tier-2 streaming SSR existing.

---

## Wave 1 — quick wins

### #4 — `pipeStream` must tear down the source on disconnect
- **Goal:** a client that hangs up mid-stream destroys the source stream (no FD/socket/cursor leak),
  keeping the existing never-rejects invariant.
- **Change:** in `packages/runtime/src/response.ts`, replace `source.pipe(res)` with
  `stream.pipeline(source, res, cb)` (or `pipeline` from `node:stream/promises`). On any
  error/close, `pipeline` destroys the whole chain. Keep: source-error → socket destroy; dest-error
  (client gone) → swallow + resolve; sync `fromWeb` throw → destroy + resolve.
- **Files:** `runtime/src/response.ts`.
- **Acceptance:** existing `response.test.ts` arms still pass; add a test asserting the *source* is
  destroyed when the destination errors (inject a fake source exposing `destroyed`). 100% cov holds.
- **Risk:** low. Behavior-preserving except it now also tears down the source.

### #6 — Gate source-map serving to dev
- **Goal:** `*.js.map` (and `.map`) is never served by the production static dispatcher (source leak).
- **Change:** `packages/runtime/src/sites.ts` — make `.map` serving conditional. Cleanest: the
  static reader/dispatcher takes a `serveSourceMaps: boolean` (default `false`), and a request for a
  `.map` file returns 404 unless enabled. Dev dispatcher (`sites-dev.ts`) passes `true`.
- **Files:** `runtime/src/sites.ts`, `runtime/src/sites-dev.ts` (and the build, if it copies `.map`
  into the prod output — prefer simply not emitting them to the prod sink).
- **Acceptance:** test that a `.map` request is 404 in prod config and 200 in dev config.
- **Risk:** low. Confirm nothing in prod relies on fetching maps.

### #5 — Router: reject ambiguous backtracking patterns; document the timeout limit
- **Goal:** the router cannot compile an ambiguous adjacent-quantifier regex (the `path-to-regexp`
  ReDoS shape), and the docs state plainly what the handler deadline does and does not protect.
- **Change:** in `packages/router/src/router.ts#compile`, detect two `:param` captures in one path
  segment (i.e. adjacent `([^/]+)` groups with no intervening `/` literal) and throw a coded
  `ROUTER_AMBIGUOUS_SEGMENT` error at *declaration* time (fail fast, not at request time). Add a doc
  note on `serve`'s `handlerTimeoutMs`: it bounds slow **async** handlers; a CPU-bound synchronous
  loop (ReDoS, `while(true)`, huge sync parse) blocks the event loop so the `setTimeout` deadline
  never fires — that class is defended by avoiding it, not by the timeout.
- **Files:** `router/src/router.ts`, `router/src/errors.ts`, `runtime/src/server.ts` (doc only).
- **Acceptance:** test that `/:a-:b` (and `/:a.:b`) throws `ROUTER_AMBIGUOUS_SEGMENT`; the seven
  RESTful routes and normal `:param` segments still compile. 100% cov.
- **Open question:** longer term, consider a radix/trie matcher (Fastify's model) to drop per-route
  regex entirely. Out of scope for this wave — file as a follow-up.
- **Risk:** low, but it's a behavior change: an app that *intentionally* used `/:a-:b` now errors.
  That pattern is rare and the error message should point to the workaround (one param, split in the
  handler). Acceptable.

### #2a — Island manifest escaper (utility now; wire at emission)
- **Goal:** there exists a single, tested function that serializes the island manifest safe for
  inline `<script>` embedding, and the (future) manifest emission is *required* to go through it.
- **Change:** add `serializeManifest(manifest): string` to the `ui` package that does
  `JSON.stringify(...)` then escapes `<`→`<`, `>`→`>`, `&`→`&`, ` `, ` `
  (the exact pattern already in `content-shared/src/sanitize.ts#serializeJsonLd` and
  `seo/src/json-ld.ts` — reuse/extract rather than re-implement; consider promoting one copy to a
  shared util). Prefer the emission target be `<script type="application/json" id="…">` parsed via
  `JSON.parse(el.textContent)` on the client, so the payload is non-executable even on an escape
  miss — note this in the function's doc so whoever wires emission picks that form.
- **Files:** `ui/src/serialize.ts` (or a new `ui/src/manifest.ts`); possibly a new shared escaper in
  `content-shared`/a small util consumed by `seo` + `ui`.
- **Acceptance:** tests proving `</script>`, `<!--`, ` `, ` `, and a `__proto__` key in
  props all serialize without breakout; round-trip parse equals input. 100% cov. Keep the existing
  JSON-serializability guard (`assertSerializable`) as a *separate* pre-check — it solves fidelity,
  not breakout.
- **Risk:** low (additive). The *consuming* wiring (#2b) is tracked with the islands-emission work.

> **#2b (release gate, not a Wave):** when the manifest→`<script>` emission is actually built, it
> MUST call `serializeManifest`. Add an integration test that renders a page with an island whose
> prop contains `</script>` and asserts no breakout in the emitted HTML. Treat as a blocker for
> shipping islands with any user-derived prop.

---

## Wave 2 — the structural fix and the CSRF default

### #1 — Extract a transport-neutral hardening layer (edge parity)
- **Problem:** all hardening (per-request ALS context, security headers, ETag/304, the
  error→status map, access logging) lives in `runtime/src/server.ts`'s Node `handle`. The Cloudflare
  `toFetchHandler` has none of it → two runtimes, two security postures.
- **Goal:** one tested hardening pipeline that both the Node server and the CF adapter call, so the
  edge gets context, security headers, ETag/304, and the same error→status mapping.
- **Approach:** factor the transport-independent middle of `handle` into a pure-ish wrapper, e.g.
  `harden(dispatch, hardenDeps)` returning a `(request) => Promise<AnyKeelResponse>` that:
  1. `establishContext` + `runWithContext` (so `currentContext()` works on the edge),
  2. runs dispatch inside the context with the error boundary → `statusForError`/`bodyForStatus`,
  3. `withEtag` + conditional-304 decision (return a 304 marker the adapter renders),
  4. `withSecurityHeaders`.
  The Node `handle` keeps the things that are genuinely transport-specific: `readBody` (socket
  byte-cap), socket timeouts, `withTimeout`, `applyResponse`/`pipeStream`, the access log sink. The
  CF handler wraps `harden` and renders the result (including 304) into a Web `Response`. Trust-proxy
  on the edge resolves from CF's `cf-connecting-ip` / `x-forwarded-*` per the configured policy.
- **Files:** new `runtime/src/harden.ts` (or `web` if it must be transport-free and shared without a
  runtime dep — check the dependency direction; context already lives in `@keel/web`), refactor
  `runtime/src/server.ts#handle`, rewrite `cloudflare/src/fetch-handler.ts` to call it.
- **Edge specifics to decide:** body-size cap and handler timeout are partly the CF platform's job
  (request size limit, wall-clock limit) — document what we delegate vs enforce. Context + headers +
  ETag + error map are *not* the platform's job and must be in `harden`.
- **Acceptance:** a shared test suite asserting identical headers / status-mapping / 304 behavior
  for the same dispatch under both a fake Node response and a Web `Response`. `currentContext()`
  returns the per-request id under the CF path. 100% cov on `harden`.
- **Risk:** medium — it's the core request path. Do it behind the existing test suite; the Node
  behavior must be byte-for-byte unchanged (the review verified those tests encode the current
  contract). Land in its own PR.

### #3 — Zero-config CSRF default (Origin / Sec-Fetch-Site)
- **Goal:** a brand-new Keel app has CSRF protection by default, without token plumbing; the existing
  signed-token middleware remains the documented stronger opt-in.
- **Change:** add an `Origin`/`Sec-Fetch-Site`-based default check, mounted by the kernel by default
  (overridable/disable-able), in the shared `harden` layer (#1) so it's live on both runtimes. On a
  state-changing method (POST/PUT/PATCH/DELETE), require `Sec-Fetch-Site` ∈ {`same-origin`,
  `same-site`} **or** an `Origin` whose host matches the request host; else 403. Safe methods pass.
- **Bake in the field's CVEs from day one** (so Keel never rediscovers them): host comparison
  **case-insensitive**; if the check ever branches on `Content-Type`, include `text/plain`, strip
  `;`-parameters, lowercase before matching, and treat **absent** `Content-Type` as *unsafe*. Prefer
  `Sec-Fetch-Site` as primary (no content-type dependence at all) with `Origin`-vs-host as fallback.
- **Files:** `csrf/` (new default middleware alongside the token one), kernel default wiring, the
  `harden` layer (#1).
- **Acceptance:** tests for same-origin pass, cross-origin 403, missing-Origin+missing-Sec-Fetch on a
  guarded method 403 (fail-closed), safe methods pass, case-insensitive host. Document the precedence
  and how to disable for pure-API deployments. 100% cov.
- **Risk:** medium — a too-aggressive default breaks legitimate cross-origin form posts / old
  integrations. Mitigate: ship it `report-only`-style first (log would-be-blocks) or clearly
  documented + easily disabled, mirroring how the token middleware is deliberately opt-in.

---

## Wave 3 — gated on streaming SSR / SSE landing (🔭)

### #7 — AbortSignal on context + render timeout + disconnect teardown
- **Goal:** when `renderToReadableStream` (Tier 2) and/or SSE land, a client disconnect or a hung
  render cancels the work instead of burning CPU / hanging a socket.
- **Change:** put an `AbortSignal` on `RequestContext`; fire its controller on `res`/socket `close`;
  pass it to `renderToReadableStream({ signal })` and pair with a hard render-timeout that calls the
  stream's `abort()`. Never write `onError`/`onShellError` output into the stream — log server-side,
  emit a generic boundary. Decide status before the first byte (immutable after flush). For SSE,
  subscribe to the signal and tear down endless streams on disconnect.
- **Depends on:** #1 (context) and the streaming-SSR feature existing.
- **Acceptance:** write the tests now as pending/skipped specs encoding the contract (timeout fires
  `abort`; disconnect aborts; errors never reach the wire) so the feature can't land without them.
- **Note:** this is also where the React-streaming/RSC research fleet (running now) feeds in — its
  findings should be folded into this item's design before implementation.

---

## Tracking

| # | Item | Wave | Pri | Depends on |
|---|------|------|-----|-----------|
| 4 | `pipeStream` → `pipeline()` | 1 | P1 | — |
| 6 | gate `.map` to dev | 1 | P2 | — |
| 5 | router ReDoS guard + timeout doc | 1 | P2 | — |
| 2a | island manifest escaper utility | 1 | P0/P1 | — |
| 2b | wire emission through escaper | gate | P0/P1 | islands emission |
| 1 | shared hardening layer (edge parity) | 2 | P0 | — |
| 3 | zero-config CSRF default | 2 | P1 | #1 |
| 7 | AbortSignal + render timeout | 3 | P1-later | #1 + streaming SSR |
