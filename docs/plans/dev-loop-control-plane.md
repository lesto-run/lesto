# Dev-loop control plane — implementation plan

Derived from **ADR 0032**. The committed scope is **Phase 1**: a DEV-ONLY MCP server
stood up by `lesto dev`, exposing three read-only introspection tools
(`get_dev_diagnostics`, `get_recent_requests`, `tail_logs`) over `@lesto/mcp`'s existing
`buildTools`/`dispatch`/audit machinery and `read-only` floor, over a **new loopback HTTP
MCP transport** (`@lesto/mcp` is **stdio-only** today — imports `server.ts:11-12`,
instantiated `server.ts:85`; stdio cannot share `lesto dev`'s stdout, `bin.ts:558,649`,
and an out-of-process stdio server cannot see the in-process ring — so the transport is
net-new, security-sensitive work with its own increment), reading a bounded live-dev-state
ring the watcher fills (`DevError` + log ring + access-log ring + a **bounded request-span
ring** so `explain_request` has a real Phase-1 producer). **The transport carries a hard
security posture:** Origin/Host allowlist + per-session token + the SDK's
`enableDnsRebindingProtection`/`allowedHosts` (default OFF — turned ON), with a
foreign-Origin-rejected test; the same Origin check is **retrofitted onto the live-reload
WS** (`bin.ts:407-413`, which accepts any upgrade today). **The security-sensitive
transport logic lives in a NEW covered module `packages/mcp/src/http-transport.ts`** (NOT
the coverage-excluded `server.ts`), so the 100% bar is real; only the irreducible socket
bind stays in `server.ts`. **Phase 2** (the dev-only `data-lesto-loc` transform +
`locate_element` + the loopback `GET /__lesto/open` editor-jump endpoint) is designed in
the ADR and gated on Phase 1 + a dev transform seam — **not in this plan**. **Phase 3**
(`explain_request` over the **Phase-1 span ring** + the `POST /__lesto/browser-console`
ingest + the `X-Lesto-Trace` header) is designed in the ADR — **not in this plan** — but is
**no longer gated on a phantom span store**: its producer is the Phase-1 ring committed
below. Everything here is dev-loop machinery and PREVIEW; it must never reach a production
build (enforced by a structural dev-only sentinel + an output test, Inc 5).

**Packages:**
- `@lesto/cli` — `run.ts` (`runDev` gains the live-dev-state ring + the injected
  `devState` seam **and** threads `logRequest` into its `serve` call to feed the access-log
  ring — `run.ts:1159-1169` passes none today), `bin.ts` (constructs the ring + stands up
  the loopback dev MCP transport on the `dev` path, next to `buildLiveReload`), the
  dev-state-ring pure core (new module).
- `@lesto/mcp` — `tools.ts` (three new read-only dev tools on `buildTools`, behind the
  **existing** `dispatch` audit + `read-only` floor — NOT ADR 0028's unshipped governance
  model), `http-transport.ts` (**new covered module**: the loopback HTTP transport's
  request/response shaping + Origin/Host/token validation, held to the full 100% bar),
  `server.ts` (a thin **new** `startMcpHttpServer` that owns only the irreducible socket
  bind and delegates to `http-transport.ts` — `server.ts` is coverage-excluded,
  `vitest.config.ts:13`), `errors.ts` (new coded refusals: `MCP_DEV_STATE_UNAVAILABLE`,
  `MCP_DEV_ORIGIN_REJECTED`, `MCP_REQUEST_NOT_RETAINED`).
- `examples/estate` — the dogfood / QA gate. **Note:** estate runs a bespoke
  `examples/estate/dev.ts` (its own `withDevReload` + `serve()`, `dev.ts:120,155,159`) that
  never calls `runDev`/`bin.ts`, so the dev MCP server is **not** on estate's current dev
  path; an increment migrates estate's dev entry onto `lesto dev`/`runDev` first. The
  primary QA teeth are a CLI-`runDev` integration test; estate is the local-DX dogfood on
  top.

> **The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on
> touched packages; `bun run ws:typecheck` + the serial coverage gate
> (`bun scripts/coverage-gate.ts`) green; coded errors; truthful doc comments; one
> conventional commit on `main`. Layering invariants, grep-asserted: `@lesto/mcp` gains
> **no** `@lesto/cli` import (the dev-state reader is an **injected seam** on
> `LestoMcpContext`, never an import); `@lesto/mcp` gains **no new `@lesto/auth` runtime
> dep**; no `kernel → mcp` edge (the dev transport is mounted by the **bin/app**, above
> both, never by kernel); the dev MCP server, the editor-jump endpoint, and the
> browser-console ingest are constructed **only** on the `command === "dev"` path
> (grep-assert they are unreachable from `serve`/`build`/`deploy`); `@lesto/web` gains
> **no** dev-MCP-transport coupling (the loopback HTTP transport is a separate bin-owned
> server, like the live-reload socket).

## Increments

1. **A bounded live-dev-state ring (pure CLI core)** — `[keystone]`
   Files: `packages/cli/src/dev-state.ts` (new), `packages/cli/test/dev-state.test.ts` (new).
   A pure, fixed-size record the dev watcher fills and the dev tools read: the *current*
   `DevError | undefined`, a bounded ring of recent `deps.out` log lines, a bounded
   ring of recent access-log entries (each a runtime `AccessEntry` —
   `{ method, path, status, ms, requestId }`, `runtime/src/server.ts:127-142`; use its real
   `ms` field, not a renamed `durationMs`), **and a bounded request-span ring keyed by
   `requestId`** — the Phase-3 `explain_request` producer, committed here so that tool reads
   a real bounded store, not a phantom one (entries age out; an aged-out `requestId` is the
   `MCP_REQUEST_NOT_RETAINED` case).
   No socket, no fs, no process — a string/struct builder exactly like `dev-overlay.ts`
   is (`packages/cli/src/dev-overlay.ts:1-22`), so it is fully unit-testable; the bin
   injects it. Every ring caps memory (deny-by-default: a long dev session never grows
   unbounded). This is the keystone the tools and the watcher both sit on.
   Acceptance: each ring drops oldest past capacity; `getDiagnostics()` returns the live
   `DevError` or `undefined`; `recentRequests(n)`/`recentLogs(n)` return bounded slices;
   `spanFor(requestId)` returns the retained span entry or `undefined` (aged-out branch
   tested); every branch (empty, partial, over-capacity) unit-tested; oxlint/oxfmt clean;
   typecheck + serial coverage gate green; 100%.

2. **Wire the dev-state ring into `runDev` as an injected `devState` seam (incl. the access log)** — `[reuses Inc 1]`
   Files: `packages/cli/src/run.ts`, `packages/cli/test/run.test.ts` (or the dev-focused
   test file).
   Add an optional `devState?` seam to `CliDeps` (mirroring `liveReload?` —
   `run.ts:316`), and have `runDev` push into it where it already tracks dev state: the
   `DevError` it builds for the overlay (`run.ts:1088-1091,1104-1107,1150-1151`) also
   updates `devState`; the `deps.out` route-refresh/activity lines
   (`run.ts:1210-1216,1233`) also append to the log ring. **The access-log ring is wired by
   the CORE, not the bin:** the dev `serve()` call lives in `run.ts` (`run.ts:1159-1169`)
   and passes no `logRequest` today; `runDev` threads a new
   `logRequest: (entry: AccessEntry) => void` (`runtime/src/server.ts:319`) into that
   `deps.serve` call that appends each entry to the ring. (The earlier draft wrongly
   attributed this to bin wiring — the bin has no access to the dev `serve()` call.) `runDev`
   stays a pure core over the seam (absent seam → unchanged behaviour, the prior path; the
   `logRequest` it adds is a no-op append when `devState` is absent).
   Acceptance: with a fake `devState`, a simulated client-rebuild failure records the
   `DevError`, a route refresh appends a log line, and a served request (driven through the
   stubbed `serve`'s `logRequest`) appends an `AccessEntry` to the request ring; absent the
   seam, `runDev` behaves exactly as before (regression test); no new import into `run.ts`;
   typecheck + serial coverage gate green; 100%.

3. **Three read-only dev tools on `buildTools`, behind the existing audit + read-only floor** — `[the binding]`
   Files: `packages/mcp/src/tools.ts`, `packages/mcp/src/errors.ts`,
   `packages/mcp/test/tools.test.ts`.
   Extend `LestoMcpContext` with an **injected** `devState?` reader (the seam from Inc 1's
   shape, structurally — `@lesto/mcp` defines its own interface, NOT an import of
   `@lesto/cli`). Add `get_dev_diagnostics`, `get_recent_requests`, `tail_logs` to
   `buildTools` as `destructive: false` tools (`destructive` flag `tools.ts:155`), each a
   thin handler over `context.devState`. Absent the reader, each tool is present but inert
   and refuses with a new coded `MCP_DEV_STATE_UNAVAILABLE` (the same pattern as
   `requireContentDb`'s `MCP_CONTENT_STORE_UNAVAILABLE` — `tools.ts:161-169`). They reuse
   `dispatch`'s audit path unchanged (`tools.ts:608-650`) and the `read-only` floor
   (`modeOf` default `tools.ts:187-191`) — this is the **pre-existing** `@lesto/mcp` posture,
   NOT ADR 0028's (unshipped) governance model. Every dev dispatch is audited. Read-only, so
   they run in `read-only` mode; no operator escalation added.
   Acceptance: each tool returns the injected dev state; absent the reader each throws
   `MCP_DEV_STATE_UNAVAILABLE` (branch tested); every dispatch records one audit record
   (success and the unavailable-refusal); no `@lesto/cli` import in `@lesto/mcp`
   (grep-asserted); typecheck + serial coverage gate green; 100%.

4a. **A NEW loopback HTTP MCP transport — covered core + secure by Origin/token** — `[net-new surface]`
   Files: `packages/mcp/src/http-transport.ts` (**new, covered**: request/response shaping,
   the Origin/Host allowlist, the per-session token check, the foreign-Origin refusal),
   `packages/mcp/src/server.ts` (a thin `startMcpHttpServer` that owns ONLY the irreducible
   `bun.serve`/`http.listen` socket bind and delegates to the covered core — `server.ts` is
   coverage-excluded, `vitest.config.ts:13`), `packages/mcp/test/http-transport.test.ts`,
   `packages/mcp/src/errors.ts`.
   **Why split the file:** putting the security branches in the excluded `server.ts` makes
   "100% coverage" impossible (they would silently escape the gate). The testable transport
   core lives in `http-transport.ts` (held to the **full bar**); `server.ts` keeps only the
   socket bind. `@lesto/mcp` ships **only** `StdioServerTransport` today (imports
   `server.ts:11-12`, instantiated `server.ts:85`, connected `server.ts:87`); the dev
   surface cannot use stdio (the dev process owns stdout — `bin.ts:558,649`) and an
   out-of-process stdio server cannot read the in-process ring.
   **Security posture (hard acceptance — a `127.0.0.1` bind is NOT the control):** the
   transport enables the SDK's `enableDnsRebindingProtection: true` with `allowedHosts` /
   `allowedOrigins` pinned to `127.0.0.1:<port>` + `localhost:<port>`
   (`@modelcontextprotocol/sdk` 1.29.0 `webStandardStreamableHttp.d.ts:84,90,96`; default
   OFF — turned ON here), **plus a per-session token** the dev command mints and the client
   must present. A request with a foreign `Origin`/`Host` or a missing/wrong token is
   **rejected with a coded `MCP_DEV_ORIGIN_REJECTED`** before any `dispatch`. The transport
   takes an injected `LestoMcpContext`; it neither imports `@lesto/cli` nor binds the socket
   inside the covered core (the bind host is fixed to `127.0.0.1` in the bin wiring).
   Acceptance: `startMcpHttpServer(context)` serves `tools/list` + `tools/call` over loopback
   HTTP returning the same shapes as the stdio path; **a request with a foreign Origin/Host
   is REJECTED with `MCP_DEV_ORIGIN_REJECTED` (asserted)**; a request with a missing/wrong
   session token is rejected; the bind host argument is fixed to `127.0.0.1` (asserted in the
   covered factory; the `listen()` call itself is irreducible bin wiring); a `tools/call`
   rides `dispatch`'s audit unchanged; oxlint/oxfmt clean; typecheck + serial coverage gate
   green; **100% on `http-transport.ts`**.

4b. **Stand the dev MCP server up on the loopback transport, dev-only (bin wiring)** — `[order-critical]`
   Files: `packages/cli/src/bin.ts`, `packages/cli/src/mcp.ts` (reuse the
   `LestoMcpContext` construction pattern + the new `startMcpHttpServer` from Inc 4a).
   Construct the dev-state ring (Inc 1) and the dev MCP `LestoMcpContext` (with the
   `devState` reader + the same audit sink `lesto mcp` uses) **only** on the
   `command === "dev"` path — the same place `liveReload` is built only for `dev`
   (`bin.ts:615`). Mount the **loopback HTTP transport (Inc 4a)** as a separate bin-owned
   server bound to `127.0.0.1`, exactly like `buildLiveReload` (`bin.ts:400-407`). The bin
   only *constructs* the ring + transport; the ring's access-log feed is owned by the core
   (Inc 2). This is irreducible bin wiring (coverage-excluded like the rest of `bin.ts`,
   `bin.ts:380-384`), so the DECISION of when to construct it stays in the covered core
   (Inc 2) and the transport logic stays covered (Inc 4a). Order-critical: the dev surface is
   constructed **after** the `dev` branch is taken and **never** on `serve`/`build`/`deploy`.
   Acceptance: a manual `lesto dev` stands the server up and an MCP client reads
   diagnostics/requests/logs over loopback HTTP; the server binds `127.0.0.1` only; no socket
   bound for any non-`dev` command (grep-assert the dev MCP construction is under the `dev`
   guard); typecheck green; the covered core's coverage unaffected; 100% on touched non-bin
   code.

4c. **Retrofit the Origin/Host check onto the live-reload WS** — `[security retrofit]`
   Files: `packages/cli/src/bin.ts` (the `buildLiveReload` upgrade handler —
   `bin.ts:407-413`, which accepts **any** upgrade with no Origin check today), the covered
   Origin-check helper from Inc 4a (`http-transport.ts`), `packages/cli/test/*` /
   `packages/mcp/test/http-transport.test.ts`.
   The live-reload WS is reachable by the same browser-tab/DNS-rebinding vector as the new
   transport and leaks reload/error-overlay payloads (local source paths, stack frames) to
   any tab that connects. Apply the **same Origin/Host allowlist** (reusing the covered
   helper from Inc 4a, not a second copy) to the WS upgrade: a foreign Origin upgrade is
   refused (426/403), only loopback Origins/Hosts pass.
   Acceptance: a WS upgrade with a foreign Origin is rejected (asserted via the covered
   helper); a loopback Origin passes; the helper is shared with Inc 4a (no duplicate
   validation logic); typecheck + serial coverage gate green; 100% on the shared helper.

5. **Grep-assert the dev-only gate + a structural dev-only sentinel + output test** — `[committed]`
   Files: `packages/cli/test/layering.test.ts` (or the repo's existing layering-guard
   test), `packages/mcp/test/layering.test.ts`, `packages/cli/src/run.ts` (the
   `assertDevOnly()` guard), `packages/cli/test/dev-only-output.test.ts` (new).
   Add structural assertions: `@lesto/mcp/package.json` has **no** `@lesto/cli` dep and
   `@lesto/mcp/src` has **no** `@lesto/cli` import; `@lesto/kernel` has **no** `@lesto/mcp`
   dep (the cycle guard — `mcp/package.json:16` depends on kernel, never the reverse); the
   dev MCP server / loopback transport is referenced **only** within the `command === "dev"`
   guard in `bin.ts` (grep the construction symbol appears nowhere on the
   `serve`/`build`/`deploy`/`mcp` paths). These guards are the structural proof the ADR's
   "never in a production build" claim rests on.
   **Structural dev-only sentinel:** the MCP-transport mount and (later) the `/__lesto/open`
   route are wired through an `assertDevOnly()` guard that throws a coded
   `CLI_DEV_SURFACE_IN_PRODUCTION` if reached on a `serve`/`build`/`deploy` path — so a
   hand-wired or mis-copied app dev entry cannot mount them in prod even if it bypasses the
   `command === "dev"` branch.
   **Output test:** assert the `serve()` / `build()` / `deploy()` produced output (route
   table / built artifact) contains **NO `/__lesto/open` route and NO MCP transport mount** —
   making "never in production" a tested invariant, not just a code-path argument.
   Acceptance: each forbidden import/edge is grep-asserted absent; the dev-only-gate
   assertion fails if the construction leaks outside the `dev` guard; the sentinel throws on
   a non-dev path (branch tested); `serve()`/`build()`/`deploy()` output contains no
   `/__lesto/open` route and no transport mount (asserted); typecheck + serial coverage gate
   green; 100%.

6. **CLI-`runDev` integration test — THE COMMITTED QA GATE** — `[committed · the gate]`
   Files: `packages/cli/test/dev-mcp.integration.test.ts` (new).
   **This is the wave's committed gate** (not the estate dogfood — Inc 7a/7b's estate
   migration is large and may not land this wave). The achievable, deterministic gate:
   drive `runDev` (with real `devState` + a real loopback `startMcpHttpServer` from Inc 4a)
   and an in-process MCP client end-to-end. Simulate a client-rebuild failure and assert
   `get_dev_diagnostics` returns the `DevError`; drive a request through the stubbed
   `serve`'s `logRequest` and assert `get_recent_requests` returns the `AccessEntry`; emit a
   route-refresh line and assert `tail_logs` returns it; **assert a foreign-Origin
   `tools/call` is rejected with `MCP_DEV_ORIGIN_REJECTED`**; assert every accepted
   `tools/call` recorded one audit record. This gate does **not** depend on estate's bespoke
   dev script and runs in CI under the coverage gate.
   Acceptance: the three tools resolve real live state over the loopback transport in one
   integration test; a foreign-Origin call is rejected; audit records assertable; typecheck
   + serial coverage gate green; 100%.

7a. **Migrate estate's dev entry onto `lesto dev`/`runDev`** — `[follow-on · not the gate]`
   Files: `examples/estate/dev.ts` (migrate off the bespoke `withDevReload` + `serve()` —
   `dev.ts:120,155,159` — onto `lesto dev`/`runDev` so the dev MCP server can appear),
   `examples/estate/*` (usage note), `examples/estate/test/*` as applicable.
   **Why a separate increment:** estate today runs a hand-rolled `dev.ts` that never calls
   `runDev`/`bin.ts` (its own polling reload model, `dispatchSitesDev` wiring, direct
   `serve()` call); migrating it **swaps estate's entire dev reload + serve mechanism** — it
   is NOT a tail-end tweak. This increment is the migration alone; it carries the risk that
   it may not land this wave, in which case the committed gate is Inc 6 and 7b waits.
   Acceptance: estate's `dev.ts` runs through `runDev`; estate's existing dev behaviour
   (live reload, route serving) is preserved through the migration; estate's own tests +
   regression stay green; typecheck + serial coverage gate green.

7b. **Dogfood the dev MCP surface on migrated estate** — `[per gallery-as-QA-gate · blocked on 7a]`
   Files: `examples/estate/test/*`, a dev-loop README/usage note.
   After 7a: `lesto dev` in estate stands the dev MCP server up; an MCP client calls
   `get_dev_diagnostics` after a deliberate route-file syntax error and reads the `DevError`,
   calls `get_recent_requests` after hitting a route and sees the access-log entry, and calls
   `tail_logs` and sees the route-refresh lines. Estate's **production build/deploy** is
   re-run and asserted to contain **no** dev MCP surface (the gallery gate's teeth, layered
   on the structural output test of Inc 5). Feature is not "gallery-done" until estate runs
   locally with the dev surface AND deploys without it.
   Acceptance: estate `lesto dev` exposes the three tools end-to-end; estate `build`/`deploy`
   artifact contains no dev-MCP/loopback-transport code (grep the artifact); estate's own
   tests + regression stay green; typecheck + serial coverage gate green.

## Layering invariants

Folded into the bar block above, and restated where load-bearing:
- **Inc 3:** `@lesto/mcp` defines the `devState` reader as its OWN interface and receives
  it injected on `LestoMcpContext` — **no** `@lesto/cli` import (grep-asserted in Inc 5).
- **Inc 4a/4b/4c:** the new loopback HTTP transport core lives in `@lesto/mcp`
  (`http-transport.ts`, covered; taking an injected context, no `@lesto/cli` import) and is
  *mounted* by the **bin** (above both kernel and mcp), never by `@lesto/kernel` —
  preserving the no-`kernel → mcp`-cycle invariant. The Origin/Host allowlist helper is
  defined once in `http-transport.ts` and reused by Inc 4c's live-reload WS retrofit (no
  duplicate validation).
- **Inc 4b/5:** the dev MCP server, and (in later phases) `GET /__lesto/open` + the
  browser-console ingest, are constructed **only** under the `command === "dev"` guard —
  the structural gate behind the ADR's "never in production" claim.

## Owned elsewhere (do not duplicate)

- **`buildTools`/`dispatch`/audit + the `read-only` floor** live in `@lesto/mcp`
  (`tools.ts`) and are *reused*, not reimplemented — the dev tools are added to `buildTools`;
  the audit path is the existing `dispatch` (`tools.ts:608-650`) and the `read-only` floor is
  `modeOf`'s default (`tools.ts:187-191`). This is the machinery ADR 0028 also builds on, not
  0028's own (unshipped) governance model.
- **NOT owned elsewhere — built here:** the loopback **HTTP** MCP transport. `@lesto/mcp` is
  stdio-only today (imports `server.ts:11-12`, instantiated `server.ts:85`); Inc 4a adds the
  covered `http-transport.ts` core + a thin `startMcpHttpServer` socket bind in `server.ts`.
  It *copies* the bin's `buildLiveReload` `127.0.0.1` posture + "busy-port → stay off"
  tolerance (`bin.ts:385-454`) as a pattern, **but adds the Origin/Host allowlist + token
  the live-reload WS lacks** (which Inc 4c retrofits back onto that WS); the HTTP transport
  itself is new code held to the full bar.
- **The access log + per-request `requestId`** are the runtime's
  (`runtime/src/server.ts:319` seam + call sites `1259,1287,1492`, `web/src/context.ts:58`)
  — `get_recent_requests` reads a ring fed via the `logRequest` seam (`server.ts:319`) that
  **Inc 2 (the core)** threads into `runDev`'s `serve` call; it does not create a second
  request log.
- **The request/LLM/tool span tree** `explain_request` (Phase 3) reads is fed by the
  **Phase-1 bounded request-span ring committed in Inc 1** (its real producer). A
  *durable/cross-restart* span store remains **ADR 0031's** to commit and only widens the
  retention window; the in-process ring is sufficient for the single-dev-process explain.
  This plan mints no spans of its own beyond the ring entries the access-log seam fills.
- **The dev-only client transform** the `data-lesto-loc` stamp (Phase 2) needs runs in
  `@lesto/assets`'s dev client build (`run.ts:1075`); this plan does not add it.

## Deferred (per ADR 0032 — not in this plan)

- **Phase 2** — the `data-lesto-loc` dev transform, `locate_element`, and the loopback
  `GET /__lesto/open` editor-jump endpoint. Gated on Phase 1 + a dev transform seam; the
  editor-jump is RCE-shaped (loopback + dev-only + project-root path constraint + coded
  refusal).
- **Phase 3** — `explain_request` (reads the **Phase-1 bounded request-span ring committed
  in Inc 1**, so it has a producer; fail-closed if the ring is absent, refuses per-call with
  `MCP_REQUEST_NOT_RETAINED` when a `requestId` has aged out; a *durable/cross-restart*
  store is ADR 0031's to commit and only widens retention, NOT a prerequisite), the
  `POST /__lesto/browser-console` ingest (mirrors the `BROWSER_SPANS_ROUTE` web receiver /
  `BROWSER_SPANS_PATH` observability precedent — `web/src/browser-spans.ts:40`, `rum.ts:41`),
  and the `X-Lesto-Trace` dev-only response header.
- **Mutating dev tools**, **streaming `tail_logs`**, and **live-DOM `locate_element`** —
  each gated on a real consumer (per the ADR's Deferred list).
