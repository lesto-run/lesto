# Core Runtime & HTTP — v1 plan

Derived from `docs/reviews/core-runtime.md`, reconciled with `docs/ROADMAP-V1.md` (which rules).
Packages: `@lesto/kernel`, `@lesto/runtime`, `@lesto/web`, `@lesto/router`, `@lesto/errors`
(+ the `@lesto/config`/`@lesto/hooks` orphan decision).

**The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on touched
packages; `bun run ws:typecheck` + the serial coverage gate green; every refusal a coded error;
module-header prose truthful after the change; one conventional commit on `main`.

## Increments (ordered)

1. **Kill the response singletons** — `[Wave 0 | P0 | blocker #2]`
   Files: `packages/web/src/lesto.ts` (`NOT_FOUND` → `notFound()` factory), `packages/web/src/render-page.tsx` (`BAD_REQUEST` → factory); `Object.freeze` any remaining constant responses as a dev tripwire.
   Acceptance: a regression test that mutates a 404's headers through app middleware and asserts the next request's 404 is clean; existing dispatch tests green.

2. **Fix `trustProxy: true`/predicate semantics** — `[Wave 0 | P0 | blocker #4]`
   Files: `packages/runtime/src/trust-proxy.ts` — `true` resolves `chain[length - 1]` (one trusted hop); predicate peels right-to-left while it accepts; left-most only behind an explicit `"all"` escape hatch. Update `ServeOptions` docs; note the correction in `docs/readiness/SERVER-STREAMING-CVE-REVIEW-2026-06-09.md`.
   Acceptance: a test asserting the prepended-XFF spoof (`X-Forwarded-For: 1.2.3.4` + LB-appended real IP) resolves to the real IP; numeric hop mode byte-unchanged. (auth-security plan references this item; it is owned here.)

3. **Timeout cancellation** — `[Wave 4 | P1]`
   Files: `packages/runtime/src/server.ts` (race an internal `AbortController` with `handlerTimeoutMs`; abort `context.signal` on overrun), `packages/web/src/render-page.tsx` (make `RENDER_DEADLINE_MS` configurable via `lesto()`/`ServeOptions`, chained to the same signal).
   Acceptance: a wedged handler is observably aborted after the 503; render deadline configurable per app; no zombie-handler accumulation in a stress test.

4. **Runtime observability batch** — `[Wave 4 | P1]` (one coherent PR; pairs with operability-dx item 3, which owns the tracer wiring)
   Files: `packages/runtime/src/server.ts`, `packages/runtime/src/response.ts`.
   - Stream-truncation reporting: `pipeStream` gets an error sink; truncation recorded in the access entry and as a span attribute.
   - Compute the request line before `readBody` so 413s are attributed correctly.
   - Echo `X-Request-Id` on every response; adopt validated inbound ids behind the `trustProxy` gate.
   - Default access log becomes structured JSON (`logRequest` seam unchanged).
   - Bound the readiness probe (~1 s race → 503 on overrun).
   Acceptance: each behavior pinned by a test; access-entry shape shared with the edge tier (edge-deploy plan item 7 mirrors it).

5. **`Set-Cookie` multimap header contract** — `[Wave 5 | P1 | breaking]`
   Files: `packages/web/src/types.ts` (`headers: Record<string, string | string[]>`), `packages/runtime/src/response.ts` (array arm in `applyResponse` + `respondNotModified`), `packages/web/src/harden.ts` merges, `packages/cloudflare/src/fetch-handler.ts` seam (coordinate with edge-deploy; single commit across the seam).
   Acceptance: a response setting a session cookie and a CSRF cookie delivers both on node and edge; middleware merge tests prove no silent clobber.

6. **Decode route params at match time** — `[Wave 5 | P1 | breaking]`
   Files: `packages/router/src/table.ts`, `packages/router/src/router.ts` — `decodeURIComponent` per capture; malformed sequences → coded 400.
   Acceptance: tests for `%2F` (no separator smuggling), `%2e%2e`, malformed `%`, unicode slugs; `pathFor` round-trips.

7. **ADR 0004 Phase 7.6 — delete the legacy dispatch stack** — `[Wave 5 | P1]`
   Files: remove `packages/web/src/application.ts`, `controller.ts`, `packages/router/src/router.ts` (legacy `Router`, and `singularize` with it); collapse `packages/kernel/src/kernel.ts` `createApp` to `LestoAppConfig` only; migrate kernel/CLI/MCP tests off `new Router()`.
   Acceptance: one router vocabulary exported from `@lesto/web`; `ws:typecheck` green across examples; ADR 0004 status updated.

8. **Resolve the orphans: delete `@lesto/hooks` + `@lesto/config` from the v1 surface** — `[Wave 5 | P1]`
   Per the roadmap call (§6): no wiring under launch pressure. Remove the packages (or move to an `attic/`), excise the "hooks/plugins/themes built in" claim from ARCHITECTURE.md, and file the post-1.0 plugin-system ADR stub.
   Acceptance: zero dead public packages in the workspace; coverage gate runtime shrinks; docs claim only what exists.

9. **Response compression** — `[Wave 5 | P1]`
   Files: `packages/runtime/src/response.ts` + `serve()` — Accept-Encoding-negotiated brotli/gzip for buffered bodies, zlib transform for streams, content-type allowlist, skip already-encoded types; set `Content-Length` on the uncompressed buffered arms while in the file.
   Acceptance: negotiation matrix tested; streams remain truncation-reported (item 4).

## Owned elsewhere (do not duplicate)

- Migration advisory lock + `migrations:"skip"` boot mode → **data-persistence** item 3 (kernel touch coordinated there).
- Tracer construction/flush in `lesto serve`/`dev` → **operability-dx** item 3.
- Kernel wiring of durable session/rate-limit stores → **auth-security** item 5.
- Edge `ExecutionContext`/`waitUntil` → **edge-deploy** item 3.

## Deferred post-1.0 (deliberate)

- Route-table bucketing (linear scan is fine at v1 scale); per-route body policy / streaming uploads; buffered-below-threshold pages to re-enable 304s (re-scope the Tier-0 claim instead); CSP nonce machinery (one coherent post-1.0 increment with ui-client); `statusForError` shared-code registry (fold into the post-1.0 error-code registry, data-persistence P2); `serve()` safety-net opt-out.
