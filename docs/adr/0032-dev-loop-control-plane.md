# ADR 0032 — Dev-loop control plane (`lesto dev` as a live, governed MCP server + a source-location bridge)

- **Status:** Accepted (ratified 2026-06-23). **Phase 1** (a DEV-ONLY MCP
  server stood up by `lesto dev`, exposing read-only introspection tools —
  `get_dev_diagnostics`, `get_recent_requests`, `tail_logs` — over the existing
  `buildTools`/`dispatch`/audit machinery, over a **new loopback HTTP MCP transport**
  built in `@lesto/mcp` because the package is stdio-only today and stdio cannot share
  the dev process's stdout, reusing the **same audit + read-only floor `@lesto/mcp`
  already ships** — which ADR 0028 also builds on) is the committed build-now. The
  transport carries a **hard security posture** (Origin/Host allowlist + per-session
  token + the SDK's `enableDnsRebindingProtection`/`allowedHosts`; a foreign Origin is
  rejected with a coded refusal) — **a `127.0.0.1` bind alone is NOT the control** (a
  malicious browser tab / DNS-rebinding can still POST JSON-RPC to a loopback port). The
  same Origin check is **retrofitted onto the existing live-reload WS**. Phase 1 also
  commits a **bounded dev-only span ring** (the natural home: the access-log ring) so the
  request-explanation tool has a real producer to read. **Phase 2** (the `data-lesto-loc`
  source-location transform + `locate_element` + the loopback `GET /__lesto/open`
  editor-jump endpoint) is designed here and gated on Phase 1 + a dev-only oxc/swc
  transform seam. **Phase 3** (`explain_request` over a per-`requestId` span tree + the
  `POST /__lesto/browser-console` ingest + the `X-Lesto-Trace` response header) is
  designed here. `explain_request` reads the **Phase-1 bounded span ring committed in THIS
  ADR** (so it has a producer); a *durable / cross-restart* span store remains ADR 0031's
  to commit, and the deep tree-assembly leg is gated on it. **PREVIEW throughout:** every
  surface here is dev-loop machinery, marked PREVIEW and **coverage-gate-exempt only where
  it is irreducible socket-bind wiring** (the security-sensitive transport logic lives in
  a NEW covered module, NOT the coverage-excluded `server.ts`); the pure cores are held to
  the full bar. Revised twice 2026-06-22 — an internal adversarial pass that cut scope,
  then an independent red-team + chief-architect pass. See *Reviews*.
- **Date:** 2026-06-22
- **Deciders:** tech lead + owner (ratification pending).
- **Builds on / touches:** ADR 0023 (file-based routing / the `lesto dev` server — the
  `runDev` watch loop, `watchRoutes`/`watchIslands`, the forwarding handle, `DevError`
  + the `LiveReload` channel this composes); ADR 0028 (operator control plane —
  shares the **same audit sink + read-only floor `@lesto/mcp` already ships** that 0028
  also builds on; **note:** 0028's own MCP-governance model — Phase 3a — is *designed but
  unshipped* (gated on a roles store), so this ADR rides the pre-existing `@lesto/mcp`
  `dispatch`-audit + `read-only`-default machinery directly, **not** a shipped 0028
  governance gate; this is a *new MCP surface*, not a new governance model); ADR 0031
  (agent-observable runtime — its request/LLM/tool spans are what `explain_request` reads;
  Phase 3 is gated on 0031 shipping a *queryable per-`requestId` span store*, not merely its
  Phase-1 span emission). Composes `packages/cli` (`run.ts` `runDev`, `bin.ts`
  wiring, `dev-overlay.ts`, `mcp.ts`), `@lesto/mcp` (`tools.ts`, `server.ts`),
  `@lesto/observability` (request span ids, the `BROWSER_SPANS_PATH`/`BROWSER_SPANS_ROUTE`
  bounded-receiver precedent), and
  `@lesto/web` (the per-request `requestId`, the `/__lesto/*` reserved namespace).

## Context

This is the **dev-loop** member of the agent-native wave: ADR 0031 is the keystone the
wave observes through; **0032 (this ADR)** and 0033 are the dev-loop and preview
surfaces; 0034/0035 are the schema-contract and legibility/quality-gate batteries. ADR
0033's in-preview AI surface is **gated on this ADR's dev MCP server** — Cmd-K and
"fix-this" drive the tools defined here.

The concrete, demanded requirement: make the **inner dev loop legible to and drivable by
an agent**. While `lesto dev` runs, an external client (Claude, an editor agent) cannot
see the live process state that only the dev server holds — the current build/route
error, the last N requests, the server log, or *which source file rendered this
element*. Today that state is real but **trapped inside the running process**:

- **`lesto dev` already holds the dev error, but only paints it to the browser.** `runDev`
  models a `DevError` — `{ source: "client-rebuild" | "app-reload"; message; stack? }`
  (type alias `packages/cli/src/run.ts:131`, interface `run.ts:139-145`) — and tracks one
  live overlay (`run.ts:1081-1091`, `overlayUp`). A failed client rebuild or app reload is broadcast
  to the open browser via `liveReload.notifyError` (`run.ts:1104-1107`,
  `run.ts:1150-1151`); a stale edge-manifest regen stays a stderr line
  (`run.ts:1215-1217`). **There is no programmatic reader** — an agent cannot ask "what
  is currently broken?" The `DevError` exists; nothing exposes it.
- **`lesto dev` already prints per-change activity to a sink, but only as prose.** The
  route refresh logs `routes refreshed: …` and `app reload failed: …` through
  `deps.out` (`run.ts:1210-1216`, `run.ts:1233`); the bin wires `deps.out` to
  `console.log`. There is no structured log an agent can `tail`.
- **The runtime already access-logs every request, but the dev loop does not surface it.**
  The runtime records one structured access-log line per request, success or failure,
  through an injectable `logRequest` seam (`packages/runtime/src/server.ts:319`; the real
  emission call sites are `server.ts:1259,1287,1492`), and every request carries a minted
  `requestId` (`packages/web/src/context.ts:58`, `runtime/src/server.ts:142,1135,1334`).
  An agent debugging "why did my last POST 500?" has no `get_recent_requests`.
- **`lesto mcp` already stands up an MCP server — but as a SEPARATE one-shot command, over
  the production app, not the dev loop.** `runMcp` boots the app, builds a
  `LestoMcpContext`, and serves `buildTools`/`dispatch` over stdio
  (`packages/cli/src/mcp.ts:75-104`, `packages/mcp/src/server.ts:46-87`). It is **not**
  attached to `lesto dev`: `dev` and `mcp` are different commands
  (`run.ts:1513`, `bin.ts:560`). So there is no MCP surface that sees the *live dev*
  state above — `list_routes`/`handle_request`/the content tools operate on a freshly
  booted app, not the running watcher's process.
- **SSR'd elements carry no source provenance.** `render-page.tsx` emits island markup
  with no `data-*` loc attribute; there is no element→`file:line` bridge, so neither a
  human "click to jump to source" nor an agent "where is this rendered" is possible.
- **The browser console is invisible to the server.** RUM spans POST to a server
  receiver (`BROWSER_SPANS_PATH = "/__lesto/browser-spans"`,
  `packages/observability/src/rum.ts:41`; the `@lesto/web` receiver matches it as
  `BROWSER_SPANS_ROUTE`, `web/src/browser-spans.ts:40`), and a client-error beacon POSTs to
  `/__lesto/client-errors` (`packages/web/src/client-errors.ts:36`). But ordinary
  `console.log`/`console.error` in the browser never reaches the dev server — an agent
  reading server logs is blind to the client's own console.

What this is **not**: not a production observability surface (that is ADR 0031, on the
prod trace), not a second governance model (ADR 0028 owns that), not a remote/hosted
control plane (everything here is **loopback-only, dev-only**), and not a new telemetry
pipeline (`explain_request` *reads* ADR 0031's spans; it mints none).

## The keystone: one dev-only MCP surface over the state `lesto dev` already holds

The minimal sound abstraction is **a single dev-only MCP server, stood up by `lesto dev`
itself, whose tools read the live process state the watcher already owns** — reusing the
exact `buildTools`/`dispatch`/audit machinery `lesto mcp` ships, not a parallel one. The
dev loop is the *only* component that holds the current `DevError`, the route-refresh
activity, and the in-process access log together; an external agent gets at them **only**
by the dev server publishing them as MCP tools — which means the transport must run
**in-process with the watcher** (so it can read that live ring) and **not on stdout**
(which the dev process already owns). That rules out the existing stdio transport and is
why Phase 1 builds one new thing: a loopback HTTP MCP transport.

| Concern | Resolution from the one dev MCP surface |
|---|---|
| **"What is broken right now?"** | `get_dev_diagnostics` reads the live `DevError` + last route/build error the watcher tracks (`DevError` type `run.ts:131`, interface `run.ts:139-145`; the live overlay it tracks `run.ts:1081-1091`). |
| **"What did my app just do?"** | `get_recent_requests` reads a bounded ring fed from the runtime's access-log seam — `runDev` threads a `logRequest` into its `serve` call (`server.ts:319`, `AccessEntry` at `server.ts:127-142`) that appends to the ring. |
| **"Show me the server/browser log."** | `tail_logs` reads a bounded ring the dev loop appends `deps.out` lines to (+ Phase 3's browser-console ingest). |
| **"Where is this element defined?"** | `locate_element(selector) → file:line` reads the Phase-2 `data-lesto-loc` stamps. |
| **"Explain this request."** | `explain_request(requestId) → span tree + handler + SQL` reads the **Phase-1 bounded span ring committed here** (Phase 3 tool over a Phase-1 producer). |
| **Governance / audit** | Every dispatch rides the **existing** `@lesto/mcp` `dispatch` audit sink + `read-only` floor (`tools.ts:608-650`, `modeOf` default `tools.ts:187-191`) — there is no un-audited dev tool, exactly as in prod. (This is the same machinery ADR 0028 builds on; 0028's own governance model is unshipped, so 0032 does not depend on it.) |
| **Transport security** | The loopback HTTP transport enforces an **Origin/Host allowlist + per-session token** (the SDK's `enableDnsRebindingProtection` + `allowedHosts`, opt-in/default-OFF, turned ON here); a foreign Origin is rejected. The `127.0.0.1` bind (`bin.ts:407`) is necessary but **not** sufficient — a browser tab can reach loopback. |

This is minimal because it adds **no new governance model and no new telemetry pipeline**
— it is the existing `buildTools`/`dispatch`/audit machinery and read-only floor pointed at
the existing live dev state, plus a small read-only ring buffer the watcher fills. It adds
**one** new piece of mechanism — a loopback HTTP MCP transport — because the existing stdio
transport structurally cannot carry the dev surface (stdout is taken; an out-of-process
stdio server cannot see the in-process ring). That transport is net-new, security-sensitive,
and gets its own increment + acceptance. The other simplifications below are in *scope and
sequencing*, not in the model.

## Decision

Stand up a **dev-only MCP control plane** as part of `lesto dev`, reusing
`@lesto/mcp`'s `buildTools`/`dispatch`/audit and its `read-only` floor, over a **new
loopback HTTP MCP transport** (the package is stdio-only today — `server.ts:11-12`, the
transport instantiated at `server.ts:85`). Build in phases; commit only Phase 1 now. Every
surface is loopback-bound, **Origin/token-guarded**, and gated out of any production build
by a **structural dev-only sentinel** (see Phase 1.4).

### Phase 1 — build now: the dev MCP server + the three read-only introspection tools

Kept on the right side of the existing layering — the dev tools are pure handlers over an
injected live-state reader; the bin owns the socket and the process.

1. **A live dev-state ring, owned by `runDev` (CLI core).** `runDev` already tracks the
   live overlay state (`run.ts:1081`); extend that to a small, bounded in-process record
   the watcher updates: the *current* `DevError` (or `undefined` when clean), a bounded
   ring of recent `deps.out` log lines, a bounded ring of recent access-log entries
   (each an `AccessEntry` — `{ method, path, status, ms, requestId }`, `server.ts:127-142`),
   **and a bounded ring of recent request spans keyed by `requestId`** (the dev-only span
   producer `explain_request` reads — see Phase 3; this is the natural home, riding the
   access-log seam, so the request-explanation tool has a real Phase-1 producer rather than
   a phantom store). This is a **new injected seam** (`devState`) the bin *constructs*, but
   **`runDev` owns the wiring**: the watcher writes the `DevError` + log lines, and `runDev`
   threads a new `logRequest` (`server.ts:319`) into its `deps.serve` call
   (`run.ts:1159-1169`, which does **not** pass one today) so each served request appends to
   the ring. The bin cannot wire the access log — the dev `serve()` call lives in the core.
   `run.ts` stays a pure core over the seam (the watcher writes, the tools read). Every ring
   is fixed-size (deny-by-default on memory: a long dev session never grows unbounded).

2. **A dev tool set in `@lesto/mcp`, behind the existing audit + read-only floor.** Add
   `get_dev_diagnostics`, `get_recent_requests`, `tail_logs` to `buildTools` as
   **non-destructive** tools (`destructive: false`, the `destructive` field at
   `tools.ts:155`), each a thin handler reading the injected dev-state reader on
   `LestoMcpContext`. They reuse `dispatch`'s audit path unchanged (`tools.ts:608-650`) —
   every dev dispatch is audited like every prod one. Because they are read-only they run
   in `read-only` mode (the `modeOf` default — `tools.ts:187-191`); no operator escalation
   is introduced for Phase 1. This is the **pre-existing** `@lesto/mcp` posture, not ADR
   0028's (unshipped) governance model.

3. **`lesto dev` stands the server up on a NEW loopback HTTP transport, dev-only.**
   `buildTools`/`dispatch` are reused unchanged, but the *transport is net-new work*:
   `@lesto/mcp` ships **only** a `StdioServerTransport` today (imported `server.ts:11-12`,
   instantiated `server.ts:85`, connected `server.ts:87` — hardwired), and stdio is
   **unusable for the dev surface** because `lesto dev` writes its own logs to stdout
   (`bin.ts:649`, `out: console.log`; the bin even notes "the MCP protocol owns stdout" —
   `bin.ts:558`), so MCP-over-stdio in the dev process would corrupt the protocol. A
   *separate* `lesto dev mcp` stdio process would be the wrong shape too: it is a different
   process and cannot see the running watcher's in-process `DevError`/log/access ring — the
   very state this ADR exists to expose. So Phase 1 builds a **loopback-only localhost HTTP
   (Streamable-HTTP) MCP transport** in `@lesto/mcp`, serving the *same*
   `buildTools`/`dispatch`, mounted **by the dev command in the bin** (the same place
   `buildLiveReload` already binds a loopback WS — `bin.ts:385-454`, `hostname:
   "127.0.0.1"`), bound to `127.0.0.1` exactly as the live-reload socket already is
   (`bin.ts:402-407`), never a wider interface, never by the kernel, never on a prod build
   path.

   **The security-sensitive logic lives in a NEW covered module, NOT in `server.ts`.**
   `packages/mcp/src/server.ts` is wholesale coverage-excluded today (`vitest.config.ts:13`,
   "Pure wiring"). Putting the transport's request/response shaping, the Origin/Host check,
   and the token check there would make the "100% coverage" claim impossible (the
   security branches would silently escape the gate). So the testable transport core
   (request handling, Origin/Host/token validation, the foreign-Origin refusal) lives in a
   NEW non-excluded module `packages/mcp/src/http-transport.ts` held to the full 100% bar;
   **only the irreducible `bun.serve`/`http.listen` socket bind** stays in the excluded
   `server.ts` (a thin `startMcpHttpServer` that delegates to the covered core).

   **The bind alone is not the control — Origin/Host allowlist + per-session token.** A
   `127.0.0.1` bind does **not** stop a malicious page in the developer's own browser (or a
   DNS-rebinding attack) from POSTing JSON-RPC to `http://localhost:<port>/mcp`. The
   installed SDK (`@modelcontextprotocol/sdk` 1.29.0) ships exactly the right defense —
   `enableDnsRebindingProtection` + `allowedHosts`/`allowedOrigins`
   (`webStandardStreamableHttp.d.ts:84,90,96`), **opt-in and default OFF**. Phase 1 turns it
   ON: `enableDnsRebindingProtection: true` with `allowedHosts`/`allowedOrigins` pinned to
   `127.0.0.1:<port>`/`localhost:<port>`, **plus a per-session token** the dev command mints
   and the client must present, so a same-port foreign Origin or a missing/wrong token is
   **rejected with a coded refusal** — verified by a foreign-Origin-rejected test (plan Inc
   4a). Given `/__lesto/open` (Phase 2) spawns `$EDITOR` (drive-by-RCE shape) and
   `get_recent_requests` leaks request paths, this is a hard, non-negotiable acceptance.

   **Retrofit the same Origin check onto the live-reload WS.** The existing
   `buildLiveReload` WS (`bin.ts:407-413`) accepts **any** upgrade with no Origin check —
   any browser tab can connect and observe reload/error-overlay payloads (local source
   paths, stack frames). Phase 1 adds the same Origin/Host allowlist to that upgrade
   handler. **This HTTP transport is the one security-sensitive net-new surface in Phase 1**
   and carries its own coverage + bind-posture + Origin/token acceptance (plan Inc 4a).

4. **A structural dev-only sentinel + output test.** Beyond the construction guard, add a
   **runtime sentinel** that makes the RCE-shaped + transport surfaces refuse to register
   outside dev: the `/__lesto/open` route (Phase 2) and the MCP transport mount are wired
   through a `assertDevOnly()` guard that throws a coded `CLI_DEV_SURFACE_IN_PRODUCTION`
   error if reached on a `serve`/`build`/`deploy` path — so a hand-wired or mis-copied app
   dev entry **cannot** mount them in prod even if it bypasses the `command === "dev"`
   branch. A **structural test asserts `serve()`/`build()`/`deploy()` output contains NO
   `/__lesto/open` route and NO MCP transport mount** (greps the produced artifact /
   route table), making the "never in production" claim a tested invariant, not just a
   code-path argument.

**Fail-closed / dev-only defaults.** The dev MCP surface is constructed **only** on the
`command === "dev"` path (mirroring how `liveReload` is built only for `dev` —
`bin.ts:615`). A production `serve`/`build`/`deploy` never constructs it, never binds the
socket, and the dev-only modules are import-gated so they cannot reach a prod bundle (the
`lesto dev` watcher already only touches dev paths — `bin.ts`). This gate is **explicit,
grep-asserted, AND backed by the runtime sentinel + output test above** (see the plan).

Scope discipline: Phase 1 is additive, introduces no new runtime dependency for
`@lesto/mcp` (the dev-state reader is an *injected* seam, not an import of the CLI), and
the tool handlers + ring buffer are 100%-testable as pure functions over a fake
dev-state reader.

### Phase 2 — designed here, gated on Phase 1 + a dev transform seam: the source-location bridge

1. **A dev-only `data-lesto-loc` transform.** An oxc/swc dev transform stamps
   `data-lesto-loc="app/islands/Hero.tsx:12"` onto SSR'd islands/elements — the substrate
   for both "click an element → jump to source" (a human affordance) and an
   agent-readable element→`file:line` map. It runs **only** in the `dev` client build
   (`buildClientIfPresent(deps, …, "dev", …)`, `run.ts:1075`) — the `production` build
   path (`run.ts:919`, `run.ts:1379`) never applies it, so no loc attribute reaches a
   shipped artifact. Stated and grep-asserted: the transform is dev-mode-only.

2. **`locate_element(selector) → file:line`** — a dev MCP tool that resolves a selector
   against the live DOM's `data-lesto-loc` stamps (the agent supplies the rendered HTML or
   a selector; the tool returns the stamped source location). Read-only, audited.

3. **`GET /__lesto/open?file=&line=` — the editor-jump endpoint.** Spawns `$EDITOR` /
   `code -g <file>:<line>`. **This is an RCE-shaped surface and is gated hard:** it is
   registered **only** under `lesto dev`, bound **loopback-only**, lives under the
   framework-reserved `/__lesto/*` namespace (`runtime/src/sites.ts:87`,
   `sites.ts:370`), and its `file` argument is **constrained to within the project root**
   (no traversal, no absolute paths outside the tree) — an out-of-tree or traversing path
   is refused with a coded error, never spawned. It is **never** present in
   `serve`/`build`/`deploy`.

### Phase 3 — designed here, reading the Phase-1 span ring: request explanation + the browser bridge

1. **`explain_request(requestId) → span tree + handler source + SQL`.** This *reads* the
   **bounded dev-only span ring committed in Phase 1** (keyed by `requestId`, the per-request
   id already minted — `web/src/context.ts:58`) and assembles request → handler →
   `db.query` children (the tree ARCHITECTURE.md §7 describes) plus the handler source
   location and the SQL the query spans carry. **It mints no spans** — it is a pure read.
   Because Phase 1 commits the producer (the access-log-adjacent span ring), `explain_request`
   has a real, bounded, in-process store to read — **it is no longer gated on a phantom
   substrate.** What remains ADR 0031's to commit is a *durable / cross-process* span
   store; the in-process Phase-1 ring is sufficient for the single-dev-process explain. If a
   `requestId` has aged out of the bounded ring, the tool refuses with a coded
   `MCP_REQUEST_NOT_RETAINED` rather than fabricating. Read-only, audited.

2. **`POST /__lesto/browser-console` — the browser-console ingest.** Mirror the existing
   browser-spans receiver precedent exactly (`BROWSER_SPANS_PATH` `rum.ts:41`; the web
   receiver `BROWSER_SPANS_ROUTE` `web/src/browser-spans.ts:40`, with its bounded body +
   coded 413 at `browser-spans.ts:260-266`): a dev-only
   receiver that accepts forwarded browser `console.*` lines so they reach the server's
   `tail_logs` ring and thus the agent. Dev-only, loopback, bounded — the same posture as
   the spans receiver.

3. **An `X-Lesto-Trace` response header** exposing the request's span ids
   (`traceId`/`spanId`, the 32-hex ids `@lesto/observability` mints —
   `observability/src/types.ts:17-18`) to the panel/agent, so a client can correlate a
   response to its `explain_request` tree. Dev-only; not emitted by a production response.

**Ordering within the wave:** Phase 3's `explain_request` reads the **Phase-1 span ring
committed in this ADR**, so it has a producer and does not block on ADR 0031. The tool
still fails-closed if the ring is absent (refuses to register without a span source) and
refuses per-call with `MCP_REQUEST_NOT_RETAINED` when a `requestId` has aged out — never
fabricating a tree. A *durable/cross-restart* span store (ADR 0031's to commit) only
extends the retention window; it is not a prerequisite for the in-process explain.

## Non-goals

- **Not a production surface.** Nothing here may appear in a production build, bundle, or
  deploy — the dev MCP server, the `data-lesto-loc` stamps, `GET /__lesto/open`, the
  browser-console ingest, and `X-Lesto-Trace` are **all** gated to `lesto dev`. Stated
  loudly because the editor-jump endpoint is RCE-shaped: shipping it would be a remote
  code-execution hole.
- **Never remote, never wider than loopback — but loopback bind is not the only control.**
  Every socket/endpoint binds `127.0.0.1` (matching the existing live-reload socket —
  `bin.ts:402-407`); none is ever exposed to the LAN or the internet. **Loopback bind is
  necessary but not sufficient** (a browser tab / DNS-rebinding reaches loopback), so the
  transport additionally enforces an Origin/Host allowlist + per-session token. A remote
  dev control plane is explicitly out of scope.
- **Not a new governance model.** The audit sink and the `read-only` floor are the
  **pre-existing `@lesto/mcp`** machinery (`dispatch` audit `tools.ts:608-650`, `modeOf`
  default `tools.ts:187-191`) — the same machinery ADR 0028 also builds on. This composes
  them; it forks neither, and it does **not** depend on 0028's own (unshipped) governance
  model.
- **Not a new telemetry pipeline.** `explain_request` reads ADR 0031's spans; it emits
  none. No parallel trace path.
- **Not an editor/IDE plugin.** `GET /__lesto/open` shells to the user's existing
  `$EDITOR`; Lesto ships no editor extension.
- **No silent fail-open.** The dev surface is off unless `lesto dev` turned it on;
  out-of-tree file opens are refused, not best-effort.

## Deferred — recorded, not scheduled; each gated on a real consumer

- **Mutating dev tools** (a `restart_dev`, an `apply_patch`, a `run_migration` from the
  dev panel) — gated on a real agent workflow that needs them *and* on extending ADR
  0028's operator gate to the dev surface. Phase 1 ships read-only only; an escalation is
  a deliberate, separate, loud step.
- **A streaming `tail_logs`** (MCP server-sent updates rather than a bounded snapshot
  ring) — gated on an MCP client that consumes a stream; the snapshot ring is the
  minimal first cut.
- **`locate_element` by live-DOM query** (the dev server querying the open page's DOM
  rather than the agent supplying HTML) — gated on a bidirectional dev-page channel; the
  `data-lesto-loc` stamp + agent-supplied selector is the minimal substrate.
- **Reusing the dev MCP transport for the in-preview AI surface (ADR 0033)** — recorded
  here as the *consumer*: 0033 rides this server's tools rather than standing up its own.
- **Correction from review:** the dev MCP server must **not** be mounted on the dev HTTP
  app's route table as just another `/__lesto/*` route if that couples the MCP transport
  into `@lesto/web`'s request path in a way a prod build could inherit. The loopback HTTP
  transport is a **separate** bin-owned server (like the live-reload socket), so the
  dev-only gate is structural, not a runtime flag on a shared handler.

## Reviews

- **Internal adversarial pass (correctness/security · simplicity/scope ·
  sequencing/coupling).**
  - *Correctness/security:* surfaced that `GET /__lesto/open` is an **RCE-shaped**
    surface and tightened it to loopback-only + dev-only + a project-root path
    constraint with a coded refusal; confirmed every socket must bind `127.0.0.1` like
    the existing live-reload server (`bin.ts:402-407`); required the dev-only gate to be
    **structural** (a separate bin-owned transport, not a flag on a shared `@lesto/web`
    handler that a prod build could inherit).
  - *Simplicity/scope:* **cut** all mutating dev tools from the build-now (Phase 1 is
    read-only introspection); **cut** streaming `tail_logs` to a bounded snapshot ring;
    **withdrew** the idea of a brand-new MCP governance model in favor of reusing ADR
    0028's `dispatch`/audit and read-only floor unchanged; pinned the dev-state reader as
    an **injected seam** so `@lesto/mcp` gains no `@lesto/cli` import.
  - *Sequencing/coupling:* flagged that `explain_request` (Phase 3) **rests on ADR 0031**
    not yet shipping its spans, and made it fail-closed / register-gated on a span
    source; flagged the latent **`kernel → mcp` cycle risk** — the dev transport is
    mounted by the *app/bin* (above both), never by kernel; ordered the `data-lesto-loc`
    transform to be dev-build-only so it can never reach a production artifact.
  - The **one dev MCP surface** keystone and the three read-only Phase 1 tools survived
    as already-minimal.
- **Second internal adversarial pass (2026-06-22, correctness/honesty/layering · 3
  must-fix).** A re-review of the draft above caught four substantive errors and four
  reference nits; all applied:
  - *Transport (must-fix ×2):* the draft claimed Phase 1 "reuses `runMcp`'s pattern over
    stdio and/or a loopback HTTP endpoint." **Corrected:** `@lesto/mcp` is **stdio-only**
    today (`server.ts:11-12,56-58` — hardwired `StdioServerTransport`); a loopback HTTP
    MCP transport is **net-new work**, given its own increment (plan Inc 4a) with its own
    coverage + bind-posture acceptance. And stdio is **self-defeating** for the dev surface:
    `lesto dev` owns stdout (`bin.ts:649,558`), so in-process stdio would corrupt the
    protocol, and an out-of-process `lesto dev mcp` could not see the watcher's in-process
    ring. The two transport bullets collapsed into **one loopback HTTP transport**.
  - *Estate dogfood (must-fix):* the QA gate assumed `lesto dev` in estate runs through
    `runDev`/`bin.ts`, but estate runs a **bespoke `examples/estate/dev.ts`** (its own
    `withDevReload` + `serve()`, `dev.ts:120,155,159`) that never calls `runDev`. **Corrected:**
    added an explicit increment to migrate estate's dev entry onto `lesto dev`/`runDev`
    *before* the dogfood gate (plan Inc 5a), and made the gate's primary teeth a CLI-runDev
    integration test (plan Inc 6) so it is achievable against the real path.
  - *0028 governance attribution (should-fix):* the draft implied it rides a *shipped* ADR
    0028 governance gate; 0028's MCP-governance (Phase 3a) is **designed, unshipped** (gated
    on a roles store). **Corrected** every reference to attribute reuse to the **pre-existing
    `@lesto/mcp` `dispatch`-audit + `read-only` floor** that 0028 also builds on.
  - *Access-log wiring (should-fix):* the draft said the *bin* feeds the access-log ring via
    a serve option. But the dev `serve()` call lives in the **core** (`run.ts:1159-1169`) and
    passes no `logRequest`. **Corrected:** `runDev` threads a new `logRequest`
    (`server.ts:319`) into its `deps.serve` call into the ring (plan Inc 2 owns it); the bin
    only constructs the ring.
  - *Reference drift (should-fix):* fixed the web receiver constant to `BROWSER_SPANS_ROUTE`
    (web) vs `BROWSER_SPANS_PATH` (observability); used the real `AccessEntry` field `ms`
    (not `durationMs`); tightened the `DevError` spans (type `run.ts:131`, interface
    `run.ts:139-145`).
  - *Phase 3 / 0031 dependency (should-fix):* re-stated the gate as **a queryable
    per-`requestId` span retention/query store**, not merely 0031's span *emission* (its
    committed Phase 1), so the dependency is honest.
  - *Accepted as-is:* the keystone-first ordering, the loopback + dev-only + project-root
    path-constraint posture for `GET /__lesto/open`, and the `no-kernel→mcp` /
    `no-cli-import-into-mcp` invariants were re-verified correct (mcp depends on kernel
    `mcp/package.json:16`; cli depends on mcp `cli/package.json:29`; no reverse edge).
- **Independent red-team + chief-architect pass (2026-06-22).** A separate review fleet
  (per-ADR + cross-cutting lenses) and a chief-architect synthesis reviewed this ADR
  alongside 0031/0033/0034/0035. Verdict: **revise**. Concrete must-fixes applied:
  - *Security (must-fix):* the draft cited `127.0.0.1` bind 12+ times as THE control. A
    loopback bind does **not** stop DNS-rebinding / a malicious browser tab POSTing
    JSON-RPC to localhost, and `GET /__lesto/open` spawning `$EDITOR` is drive-by-RCE
    shape. **Added a hard acceptance:** Origin/Host allowlist + per-session token + the
    SDK's `enableDnsRebindingProtection`/`allowedHosts` (default OFF — turned ON here,
    `webStandardStreamableHttp.d.ts:84,90,96`), with a **foreign-Origin-REJECTED test**.
    **Retrofitted the same Origin check onto the existing live-reload WS** (`bin.ts:407-413`
    accepts any upgrade with no Origin check today).
  - *Buildability (must-fix):* the draft put the security-sensitive `startMcpHttpServer` in
    `server.ts`, which `vitest.config.ts:13` excludes wholesale — "in excluded file AND
    100%" is self-contradictory. **Moved the testable transport core (request/response
    shaping, Origin/Host/token validation) to a NEW covered module
    `packages/mcp/src/http-transport.ts`; only the irreducible socket bind stays in the
    excluded `server.ts`** (plan Inc 4a).
  - *Structural dev-only sentinel (must-fix):* added a runtime `assertDevOnly()` guard +
    a **test that `serve()`/`build()`/`deploy()` output contains NO `/__lesto/open` route
    and NO MCP transport mount** (Phase 1.4 / plan Inc 5), so a mis-wired app dev entry
    cannot mount them in prod even if it bypasses the `command === "dev"` branch.
  - *Phantom substrate (must-fix):* the draft gated `explain_request` on "a queryable
    per-`requestId` span store NO ADR builds." **Resolved by committing a bounded dev-only
    span ring to THIS ADR's Phase-1 scope** (the natural home: the access-log ring);
    `explain_request` now reads that committed producer and is **no longer gated on vapor**.
    A durable/cross-process store remains 0031's to commit but is not a prerequisite; an
    aged-out `requestId` refuses with `MCP_REQUEST_NOT_RETAINED`.
  - *Sequencing (must-fix):* **split Inc 7** (estate `dev.ts` → `runDev` migration) into
    **7a (migrate)** + **7b (dogfood)**, and made **Inc 6 (CLI-`runDev` integration test)
    the COMMITTED QA gate** — estate's bespoke `dev.ts` migration is large and may not land
    this wave; the gallery dogfood is a follow-on, not the gate.
  - *Citations (must-fix):* re-anchored every stale `tools.ts`/`server.ts` line ref to the
    current tree (dispatch+audit `527-567`→`608-650`; `modeOf` `122-123`→`187-191`;
    `destructive` `104`→`155`; `requireContentDb` `110-119`→`161-169`; hardwired stdio
    `56-58`→`85`; `startMcpServer` `24-58`→`46-87`; `AccessEntry` `127-134`→`127-142`;
    access-log emission `1232,1279`→call sites `1259,1287,1492` over the `server.ts:319`
    seam; `requestId` `142,1329`→`142,1135,1334`; mcp→kernel `mcp/package.json:18`→`:16`).
  - *Accepted as-is:* the keystone (one dev MCP surface over already-held state), the three
    read-only Phase-1 tools, the injected-`devState`-seam layering (no `@lesto/cli` import
    into `@lesto/mcp`), the no-`kernel→mcp` invariant, and the loopback + dev-only +
    project-root path-constraint posture for `GET /__lesto/open` were re-verified correct.

## Consequences

- The inner dev loop becomes **legible to an agent**: "what's broken," "what did my app
  just do," "show me the log," "where is this element," "explain this request" — each a
  governed, audited MCP tool, reusing the machinery `lesto mcp` already ships rather than
  a parallel one.
- Phase 1 turns state the dev watcher *already holds but hides* (`DevError`, the route
  activity, the access log) into a read-only, audited surface — additive, dev-only,
  loopback, 100%-testable over a fake dev-state reader.
- ADR 0033's in-preview AI surface gets its substrate: Cmd-K / fix-this drive **these**
  tools, so 0033 stands up no transport of its own.
- The cost is concentrated in the **security gating**, not the tools: the editor-jump and
  browser-console surfaces are RCE-/ingest-shaped, so their loopback-only + dev-only +
  path-constrained gating is the most security-sensitive piece and must clear its own
  review. The tools themselves are thin reads.
- Slow iteration upheld: only the read-only Phase 1 MCP surface lands first; the
  source-location bridge (Phase 2) and the request-explanation + browser bridge (Phase 3,
  behind ADR 0031) follow behind it, each gated on its real prerequisite.
