# In-preview AI surface — implementation plan

Derived from **ADR 0033** (in-preview AI surface). The committed scope is **Phase 1**,
and it is **inspect-only**: a second dev-only browser-injected `<script>` — a Cmd-K chat
overlay + an "Ask Claude to fix" button on the existing dev error overlay — that
assembles a read-only full-stack context snapshot, **redacts it before it can reach an
external model**, renders the agent's reply, and ships the dev MCP bridge as a
**fail-closed seam gated by a positive read-tool allowlist** (it **mutates nothing**).
**Commit gate:** Phase 1 is *inert* without a 0032 read-only dev MCP server to dispatch
to, so the Phase-1 commit is **gated on a demonstrated 0032 consumer** (a wired read-only
dispatch the overlay round-trips against — the deterministic `runDev` integration gate,
Inc 6a).
**Acting** (issuing a governed mutation from a chat turn / fix-this) is **Phase 2 —
Deferred**: no real 0032 write/edit verb exists today (grep for `edit_file`/`write_file`/
`apply_edit` is empty), and the interim operator-mode fallback is rejected for destructive
verbs (`McpAuditRecord` has no actor field, `tools.ts:77`). **Phase 3** (alt-click
point-and-describe via `data-lesto-loc`) is gated on **ADR 0032** shipping `data-lesto-loc`
+ `/__lesto/open`. **Phase 4** (live agent-activity panel) is **Deferred**: ADR 0031 adds
**no new exporter/span-feed seam** ("No new exporter or telemetry path"), so this ADR
invents none — it waits on 0031 owning a span-feed seam + per-`requestId` store. The whole
surface is **PREVIEW** (composes `@lesto/ai` / `@lesto/ui-generate`) and **dev-only**
(never injected by a production command). **Coverage reality: only `@lesto/ai` is
gate-exempt** (no `test:cov`); `@lesto/ui-generate` declares `test:cov` and is gated at
100%, and the `@lesto/cli` code this plan adds is held to the full 100% gate.

**Packages:**
- `@lesto/cli` — owns the dev-overlay client builders and the `runDev` injection seam;
  the only package that gains code in Phase 1.
- `@lesto/ui-generate` (PREVIEW label, **but coverage-GATED at 100%** — it declares
  `test:cov`) — the existing `generateUi` the chat can drive; not modified, consumed via
  the dev MCP server's `generate_ui` tool. *(Only `@lesto/ai` is coverage-exempt — it
  declares no `test:cov`. "Preview" is a label, not a coverage waiver.)*
- `@lesto/mcp` — the dev MCP tool surface the overlay acts through (owned by ADR 0032);
  injected as a seam, not depended on at runtime here.
- `@lesto/observability` — the span feed Phase 4 reads (owned by ADR 0031); injected.
- `examples/estate` — the dogfood / QA gate: the overlay must inject, paint, and round-
  trip a chat turn against the dev MCP server in the running estate dev app.

> **The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on
> touched packages; `bun run ws:typecheck` + the serial coverage gate
> (`bun scripts/coverage-gate.ts`) green; coded errors; truthful doc comments; one
> conventional commit on `main`. Layering invariants, grep-asserted: `@lesto/cli` gains
> **no** runtime `@lesto/mcp` / `@lesto/auth` / `@lesto/ai` import (the dev MCP dispatch
> and span feed are **injected seams** on `CliDeps`, the same as `liveReload?` /
> `watchRoutes?`); the AI overlay builder is referenced **only** from `runDev`, never
> from `runServe` / `runBuild` / `runDeploy` (grep-asserted — no production code path);
> all dynamic overlay content is written via `textContent`, **never** `innerHTML`
> (grep-assert no `innerHTML` in the overlay builders — `dev-overlay.ts:33-39`, sites
> `:33,35,37,39`); the context payload **never** leaves the process without passing the
> tested `redactContext` stage (Inc 4b — no absolute paths, SQL bind values, env/secret-
> shaped tokens, or raw console lines); the dev MCP dispatch is gated by a **positive
> read-tool allowlist** in `dispatchAiTurn` (Inc 3) with a negative test; PREVIEW surfaces
> composing `@lesto/ai` / `@lesto/ui-generate` are labelled PREVIEW in code and any public
> copy. **Coverage:** only `@lesto/ai` is gate-exempt (no `test:cov`); `@lesto/ui-generate`
> and `@lesto/cli` declare `test:cov` and hit 100%.

## Increments

1. **The dev AI overlay client string (chat panel, no actions yet)** — `[keystone]`
   Files: `packages/cli/src/ai-overlay.ts` (new), `packages/cli/test/ai-overlay.test.ts` (new).
   Add `aiOverlayClientScript(options)`, a pure string builder beside
   `devReloadClientScript` (`dev-overlay.ts:23`) — a self-contained IIFE that paints a
   Cmd-K-toggled chat panel, renders messages via `textContent` only (mirroring
   `dev-overlay.ts:33-39`, sites `:33,35,37,39`), with no socket and no side effects so a test can eval it
   against a DOM. It POSTs a chat turn to a relative dev endpoint and renders the reply;
   absent a configured endpoint it paints an inspect-only "dev MCP server not available"
   state (fail-loud). This is the keystone: a thin, fully-testable injected surface that
   owns no capability.
   Acceptance: `aiOverlayClientScript` evals against a JSDOM with a stub `fetch` and
   asserts the panel toggles on the Cmd-K keydown, renders a reply via `textContent`,
   and paints the not-available state when no endpoint is configured; grep-assert no
   `innerHTML` in the file; oxlint/oxfmt clean; `ws:typecheck` + serial coverage gate
   green; coverage 100%.

2. **Inject the AI overlay through the existing dev append seam (dev-only)** — `[the binding]`
   Files: `packages/cli/src/run.ts`, `packages/cli/test/run.test.ts`.
   Add an optional `aiOverlay?` seam to `CliDeps` (same shape/discipline as
   `liveReload?`, `run.ts:316`; `watchRoutes?` at `run.ts:282`) carrying the overlay
   script + the dev-MCP dispatch endpoint config. In `runDev` (`run.ts:1054`) only,
   append the AI overlay as a second
   sibling trailing `<script>` via the same `appendToBody` path `withLiveReload` uses
   (`run.ts:980-993,1012-1031`) — never modifying the live-reload script, never touching
   `runServe`/`runBuild`/`runDeploy`. Absent the seam, behaviour is unchanged.
   Acceptance: a test with a fake `aiOverlay` seam asserts the dev HTML response carries
   both the live-reload and AI overlay `<script>` tags (string and streamed bodies),
   and that a non-HTML response passes through untouched; a test asserts `runServe` /
   `runBuild` / `runDeploy` never inject it; grep-assert the AI overlay builder is
   referenced only under the `dev` path; `@lesto/cli` gains no new runtime package
   import (grep-assert); coverage 100%; gate + typecheck green.

3. **The dev MCP bridge dispatch seam — fail-closed via a POSITIVE read-tool allowlist (Phase 1: no mutation)** — `[order-critical]`
   Files: `packages/cli/src/ai-bridge.ts` (new), `packages/cli/test/ai-bridge.test.ts` (new), `packages/cli/src/errors.ts`.
   Add a pure `dispatchAiTurn(deps, turn)` core that takes the overlay's assembled
   context turn and, **before touching the seam, checks the requested tool name against a
   positive allowlist of read-only tool names** (`const READ_TOOL_ALLOWLIST =
   ["list_content_collections"] as const`). Only when (a) the name is on the allowlist
   **and** (b) an **injected** `dispatchDevTool` seam is present does it forward the
   request (same injection discipline as `generateUi?`, `tools.ts:121-122`). **This is the
   load-bearing security boundary** (must-fix from review): it is a positive allowlist,
   **not** a "mutation-shaped" heuristic and **not** a write-verb denylist — so even a
   consumer that injects a write-capable `dispatchDevTool` cannot reach a write tool
   through Phase 1. Any tool name **not on the allowlist** (an unknown name, not merely a
   write-shaped one) throws a coded `CLI_DEV_MCP_UNAVAILABLE` (added to `CliError`'s code
   union, SCREAMING_SNAKE per `packages/queue/src/errors.ts`) which the overlay renders as
   the inspect-only not-available state — never a browser-side write, never fail-open.
   Acting (forwarding a mutation to a named governed tool) is **Deferred to Phase 2**,
   gated on 0032 committing a real verb; the allowlist guarantees no ungoverned mutation
   path can exist before then.
   Acceptance: tests cover (1) the allowlisted-read forwarding branch (name on allowlist
   + seam present); (2) the **negative test** — a **non-allowlisted tool name** (e.g. a
   mutation-shaped `update_content_entry`, *and* an unknown name like `frobnicate`) is
   refused with `CLI_DEV_MCP_UNAVAILABLE` **even when a write-capable seam is injected**;
   (3) the absent-seam coded-error branch; the error is branched on by **code**, not
   message; `@lesto/cli` gains no runtime `@lesto/mcp` import (grep-assert — seam only);
   coverage 100%; gate + typecheck green.

4a. **Read-only full-stack context assembly** — `[committed]`
   Files: `packages/cli/src/ai-context.ts` (new), `packages/cli/test/ai-context.test.ts` (new).
   Add a pure `assembleContext(snapshot)` that builds the bounded "context in" payload:
   current route/path, handler `file:line` *if* a `data-lesto-loc` value is present
   (degrades to route-only — ADR 0032 owns the attribute), the last request's `traceId`
   (the **id only**, never span text), and the content collections via the injected
   `list_content_collections` read tool. The browser half lives in the overlay string
   (Inc 1); this is the typed assembler/validator the overlay and bridge share. The
   payload is **always** passed through `redactContext` (Inc 4b) before it can leave the
   process.
   Acceptance: tests cover the with-`data-lesto-loc` and degraded route-only branches,
   the collections-present and absent branches, and assert the assembled payload only ever
   carries the typed allowed fields (type + runtime guard); coverage 100%; gate +
   typecheck green.

4b. **A tested redaction stage on the context payload (Phase-1 security acceptance)** — `[must-fix: SECURITY]`
   Files: `packages/cli/src/ai-redact.ts` (new), `packages/cli/test/ai-redact.test.ts` (new), `packages/cli/src/errors.ts`.
   Add a pure `redactContext(payload)` that runs on **every** field before it can be
   forwarded to an external LLM — because the payload is **not** "RUM-equivalent
   paths+timing": it carries `DevError.stack`/`.message` (absolute paths + secret-shaped
   tokens, `run.ts:139-145`) and later SQL/trace text. It must: (1) **strip absolute
   filesystem paths** from stack frames and messages (rewrite to repo-relative or
   `<path>` — no `/Users/...`/home/machine path escapes); (2) **strip SQL bind values**
   (keep query *shape* only, never literal binds); (3) **redact env/secret-shaped tokens**
   (high-entropy strings, `KEY=`/`SECRET=`/`TOKEN=`/`Bearer …`/connection-string shapes →
   `<redacted>`); (4) **drop raw browser-console lines** entirely in Phase 1. `dispatchAiTurn`
   (Inc 3) and the fix-this button (Inc 5) call `redactContext` before the bridge sees the
   payload; a coded error guards a redactor-bypass path so the model can never receive a
   non-redacted payload.
   Acceptance: positive stripping tests — a stack with an absolute path, a message
   embedding a secret-shaped token, and a SQL string with bind values are each redacted
   before the bridge is invoked; an attempt to dispatch a non-redacted payload is a coded
   refusal; coverage 100%; gate + typecheck green.

5. **"Ask Claude to fix" on the existing dev error overlay (inspect-only: explain, not act)** — `[reuses Inc 1, 3, 4a, 4b]`
   Files: `packages/cli/src/dev-overlay.ts`, `packages/cli/test/dev-overlay.test.ts`.
   Extend `devReloadClientScript`'s error overlay (`dev-overlay.ts:28-39`) with one
   `textContent`-rendered button that hands the `DevError` the overlay already holds
   (`{ source, message, stack? }`, `run.ts:139-145`, broadcast via `notifyError`, declared
   `run.ts:172`, called `run.ts:1090`) to the bridge (Inc 3) **after `redactContext`
   (Inc 4b) strips its absolute paths + secret-shaped tokens** — zero new error-capture
   path, reusing the existing payload. **In Phase 1 this is explain-only**: the bridge
   renders the agent's read-only diagnosis; it issues no edit (issuing the fix is the
   Phase-2 acting change, **Deferred**, gated on a real 0032 edit-file verb). The button
   appears only when the AI overlay seam is configured.
   Acceptance: a DOM test asserts the button paints on an `{type:"error",…}` frame,
   carries the **redacted** `DevError` to a stub bridge on click (a test with an
   absolute-path stack asserts the path is stripped before the bridge sees it), renders
   the read-only reply (no mutation issued), and is absent when no AI seam is configured;
   grep-assert no `innerHTML`; the existing overlay tests still pass unchanged; coverage
   100%; gate + typecheck green.

6a. **The real committable gate: a deterministic `runDev` injection + round-trip integration test** — `[commit gate — must-fix: buildability]`
   Files: `packages/cli/test/run.integration.test.ts` (new).
   The review showed `examples/estate/dev.ts` runs a **bespoke** dev loop (it imports
   `dispatchSitesDev` + `serve` from `@lesto/runtime` and appends its **own**
   poll-`/__lesto/version` reload script — `dev.ts:29,94,117); it never calls the CLI's
   `runDev`, never constructs `CliDeps`, never touches `withLiveReload`. So an
   "estate dev HTML carries the overlay" acceptance is **non-deterministic** as written.
   The deterministic, always-runnable gate is an integration test that drives **`runDev`
   itself** with a fake app + a fake (read-only, allowlisted) `dispatchDevTool` seam and
   asserts: the dev HTML response carries **both** the live-reload and AI overlay
   `<script>` tags; a `list_content_collections` chat turn round-trips through the
   allowlist + seam and renders read-only; a non-allowlisted turn paints not-available;
   and `runServe`/`runBuild`/`runDeploy` inject nothing. **This** is the gallery-as-QA
   gate for Phase 1 — and it is the **commit gate**: the Phase-1 commit lands only once a
   real 0032 read-only dispatch is available to wire into this test (the "demonstrated
   0032 consumer" the ADR requires). Until then the test runs against the read-only stub.
   Acceptance: the `runDev` integration test passes deterministically (no estate
   dependency); both-scripts-present + round-trip + not-available + no-prod-injection
   branches covered; coverage 100%; gate + typecheck green.

6b. **Dogfood in `examples/estate` (conditional on estate adopting the CLI dev path)** — `[per gallery-as-QA-gate; conditional]`
   Files: `examples/estate/dev.ts` (the dev **bin** that builds the dev wiring — NOT
   `lesto.app.ts`, the app-config factory, which is the wrong layer for `CliDeps` seams),
   `examples/estate/test/*` (a dev-injection assertion).
   Estate's dev.ts today is a bespoke `dispatchSitesDev` + `serve` + poll-reload entry
   that does **not** go through `runDev`/`CliDeps`. Two honest options, pick one and state
   it: **(a)** migrate estate's dev bin onto the CLI `runDev` path (an explicit, separate
   prerequisite — it swaps estate's entire dev mechanism, so it is NOT folded into this
   increment), then provide the `aiOverlay` + `dispatchDevTool` seams there; or **(b)**
   keep this increment **deferred** behind that migration and let Inc 6a be the binding
   gate. Do **not** leave acceptance on an "if/where estate adopts" conditional. When (a)
   lands: the `dispatchDevTool` seam points at ADR 0032's dev MCP server when present,
   otherwise the inspect-only state; assert the dev HTML carries the AI overlay
   `<script>` and that estate builds/deploys with **no** AI overlay in the production
   artifact.
   Acceptance: **either** estate dev (post-migration) injects + paints the overlay locally
   with the prod artifact carrying no AI overlay script (grep-assert) and seam wiring in
   `examples/estate/dev.ts` not `lesto.app.ts` (grep-assert); **or** this increment is
   explicitly marked deferred-pending-estate-migration with Inc 6a as the gate; coverage
   100% on touched packages; gate + typecheck green.

7. **Docs: label the surface PREVIEW** — `[docs]`
   Files: `docs/adr/0033-in-preview-ai-surface.md` (already written), a dev-loop doc/README note.
   State plainly that the in-preview AI surface is dev-only and PREVIEW; do **not** imply
   a hosted product, "Lesto Cloud", or a v0/Bolt competitor (`messaging.md:77`); do not
   claim AI quality (gated by ADR 0035's evals). Frame the differentiator as
   "edits your real local codebase with DB + trace + schema context."
   Acceptance: doc copy passes the claims guardrail (no Cloud/hosted/quality claim, the
   PREVIEW label present); no code coverage impact (docs-only); one conventional commit.

## Layering invariants

Folded into the bar block above; restated where non-obvious:
- **Inc 2/3:** the dev MCP dispatch is an **injected seam** on `CliDeps`
  (`liveReload?` / `watchRoutes?` / `generateUi?` precedent, the latter at
  `tools.ts:121-122`) — `@lesto/cli` gains no runtime `@lesto/mcp` / `@lesto/auth` /
  `@lesto/ai` import. Grep-assert.
- **Inc 2/6a:** the AI overlay is injected **only** by `runDev` — grep-assert no
  reference from `runServe` / `runBuild` / `runDeploy`, and assert the production
  artifact contains no AI overlay script.
- **Inc 1/5:** all dynamic overlay content via `textContent`, never `innerHTML`
  (`dev-overlay.ts:33-39`, sites `:33,35,37,39`). Grep-assert.
- **Inc 3:** Phase 1 has **no mutation path at all** — the bridge is gated by a
  **positive read-tool allowlist** and fail-closed; any non-allowlisted tool name (write-
  shaped **or** unknown) is a coded refusal (`CLI_DEV_MCP_UNAVAILABLE`), enforced in the
  CLI core before the seam runs, so even a write-capable injected seam cannot reach a
  write tool — never a browser-side write, never fail-open. Acting is **Deferred to
  Phase 2**, gated on 0032 committing a real verb.
- **Inc 4b:** the context payload never leaves the process un-redacted — `redactContext`
  strips absolute paths, SQL bind values, env/secret-shaped tokens, raw console lines.

## Owned elsewhere (do not duplicate)

- **The `lesto dev` MCP server, `data-lesto-loc`, `/__lesto/open`, an edit-file/write
  verb + operator escalation** — ADR 0032 (dev-loop-control-plane). This plan **injects**
  the dispatch seam and degrades when those are absent; it builds none of them. 0032's
  committed Phase 1 ships read-only tools only and **no** edit-file/escalation verb —
  hence acting is gated. Reason: 0032 owns the dev-loop control plane and its governance;
  reaching past the seam would duplicate — and could *under*-govern — that surface.
- **`ai.generate` / tool / MCP spans + ANY dev span feed** — ADR 0031
  (agent-observable-runtime). **ADR 0031 adds no new exporter or span-feed seam** ("No new
  exporter or telemetry path"), and its `ai.generate`/`ai.tool` spans are Phase-2
  designed-only. So **Phase 4 is Deferred and this plan invents no 0031 span-feed/exporter
  seam** — it would only **read** a feed *if* 0031 first owns one (it does not today),
  never open a parallel telemetry path (ARCHITECTURE.md §7 — one trace, one OTLP exporter).
- **`generateUi` / registry validation** — `@lesto/ui-generate`
  (`generate.ts:61,88`), surfaced as the `generate_ui` MCP tool (`tools.ts:398`). It is a
  **non-mutating generator** returning a validated tree (`generate.ts:88`); the chat can
  call it to propose a tree, but applying that tree is Deferred. This plan re-validates
  nothing itself. (`@lesto/ui-generate` is coverage-gated at 100% — it declares
  `test:cov`; it is NOT exempt.)
- **MCP governance gate** — ADR 0028 / `@lesto/admin` / `@lesto/authz`. The **live**
  gate on the MCP write tools today is the binary `requireOperator` / `McpMode`
  (`requireOperator`, `tools.ts:254-264`; throws `MCP_OPERATOR_REQUIRED` at `:258-260`);
  ADR 0028 *proposes* `policy.allows` + an attributed actor as its replacement.
  `McpAuditRecord` has **no actor field** today (`tools.ts:77`), so any interim acting
  wired to legacy operator mode would be unattributed — rejected for this surface. It
  inherits **whatever gate 0028 lands**, not re-implemented here, and asserts no specific
  gate is already enforced.

## Deferred (per ADR 0033 — not in this plan)

- **Phase 2 — acting (issuing a governed mutation from a chat turn / fix-this)** —
  **Deferred** (no real 0032 write/edit verb exists today; grep for
  `edit_file`/`write_file`/`apply_edit` is empty). Lands only when ADR 0032 commits a real
  edit-file/write verb under an **attributed** gate (ADR 0028 Phase 3a). The interim
  "operator-mode against the existing content tools" fallback is **rejected for destructive
  verbs** — `McpAuditRecord` has no actor field (`tools.ts:77`), so it would ship an
  unattributed governed mutation.
- **Phase 3 — alt-click point-and-describe** — gated on ADR 0032's `data-lesto-loc` +
  `/__lesto/open`. Neither exists today (only `data-lesto-layout` et al.,
  `softnav-contract.ts:55`, `link.tsx:67`).
- **Phase 4 — live agent-activity panel** — **Deferred**: ADR 0031 adds no new
  exporter/span-feed seam and its AI spans are designed-only; both a span-feed seam and a
  queryable per-`requestId` span store (which **no committed phase produces**) are
  prerequisites this plan does not build.
- **Multi-turn persistence across dev restarts** — gated on a real resumable-session
  demand.
- **Voice / screenshot input** — gated on a concrete authoring workflow.
- **Applying a generated UI tree directly into a route file** — gated on ADR 0032's
  edit-file tool + ADR 0035's UI-generation evals.
- **A production end-user AI surface** — explicitly out; this is dev-only by
  construction.
