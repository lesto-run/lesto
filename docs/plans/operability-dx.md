# Operability, API Surface & DX — v1 plan

Derived from `docs/reviews/operability-dx.md`, reconciled with `docs/ROADMAP-V1.md` (which rules).
Packages: `@keel/observability`, `@keel/mcp`, `@keel/openapi`, `@keel/webhooks`, `@keel/cli`,
`create-keel`, `@keel/integration`, `@keel/e2e`.
This plan owns **four launch blockers** (#3 webhook SSRF, #9 scaffold loop, #11 zero spans,
#12 MCP unlaunchable) and is the single owner of **observability wiring** repo-wide — every other
plan's `on*` seams terminate here.

**The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on touched
packages; `bun run ws:typecheck` + the serial coverage gate green; coded errors; truthful doc
comments; one conventional commit on `main`.

## Increments (ordered)

1. **Close the webhook SSRF bypass + replay window** — `[Wave 0 | P0 | blocker #3]`
   Files: `packages/webhooks/src/webhooks.ts` — `redirect: "manual"` in the deliverer, 3xx = `WEBHOOK_DELIVERY_FAILED`; widen `FetchLike` to carry the redirect option; sign `${timestamp}.${body}` with an `x-keel-timestamp` header and give `verify` a `toleranceMs`; pin the guard-resolved IP for the fetch (Host header preserved) to close the DNS-rebinding TOCTOU — or, if pinning proves unportable, document the residual risk loudly and re-guard each hop.
   Acceptance: a 302-to-metadata-endpoint fixture is refused; a replayed capture outside tolerance fails `verify`; the 20+ existing guard tests stay green.

2. **Fix the scaffold→run loop** — `[Wave 2 | P0 | blocker #9]`
   Files: `packages/create-keel/src/templates.ts` (add `@keel/cli` to deps; replace `@keel/*@latest` with the decided pin story — tarball/`file:` pins until the `0.x` publish at launch, then real versions), `packages/cli/src/run.ts`/`bin.ts` (tolerate a missing `keel.sites.ts` — empty sites, app-only dispatch), plus the scaffold flip to `dialect: "preact"` (coordinate with ui-client item 3 — same wave, the scaffold lands once).
   Acceptance: **a CI job that scaffolds into a temp dir, runs `bun install` against workspace-linked packages, boots `keel dev`, curls a route, and asserts an island hydrates.** This e2e is the gate that makes the three silent breaks impossible to re-ship.

3. **Wire tracing end-to-end** — `[Wave 4 | P0 | blocker #11 — the single owner of OTLP wiring]`
   Files: `packages/cli/src/run.ts` (`keel serve`/`dev` read `KEEL_OTLP_URL` + headers/service-name, construct `Tracer` + `OtlpHttpExporter`, flush on interval and on drain), `packages/runtime/src/server.ts` (`onDrain` flush hook), `packages/observability/src/otlp.ts` (cap the unbounded buffer, drop-oldest + error count), `packages/cloudflare` via edge-deploy item 3 (`waitUntil` flush). Then propagation: parse W3C `traceparent` into the root span, expose the request span on the request context, emit `traceparent` outbound from the webhook deliverer; first child spans from the seams other plans built (`@keel/db.onQuery`, queue `onJob`, identity `onEvent`, mail `onDelivered`).
   Acceptance: an integration test proving a served request produces a span in a local collector on **both** tiers; a db query appears as a child span; `examples/blog` documents the two-env-var setup.

4. **Ship `keel mcp` — governed** — `[Wave 4 | P0 | blocker #12]`
   Files: `packages/cli` (new `mcp` command: load `keel.app.ts`, build `KeelMcpContext` — routes, content db when present — `startMcpServer` on stdio), `packages/mcp` (`mode: "read-only" | "operator"` on the context gating `create/update/delete_content_entry` and `handle_request`; per-tool `destructive` metadata; a **mandatory audit sink** on `dispatch` — tool, input hash, outcome, duration; `handle_request` gains an explicit allowlisted `headers` input so agent requests can carry identity instead of being middleware-hostile).
   Acceptance: read-only is the default; write tools refuse without operator mode with a coded error; every dispatch lands in the audit sink (test-pinned); the five-minute demo (list routes → read content → operator-mode create → generate_ui) runs from a real MCP client.

5. **Make the API surface reachable: `keel openapi`** — `[Wave 4 | P1]`
   Files: `packages/cli` (new `openapi [--out openapi.json]` command over the existing generator), `packages/openapi` (per-route `internal`/exclude filter before any serving story exists).
   Acceptance: blog's routes export valid 3.1; internal routes excludable; documented limitation: no request/response schemas yet (Zod extraction is the post-1.0 follow-on).

6. **Widen the loop tests** — `[Wave 5 | P1]`
   CLI e2e for `serve`/`dev`/`deploy --release`/`rollback` as spawned processes (the bin wiring — dynamic imports, signal handlers, exit codes — is exactly where loops break); one integration test asserting a request produces a span AND an access entry; classify permanent webhook failures (`WEBHOOK_URL_BLOCKED`) as non-retryable so the queue stops burning attempts (needs the queue no-retry signal — small coordinated change with data-persistence).
   Acceptance: every CLI command exercised end-to-end at least once in CI.

7. **DX polish batch** — `[Wave 5 | P2]` (one PR)
   `parseStringFlag` rejects `--`-prefixed values; MCP content writes batch/incremental `hydrateRuntime` instead of O(n²) full rehydration; document the traces-only observability cut (no metrics in v1 — say it out loud) and the `keel.request_id`-to-trace join; adopt the decision that propagation is W3C `traceparent` verbatim, never an invented format (NIH boundary line).

## Owned elsewhere (do not duplicate)

- `ui.dialect` config key the CLI reads → **ui-client** item 3.
- Edge `ExecutionContext`/`waitUntil` plumbing → **edge-deploy** item 3 (this plan defines the env/flush contract; that plan lands the adapter arity).
- Runtime access-log/X-Request-Id/readiness batch → **core-runtime** item 4.
- The per-domain event seams this plan's item 3 consumes → data-persistence 8, auth-security 6, web-primitives 5, ui-client 5, content-cms deferred 2.

## Deferred post-1.0 (deliberate)

- OpenAPI request/response schema extraction from the Zod boundary validators (ADR 0005) — natural follow-on once `keel openapi` exists.
- Metrics and logs pipelines (counters, latency histograms) — v1 is traces + structured access logs, stated explicitly in the docs.
- MCP-over-HTTP transport — stdio only in v1; the mode/audit governance from item 4 is the prerequisite it was built to be.
- Publishing automation/release tooling beyond the launch `0.x` publish.
