# ADR 0033 — In-preview AI surface (Cmd-K chat, fix-this, point-and-describe on the live preview)

> **Label (binding for all public copy): PREVIEW · dev-only · inspect-only (Phase 1).**
> This surface is **PREVIEW**, is **never injected by a production command**
> (`serve`/`build`/`deploy`) — it only exists under `lesto dev` — and in Phase 1 is
> **inspect-only**: it explains and diagnoses; it issues **no** edits (acting is a later,
> gated phase). The honest differentiator is that it **edits your real local codebase
> with DB + trace + schema context** — context only the framework that owns the stack can
> assemble. It is **not** a hosted product, **not** "Lesto Cloud", and **not** a
> v0/Bolt/Lovable-style competitor (`docs/brand/messaging.md:77`). We make **no** AI
> quality/accuracy claim — quality is gated by ADR 0035's evals, not asserted here.

- **Status:** Accepted (ratified 2026-06-23). The committed **build-now** is
  **Phase 1**, and it is **inspect-only**: a single, dev-only browser-injected overlay
  seam (a Cmd-K chat panel + an "Ask Claude to fix" button on the *existing* dev error
  overlay) that assembles a read-only, full-stack context payload, renders the agent's
  reply, and — critically — has **no mutation path of its own**. The bridge to the dev
  MCP server is shipped in Phase 1 as a **fail-closed seam stub**: absent a configured
  governed dispatch, the overlay paints an inspect-only "dev MCP server not available"
  state. The committed Phase-1 commit is itself **gated on a demonstrated ADR 0032
  consumer**: 0033 Phase 1 is *inert* without 0032's read-only dev MCP server (it has
  nothing to dispatch to), so the Phase-1 commit does **not** land until 0032 Phase 1
  ships a wired read-only dispatch the overlay can round-trip against — until then the
  overlay only ever paints the not-available state. **(Update, 2026-07-01 · L-e7ea34e3 ·
  `bd37ef9`): that dispatch is now WIRED.** After ADR 0032 Phase 1 shipped the loopback dev
  MCP server (and it was dogfooded onto `examples/estate` via `lesto dev`, L-cfd434f4), the
  bin now injects `dispatchDevTool` — an in-process, audited dispatch over the SAME governed
  dev MCP context — so the overlay round-trips a real **`describe_app`** turn (routes + OpenAPI
  + schema + collections; degrades to empty on a content-less app, so it lights up on estate).
  The fixed inspect tool is `DEV_INSPECT_TOOL` (`ai-bridge.ts`), a compiler-pinned member of
  the positive read-only allowlist (now `list_content_collections` + `describe_app`); acting
  stays Phase 2. Verified LIVE against estate `lesto dev`. **Phase 2** (acting — issuing a
  governed mutation from a chat turn / fix-this: content writes, an edit-file verb,
  `/__lesto/open`) is designed here and **gated on ADR 0032** committing an operator-mode
  escalation + the editor-jump/edit verbs, since 0032's *committed* Phase 1 ships three
  **read-only** tools only and introduces no write/escalation path; the only **real**
  0032 verb today is the read-only triad, so the Phase-2 *acting* fork is marked
  **Deferred** until 0032 names a real write/edit verb. **Phase 3** (alt-click
  point-and-describe element selection bound to `data-lesto-loc`) is designed here and
  **gated on ADR 0032** shipping `data-lesto-loc` + `/__lesto/open`. **Phase 4** (a live
  agent-activity panel streaming `ai.generate` / tool / MCP spans) is designed here and
  **marked Deferred**: ADR 0031 explicitly adds **no new exporter or span-feed seam**
  ("No new exporter or telemetry path"), so Phase 4 cannot land until *0031 first owns*
  a dev span-feed/subscription seam (it does not today) — this ADR does not invent one.
  The whole surface is **PREVIEW** (it composes `@lesto/ai`, which is preview and
  coverage-gate-exempt because it declares no `test:cov`) and **dev-only** (gated out of
  every production build). The dev-only `@lesto/cli` overlay code this ADR *adds* is held
  to the **full 100% gate** — `@lesto/cli` declares `test:cov`. Revised three times
  2026-06-22 — two internal adversarial passes plus the 2026-06-22 independent red-team +
  chief-architect pass that corrected the coverage premise, added a tested redaction
  stage, hardened the fail-closed boundary to a positive allowlist, gated the Phase-1
  commit behind a real 0032 consumer, and deferred Phases 2/4. See *Reviews*.
- **Date:** 2026-06-22
- **Deciders:** tech lead + owner (ratification pending)
- **Builds on / touches:**
  - **ADR 0031 (agent-observable-runtime)** — the `ai.generate` / tool / MCP spans on
    the unified browser→API→DB trace; Phase 4's activity panel *reads* those spans, it
    does not mint a parallel telemetry path.
  - **ADR 0032 (dev-loop-control-plane)** — the `lesto dev` live MCP server. Its
    *committed* Phase 1 ships exactly three **read-only** introspection tools
    (`get_dev_diagnostics`, `get_recent_requests`, `tail_logs`) and introduces **no**
    write/operator-escalation path (0032 Phase 1: "read-only only … no operator
    escalation is introduced for Phase 1"). The `data-lesto-loc` source-location
    attribute and the `/__lesto/open` editor-jump endpoint are 0032's **Phase 2**; an
    edit-file / operator-escalation verb is **not yet owned by any committed 0032
    phase**. **This ADR is a client of 0032**; it builds none of those primitives, and
    it commits *acting* through them only behind the gate that 0032 actually lands them
    (see Phase 2 below).
  - **ADR 0028 (operator control plane)** — the MCP governance model. **Today's live
    gate on the MCP write tools is the binary `requireOperator` / `McpMode`**
    (`requireOperator`, `packages/mcp/src/tools.ts:254-264`; throws
    `MCP_OPERATOR_REQUIRED` at `:258-260`): `create_content_entry` /
    `update_content_entry` are inert outside operator mode. ADR 0028 *proposes*
    replacing that binary gate with `requirePermission` over `policy.allows`
    (`@lesto/authz`) — not yet wired into the MCP surface. This surface inherits
    **whatever gate 0028 lands** on the dev MCP server; it does not re-implement authz
    and it asserts no specific gate is already enforced.
  - **ADR 0024 (client soft-navigation)** — the `data-lesto-layout` / soft-nav contract
    (`packages/ui/src/softnav-contract.ts:55`) the overlay coexists with; the overlay
    is a sibling injected `<script>`, not a soft-nav participant.
  - The **dev error overlay** — `packages/cli/src/dev-overlay.ts:23`
    (`devReloadClientScript`) and its structured `DevError` payload
    (`packages/cli/src/run.ts:139-145`). **The `DevError.stack` / `.message` carries
    absolute filesystem paths and frequently secret-shaped tokens; it is NOT forwarded
    raw to a model — see the redaction stage in Phase 1 #5.**
  - `@lesto/ui-generate` (`generateUi`, `packages/ui-generate/src/generate.ts:61`) and
    the existing `generate_ui` MCP tool (`packages/mcp/src/tools.ts:398`) — the
    registry-validated UI generation the chat can drive. **`@lesto/ui-generate` declares
    `test:cov` (`packages/ui-generate/package.json:21`) — it is gated at 100%, NOT
    coverage-exempt**; only `@lesto/ai` is exempt (it declares no `test:cov`).

This is the third ADR of the agent-native wave. **ADR 0031 is the keystone the wave
builds on**; ADR 0032 is the dev-loop control plane; **0033 (this) is the in-preview
surface that rides on 0031's spans and 0032's dev MCP server**; ADRs 0034/0035 are the
schema-contract and legibility/quality-gate batteries. The dependency direction is
strict: **0033 is gated on 0032's dev MCP server and on 0031's spans** — it ships no
new agent primitive of its own, only the browser UX that drives them.

## Context

`lesto dev` already injects exactly one piece of browser JS into every dev HTML
response, and it is the only extension point this ADR needs:

- **The injection seam is real and singular.** `withLiveReload`
  (`packages/cli/src/run.ts:980-993`) wraps the dev handle so every `text/html`
  response gets one trailing `<script>${script}</script>` appended to its body — string
  or streamed (`appendToBody`, `run.ts:1012-1031`). The injected string is built by
  `devReloadClientScript(port)` (`dev-overlay.ts:23`). There is **one** dev `<script>`
  today; this ADR's surface is the **second** injected concern, and the discipline is
  to keep it a sibling — not to entangle it with live-reload.

- **A structured error payload already crosses the wire.** The dev overlay is not a
  blob of HTML — it is a typed `DevError { source, message, stack? }`
  (`run.ts:139-145`) broadcast over the live-reload WebSocket via `notifyError`
  (declared `run.ts:172`, called `run.ts:1090`) and painted client-side entirely through
  `textContent`, never `innerHTML` (`dev-overlay.ts:33-39`, sites `:33,35,37,39`) —
  XSS-safe by construction. "Ask Claude to fix" is therefore *not* a new data path: the
  `DevError` the overlay already holds is **redacted (Phase 1 #5)** and then handed to
  the agent. `runDev` tracks one-overlay-at-a-time **server-side**
  (`overlayUp`, `run.ts:1081`) so a clean rebuild only reloads to dismiss a shown
  overlay — the second injected `<script>` rides the same server-side discipline.

- **UI generation already exists, registry-validated.** `generateUi`
  (`ui-generate/src/generate.ts:61`) turns the component registry into a *forced* tool
  schema so a model can only emit shapes the registry admits, and re-validates the
  model's output before it reaches a caller (`generate.ts:88`). It is already surfaced
  as the `generate_ui` MCP tool (`tools.ts:398`), and is **PREVIEW** — `@lesto/ai` and
  `@lesto/ui-generate` are the experimental model layer. **Coverage exemption is the
  `test:cov`-absence rule (`scripts/coverage-gate.ts:35`), NOT a "preview" status:** only
  `@lesto/ai` is exempt (it declares no `test:cov`); `@lesto/ui-generate` declares
  `test:cov` (`packages/ui-generate/package.json:21`) and **is gated at 100%**. The
  `"preview"` token in `packages/ai/package.json` is a keyword, not a gate field; see
  ADR 0021.

- **What is absent (and is owned by siblings, not built here).** There is **no**
  `data-lesto-loc` source-location attribute on rendered elements today — the only
  `data-lesto-*` markers are `data-lesto-layout` (soft-nav,
  `softnav-contract.ts:55`), `data-lesto-reload`, and `data-lesto-prefetch`
  (`packages/ui/src/link.tsx:67`). There is **no** `/__lesto/open` open-in-editor
  endpoint. There is **no** `lesto dev` MCP server (`@lesto/mcp` serves stdio only —
  see ADR 0028's Context; the dev server is ADR 0032's deliverable). Acting-through-MCP
  and point-and-describe therefore *cannot* be built before those land — they are the
  gated Phase 2/3 here, each blocked on the sibling that owns the primitive.

What this is **not**. It is **not** a hosted product, not a v0/Bolt/Lovable
competitor, and not "Lesto Cloud" — the messaging guardrail forbids the Cloud claim
(`docs/brand/messaging.md:77`). It is a **dev-only DX layer over the local inner
loop**. The honest differentiator is exactly the thing a hosted prompt-to-app tool
cannot do: it edits *your real local full-stack codebase* with the live DB schema, the
last request's trace, and the exact handler `file:line` already in hand — context only
the framework that owns the stack can assemble.

## The keystone: one dev `<script>`, full-stack context in, a fail-closed governed bridge out

The minimal sound abstraction is a single **dev overlay client** — a second injected
`<script>` (sibling to live-reload) — defined by what flows across its two edges:

| Flow | What it is | Source it draws from |
|---|---|---|
| **Context in** (Phase 1, **post-redaction**) | A read-only, **redacted** snapshot the agent could never assemble from the browser alone | current route + handler `file:line` (`data-lesto-loc`, ADR 0032 Phase 2), the selected element, the last request's `traceId` (ADR 0031 — the **id only**, not span text), the content schema/collections (`list_content_collections`, `packages/mcp/src/tools.ts:419`). **Every field passes a tested redaction/allowlist stage (Phase 1 #5) before it can be forwarded to an external LLM: absolute paths, SQL bind values, env/secret-shaped tokens, and raw browser-console lines are stripped.** |
| **Bridge out** (Phase 1: fail-closed stub; Phase 2: acting, **Deferred**) | A single seam to the **governed dev MCP server (ADR 0032)** — never a direct fetch-and-write from the browser. In Phase 1 the seam dispatches **only a positive allowlist of read-only tool names** (today: `list_content_collections`); any non-allowlisted/mutation-shaped tool name is refused. Absent a configured governed dispatch it paints "not available". Acting (issuing a mutation) is **Phase 2 — Deferred**, gated on 0032 committing a *real* write verb + operator-escalation path | the governed dev MCP dispatch seam; the *acting* tools it will route to once 0032 lands them — `create_content_entry` / `update_content_entry` (`tools.ts:478,502`, operator-gated), an edit-file verb (ADR 0032, **not yet owned by any committed 0032 phase — so acting is Deferred**), `/__lesto/open` (ADR 0032 Phase 2) |

**Generation is non-mutating.** `generate_ui` (`tools.ts:398`) is a *pure generator*:
it returns a registry-validated UI **tree** (`generate.ts:88` → `{ tree, valid, errors }`),
not placed code, and writes nothing. The chat can call it to *propose* a tree the
developer places by hand; applying a generated tree into a route file is **Deferred**
(it needs 0032's edit-file verb + 0035's evals). It is therefore explicitly **not** a
"bridge out" mutation.

The keystone claim: the surface **owns no agent capability**. It is a *context
assembler + a renderer* — and, in Phase 1, a *fail-closed bridge stub*. Any future
mutation routes through the dev MCP server, inheriting **whatever gate ADR 0028 lands**
there (today the binary `requireOperator` / operator mode, `tools.ts:254-264`; 0028
proposes `policy.allows`). So the browser overlay can never do anything the governed
dev MCP server would refuse — and in Phase 1 it cannot mutate at all. Collapse this and
you get a browser surface that writes files directly (ungoverned, unauditable); keeping
it a thin, fail-closed client of the governed dev MCP server is what makes it safe.

## Decision

Ship the dev overlay client as a second injected `<script>`, in phases; commit only
Phase 1 now.

### Phase 1 — build now: the **inspect-only** overlay client + chat + fix-this + a fail-closed bridge stub

Phase 1 ships **context-in + redaction + render + a fail-closed bridge**, and **no
mutation**. **Commit gate (must-fix from review):** Phase 1 is *inert* without a 0032
read-only dev MCP server to dispatch to — its only working capability would otherwise be
rendering the "not available" state. So **the Phase-1 commit is gated on a demonstrated
0032 consumer**: it lands only once ADR 0032 Phase 1 ships a wired read-only dispatch the
overlay round-trips a real `list_content_collections` turn against (dogfooded in
`examples/estate`, Inc 6). Until then this ADR's Phase-1 code may be authored and unit
green, but is **not committed** as a standalone surface. (The chief-architect's
alternative — folding 0033 Phase 1 into 0032's surface entirely — is recorded as a live
option in *Reviews*; this ADR takes the "gate the commit behind a real 0032 consumer"
fork rather than the fold, because the overlay's redaction stage + textContent rendering
are genuinely 0033-owned and testable in isolation.)

When that consumer exists, Phase 1 is honestly committable: every capability it relies on
is either already present (the injection seam, the `DevError` payload, the read-only
`list_content_collections` tool) or degrades loudly when absent (the dev MCP dispatch
seam). The chat can ask read-only questions and render replies; "Ask Claude to fix"
hands the **redacted** `DevError` to the bridge; but until ADR 0032 commits a write/edit
verb + operator escalation (Phase 2 below, **Deferred**), the bridge has nothing to *act*
through and paints the inspect-only "not available" state rather than mutating.

Five integration points, each kept on the dev-only side of the layering and each
100%-testable as a pure string/handler:

1. **A second dev overlay client string (`@lesto/cli`, dev-only).** Add an
   `aiOverlayClientScript(options)` pure string builder *beside* `devReloadClientScript`
   (`dev-overlay.ts`), and inject it through the *same* `withLiveReload`-style append
   seam (`run.ts:980-993`) — a sibling trailing `<script>`, not a modification of the
   live-reload script. Like the existing overlay, **every dynamic field is written via
   `textContent`, never `innerHTML`** (`dev-overlay.ts:33-39`, the four `textContent`
   sites at `:33,35,37,39`), so a model-returned string that contains markup is inert —
   **grep-asserted: no `innerHTML` in the overlay builders**. It is a pure builder with
   no socket and no
   side effects (the same testability contract `dev-overlay.ts:1-22` states), so a test
   evals it against a DOM and asserts the panel paints.
   - **Dev-only gate (fail-closed for production).** The script is injected **only** by
     `runDev` (`run.ts:1054`), never by `runServe`/`runBuild`/`runDeploy`. It is wired
     through an *optional* injected seam on `CliDeps` (the pattern every dev-only seam
     already uses — `liveReload?`, `watchRoutes?`, `run.ts:316,282`); absent the seam,
     the overlay is simply not present. Grep-assert that no production command path
     references the AI overlay builder.

2. **A dev MCP bridge seam — fail-closed via a positive read-tool allowlist (the seam,
   NOT the server).** The overlay POSTs its assembled context to a dev-only endpoint
   that, *in a later phase*, forwards to the dev MCP server (ADR 0032). **This ADR does
   not build the MCP server** — it injects a `dispatchDevTool` seam (the same injection
   discipline as `generateUi?`, `tools.ts:121-122`). In **Phase 1 the seam is
   fail-closed by a POSITIVE ALLOWLIST of read-only tool names** (must-fix from review):
   `dispatchAiTurn` checks the requested tool name against an explicit allowlist (today:
   `["list_content_collections"]`) **before** the seam is ever called — it is **not** a
   "mutation-shaped" heuristic and **not** a write-verb denylist. Any tool name **not on
   the allowlist** (including an unknown name, not merely a write-shaped one) is refused
   with the coded `CLI_DEV_MCP_UNAVAILABLE` and renders the "dev MCP server not
   available" state — fail-loud, never fail-open. This makes the boundary a property of
   the CLI core, not of whatever the seam-wirer happens to inject: even a consumer that
   injects a write-capable `dispatchDevTool` cannot reach a write tool through Phase 1,
   because the allowlist gate runs first. Mutation does not exist in Phase 1.

3. **"Ask Claude to fix" on the existing dev error overlay.** Extend the error overlay
   (`dev-overlay.ts`) with one button that hands the `DevError` (`run.ts:139-145`,
   broadcast via `notifyError`, declared at `run.ts:172`, called at `run.ts:1090`) the
   overlay already holds — `{ source, message, stack? }` — to the agent via the bridge
   (point 2), **after it passes the redaction stage (#5)**. No new error-capture path: it
   reuses the existing `notifyError` payload. The button is `textContent`-rendered like
   everything else in the overlay.

4. **Context assembly is read-only and bounded.** The "context in" snapshot is built
   from values already present in the page or already exposed as read tools: the current
   route/path, the handler `file:line` *if* `data-lesto-loc` is present (degrades to
   route-only when ADR 0032 has not shipped it), the last request's `traceId` (the **id
   only**, never span text), and the content collections via `list_content_collections`.

5. **A tested redaction/allowlist stage on the context payload (must-fix from review).**
   The original draft claimed the context was "RUM-equivalent — same-origin paths +
   timing numbers only." **That is false:** Phase 1 forwards `DevError.stack` /
   `.message` (which carry absolute filesystem paths and frequently secret-shaped tokens
   — `run.ts:139-145`), and later phases would carry SQL/trace text and raw
   browser-console lines — none of which RUM's path+timing snapshot contains. Because
   this payload is forwarded to an **external LLM**, Phase 1 ships a **pure, 100%-tested
   `redactContext(payload)` stage** that runs on *every* field before it can leave the
   process:
   - **Strip absolute filesystem paths** from stack frames and messages (rewrite to
     repo-relative or `<path>`), so no `/Users/...` / home dir / machine path escapes.
   - **Strip SQL bind values** (and any SQL/trace text in later phases) — keep query
     *shape* only, never literal bind parameters (which routinely carry PII/tokens).
   - **Redact env/secret-shaped tokens** in messages — high-entropy strings,
     `KEY=`/`SECRET=`/`TOKEN=`/`Bearer …`/connection-string shapes → `<redacted>`.
   - **Drop raw browser-console lines** entirely in Phase 1 (their Phase-3 ingest is
     Deferred and, when designed, must pass this same stage).
   This is a **Phase-1 acceptance**, not a Phase-4 nicety: the redaction stage has its own
   coded errors and is tested with positive cases (a stack with an absolute path, a
   message embedding a secret-shaped token, a SQL string with bind values) asserting each
   is stripped before the bridge sees it. The bounded-snapshot *spirit* still matches ADR
   0031's RUM discipline (ARCHITECTURE.md §7, line 127 — "same-origin paths + timing
   numbers only"), but this surface needs an **explicit redactor** because its inputs are
   richer and externally forwarded.

Scope discipline: Phase 1 is additive, introduces **no new runtime package**, no new
production code path, and is 100%-testable as pure functions over a DOM + injected
seams (the dev-only `@lesto/cli` code it adds is gated at 100% — `@lesto/cli` declares
`test:cov`). It **mutates nothing**: the only "out" edge is the allowlisted, fail-closed
bridge. The acting surface arrives in Phase 2 (**Deferred**), entirely over ADR 0032's
governed dev MCP tools once 0032 commits a real write/edit verb.

### Phase 2 — **Deferred** (no real 0032 write verb exists today): acting through the governed bridge

This is the phase where a chat turn (or "Ask Claude to fix") can **issue a mutation**. It
is **Deferred**, not merely "designed-here-gated," because **there is no real 0032 verb to
name as the acting target today**: ADR 0032's *committed* Phase 1 ships three **read-only**
tools and explicitly introduces **no** operator escalation ("read-only only … no operator
escalation is introduced for Phase 1"); `create_content_entry` / `update_content_entry`
exist (`tools.ts:478,502`) but are **inert outside operator mode** (`requireOperator`,
`tools.ts:254-264`), and **no edit-file verb exists anywhere in 0032 today** (grep for
`edit_file`/`write_file`/`apply_edit` returns nothing). The interim "run the dev MCP
server in operator mode against the existing content tools" fallback is **rejected for any
destructive verb** — per the cross-cutting security review, operator mode is a process-wide
binary flag and `McpAuditRecord` has **no actor field** (`packages/mcp/src/tools.ts:77`),
so wiring an acting verb to it would ship an *unattributed* governed mutation. Acting
therefore stays Deferred until **ADR 0032 commits a real edit-file/write verb under an
attributed gate (ADR 0028 Phase 3a)**. When that prerequisite lands:

- A chat turn that requests a change routes through the `dispatchDevTool` seam to the
  *named, real* governed tool (the edit-file verb 0032 lands, or
  `create_content_entry` / `update_content_entry` in operator mode) — never a
  browser-side write.
- "Ask Claude to fix" upgrades from handing the `DevError` for explanation (Phase 1) to
  optionally issuing the resulting edit through that same governed verb.
- Every action inherits **whatever gate ADR 0028 lands** on the dev MCP server (today
  the binary `requireOperator`, `tools.ts:254-264`; 0028 proposes `policy.allows` + an
  attributed actor). The overlay asserts no gate of its own, and the acting path is
  **never** wired to the unattributed legacy operator-mode flag.

### Phase 3 — designed here, gated on ADR 0032's `data-lesto-loc` + `/__lesto/open`: point-and-describe

Alt-click selects an element so "make THIS button primary" resolves to a `file:line`.
This **cannot** be built before ADR 0032 ships `data-lesto-loc` on rendered elements
and the `/__lesto/open` bridge — neither exists today (only `data-lesto-layout` /
`data-lesto-reload` / `data-lesto-prefetch` do, `link.tsx:67`,
`softnav-contract.ts:55`). When 0032 lands:

- An alt-click handler in the overlay client reads the nearest ancestor's
  `data-lesto-loc`, highlights it, and adds `{ file, line, selector }` to the next
  chat turn's "context in" snapshot.
- "Open in editor" routes through `/__lesto/open` (ADR 0032), never a browser-side file
  write.
- The element selection is *context*, not an action: it enriches the "context in"
  snapshot. Any resulting edit still goes through the governed acting path (Phase 2) —
  the overlay introduces no ungoverned write of its own.

### Phase 4 — **Deferred** (no 0031 span-feed seam exists or is designed): the live agent-activity panel

A panel in the overlay would stream the agent's work as it happens — MCP tool calls and
`ai.generate` spans. This is **Deferred**, not "designed-here-gated," because **ADR 0031
explicitly adds no new exporter or telemetry path** ("No new exporter or telemetry path")
and designs **no** dev span-feed/subscription seam — and 0031's `ai.generate` / `ai.tool`
spans are themselves Phase-2 *designed-only*, not shipped. This ADR **must not invent a
0031 'dev exporter' / 'span feed' seam** (correcting the prior draft, which did). Phase 4
therefore cannot land until **ADR 0031 first owns** a dev span-feed/subscription seam *and*
a queryable per-`requestId` span store — neither of which 0031 commits today; the
cross-cutting sequencing review flags this as a dependency with **no producer on the
roadmap**. If/when 0031 adds such a seam, this panel would only **read** it (never open a
parallel telemetry path — ARCHITECTURE.md §7, one trace, one OTLP exporter; spans attach
to the in-flight `http.request` span / `traceId`), render each span `textContent`-safely,
and stay PREVIEW. Until then: Deferred, no 0033 work.

**Ordering that matters for safety:** the dev MCP bridge seam and its fail-closed,
**allowlist-gated** "not available" state land in **Phase 1**, and **no acting code path
exists at all** — the overlay must never have a code path that mutates without routing
through a *named, real, governed* dev MCP tool that ADR 0032 has actually committed (and
none exists today, so acting is **Deferred**). Phase 1 is inspect-only by construction:
`dispatchAiTurn` refuses any non-allowlisted tool name before the seam runs; the chat
renders read-only replies; the acting path is **not registered** until 0032 commits a real
write/edit verb under an attributed gate. Absent it, the surface is inspect-only.

## Non-goals

- **Not a hosted product / not "Lesto Cloud."** No managed runtime, no remote build,
  no prompt-to-deployed-app. Dev-only, local inner loop. (`messaging.md:77`.)
- **Not a v0/Bolt/Lovable competitor.** The differentiator is editing your *real local
  full-stack codebase* with DB + trace + schema context, not generating throwaway apps.
- **No new agent capability.** Phase 1 mutates nothing; any later action is an
  existing/0032-owned MCP tool the overlay routes through, never one it owns. No
  browser-side file write, no ungoverned mutation, ever.
- **No production surface.** The overlay never reaches `serve`/`build`/`deploy`; it is
  injected only by `runDev`, grep-asserted.
- **No `innerHTML`.** All dynamic content is `textContent`, matching the existing
  overlay's XSS-safe contract (`dev-overlay.ts:33-39`, sites at `:33,35,37,39`) —
  grep-asserted (no `innerHTML` in the overlay builders).
- **No un-redacted context to the model.** The context payload never leaves the process
  without passing the tested `redactContext` stage (Phase 1 #5): no absolute paths, no SQL
  bind values, no env/secret-shaped tokens, no raw console lines.
- **No AI quality / accuracy claim.** The surface is PREVIEW; quality is gated by ADR
  0035's evals, not asserted here.

## Deferred — recorded, not scheduled; each gated on a real consumer

- **Multi-turn conversation persistence across dev restarts** — gated on a real demand
  for resumable dev sessions; Phase 1 is per-session, in-memory.
- **Voice / screenshot ("point a camera") input** — gated on a concrete authoring
  workflow asking for it.
- **Applying a generated UI tree directly into a route file** — gated on ADR 0032's
  edit-file tool *and* ADR 0035's evals clearing UI-generation quality; until then the
  chat returns the validated tree (`generate.ts:88`) for the developer to place.
- **A production "ask about this page" surface** — explicitly out; this ADR is dev-only
  by construction. A shipped end-user AI surface is a separate, governed,
  non-preview decision.
- **Corrections recorded in review.** (1) `data-lesto-loc` and `/__lesto/open` were
  initially assumed to exist — they do **not** (only `data-lesto-layout` et al.); they
  are ADR 0032 Phase 2 deliverables, so point-and-describe is gated. (2) The first draft
  put *acting* (content writes, an edit-file verb, `generate_ui`) in Phase 1's
  "action out" — but 0032's committed Phase 1 ships **read-only** tools only and **no
  edit-file/operator-escalation verb exists in 0032 today**, and the content-write tools
  are inert outside operator mode (`requireOperator`, `tools.ts:254-264`). Phase 1 was
  re-scoped to **inspect-only** and acting moved to a gated Phase 2; `generate_ui` was
  reclassified as a non-mutating generator (see below).
- **`generate_ui` is non-mutating, not "action out."** It returns a validated UI tree
  (`generate.ts:88`), not placed code, and writes nothing — so applying a generated tree
  into a route file is itself **Deferred** (gated on 0032's edit-file verb + 0035's
  evals); until then the chat returns the tree for the developer to place.

## Reviews

Two internal adversarial passes (these are proposals; no owner sign-off claimed).

**Pass 1 — three lenses:**

- **Correctness / security.** Surfaced that the overlay must never write files from the
  browser — every action was re-routed through ADR 0032's *governed* dev MCP server, so
  the browser surface can do nothing the governed server would refuse. Confirmed the
  `textContent`-only XSS discipline carries to the new overlay and the chat-reply
  rendering. Made the missing-bridge state **fail-loud / inspect-only**, never
  fail-open. Pinned the production-exclusion to the `runDev`-only injection seam,
  grep-asserted.
- **Simplicity / scope.** Cut a proposed standalone overlay package and a bespoke
  websocket — the surface reuses the *existing* injection seam (`withLiveReload`,
  `run.ts:980`) and the *existing* `DevError` payload (`run.ts:139`); "Ask Claude to
  fix" became a zero-new-data-path reuse. Reduced Phase 1 to a context-assembler +
  renderer that owns no agent capability.
- **Sequencing / coupling.** Corrected the false premise that `data-lesto-loc` /
  `/__lesto/open` exist — they are ADR 0032's, so point-and-describe moved to a gated
  phase. Affirmed the strict dependency direction (0033 consumes 0031 + 0032; it
  produces no primitive). Asserted the whole surface stays PREVIEW because it composes
  `@lesto/ai`/`@lesto/ui-generate`. *(Pass-1 wrongly inferred both AI packages were
  coverage-exempt — corrected in Pass 3: only `@lesto/ai` is exempt; `@lesto/ui-generate`
  declares `test:cov` and is gated at 100%.)*

**Pass 2 — verified the citations against the source tree; changes made:**

- **(must-fix) Phase 1's "action out" was unsupported by any committed sibling phase.**
  Verified ADR 0032's *committed* Phase 1 ships three **read-only** tools only and adds
  **no** edit-file/write/operator-escalation verb (`grep` for `edit_file`/`write_file`/
  `apply_edit` in 0032 returns nothing), and `create_content_entry` /
  `update_content_entry` are inert outside operator mode (`requireOperator`,
  `tools.ts:188-196`). **Fix:** re-scoped Phase 1 to **inspect-only** (context-in +
  render + a fail-closed bridge *stub*); moved **all** acting to a new gated **Phase 2**
  that names its true prerequisite (0032 must commit an edit-file verb + operator
  escalation, OR 0033 targets the existing operator-mode content tools with the dev MCP
  server run in operator mode). Removed the bare "an edit-file verb (ADR 0032)" claim as
  a committed Phase-1 capability.
- **(should-fix) Governance claim overstated `policy.allows` as live.** Verified the
  live MCP write gate is the binary `requireOperator` / `McpMode`
  (`MCP_OPERATOR_REQUIRED`, `tools.ts:188-196`); `policy.allows` (`@lesto/authz`) is ADR
  0028's *proposed* replacement, not wired into the MCP surface. **Fix:** softened every
  governance mention to "inherits **whatever gate 0028 lands**" — today
  `requireOperator`, with `policy.allows` as the proposed future — rather than asserting
  `policy.allows` already gates the dev MCP server.
- **(nit) `generate_ui` mis-filed as a mutation.** Verified it returns a validated UI
  tree (`generate.ts:88`) and writes nothing. **Fix:** moved it out of "action out" into
  an explicit non-mutating-generation note; applying a tree stays Deferred.
- **(nit) `textContent` line range.** Verified the four `textContent` sites are
  `dev-overlay.ts` lines 33/35/37/39. **Fix:** re-cited as `dev-overlay.ts:33-39`
  throughout.
- **(nit) `overlayUp` framing.** Verified `overlayUp` (`run.ts:1081`) is **server-side**
  state in `runDev`, not the browser overlay's own visibility. **Fix:** reworded to keep
  it on the server side.
- **(nit) Plan Inc 6 named the wrong layer.** Verified the CliDeps seams belong on the
  dev **bin** (`examples/estate/dev.ts`), not the app-config factory
  (`examples/estate/lesto.app.ts`). **Fix:** repointed Inc 6 at the dev bin.

**Pass 3 — 2026-06-22 independent red-team + chief-architect pass (per-ADR + cross-cutting
lenses over ADRs 0031–0035). Status stays "Proposed — pending owner ratification."**
The independent verdict on 0033 was **revise**. Concrete changes made:

- **(must-fix, HONESTY) False coverage-exemption premise corrected.** The review verified
  via `scripts/coverage-gate.ts:35` that the gate keys **only** on a package declaring
  `test:cov` (plus the `content-` prefix carve), with **no** `preview` field anywhere.
  `packages/ui-generate/package.json:21` declares `test:cov` — so `@lesto/ui-generate`
  **IS gated at 100%**, not exempt; only `@lesto/ai` (no `test:cov`) is exempt. **Fix:**
  corrected every place the coverage reasoning leaned on "preview ⇒ exempt" (Status,
  Builds-on, Phase-1 scope, Consequences) — exemption is the `test:cov`-absence rule, and
  the dev-only `@lesto/cli` code this ADR adds is held to the full 100% gate.
- **(must-fix, SECURITY) No redaction stage on the externally-forwarded context.** The
  review showed the context payload is **not** "RUM-equivalent paths+timing": it forwards
  `DevError.stack`/`.message` (absolute paths + secret-shaped tokens, `run.ts:139-145`),
  and later phases SQL/trace text and raw console lines, to an **external LLM** with no
  redaction. **Fix:** added a **Phase-1 acceptance** — a tested `redactContext` stage that
  strips absolute paths, SQL bind values, env/secret-shaped tokens, and raw console lines
  (Phase 1 #5), with positive stripping tests. Demoted the "RUM-equivalent" claim.
- **(must-fix, SECURITY) Fail-closed boundary is now a POSITIVE ALLOWLIST.** The prior
  draft's "mutation-shaped" classifier was a heuristic. **Fix:** Phase 1 #2 now specifies
  a positive allowlist of read-tool names (today `["list_content_collections"]`) enforced
  in `dispatchAiTurn` **before** the seam runs, with a **negative test** that an
  unknown/non-allowlisted (including mutation-shaped) tool name is refused with
  `CLI_DEV_MCP_UNAVAILABLE` — making the boundary a CLI-core property, not the
  seam-wirer's responsibility.
- **(must-fix, REALITY) Phase-1 commit gated on a real 0032 consumer.** The review noted
  Phase 1 is **inert** without a 0032 read/consumer surface. **Fix:** the Phase-1 commit
  is now gated on a demonstrated 0032 read-only dispatch the overlay round-trips against
  (Inc 6 dogfood); recorded the chief-architect's "collapse the dev surface / fold into
  0032" alternative and stated this ADR takes the gate-the-commit fork. The **Phase-2
  acting fork is marked Deferred** — no real 0032 write/edit verb exists today (grep for
  `edit_file`/`write_file`/`apply_edit` is empty), and the interim operator-mode fallback
  is **rejected** for destructive verbs because `McpAuditRecord` has no actor field
  (`tools.ts:77`) ⇒ unattributed governed mutation.
- **(must-fix) Phase 4 must not invent a 0031 exporter/span-feed seam.** ADR 0031
  explicitly adds **no new exporter or telemetry path** and designs no dev span-feed.
  **Fix:** Phase 4 is **marked Deferred**; it depends on 0031 *first* owning a span-feed
  seam (and a queryable per-`requestId` store), neither committed — this ADR invents
  nothing.
- **(must-fix, XSS) Re-asserted textContent-only.** All overlay content is `textContent`,
  never `innerHTML` (`dev-overlay.ts:33-39`, sites `:33,35,37,39`), with an explicit
  **grep-assert** acceptance in Phase 1 #1, the Non-goals, and the plan's bar block.
- **(grounding) Re-anchored all stale `file:line` citations to the current tree:**
  `requireOperator`/`MCP_OPERATOR_REQUIRED` `188-196`→`254-264` (throw `258-260`);
  `generate_ui` `331/332`→`398`; `list_content_collections` `353`→`419`;
  `create_content_entry` `403`→`478`; `update_content_entry` `425`→`502`; the `generateUi?`
  injection-seam precedent `tools.ts:79-80`→`121-122`; `generate_ui` return shape
  `generate.ts:86`→`88`; `notifyError` `run.ts:166-172`→declared `:172`/called `:1090`;
  `textContent` range `33-40`→`33-39`; added `McpAuditRecord` no-actor `tools.ts:77`.
  *(Pass 2's prose above retains its original — now-superseded — `188-196`/`:86` numbers as
  a record of what Pass 2 believed; Pass 3's re-anchoring is authoritative.)*
- **(cross-cutting, sequencing)** Acknowledged the wave's dangling-sink risk: 0032 Phase 3
  and this ADR's Phase 4 both rest on a queryable per-`requestId` span store **no committed
  phase produces** — recorded here as a board action (tracking task / explicit
  blocked-indefinitely marker), not silently assumed.

What survived as already-minimal: the single-`<script>` keystone, the reuse of the
existing injection seam and `DevError` payload, the `runDev`-only production exclusion,
and the "owns no capability, only assembles (redacted) context + (later) routes through
governed MCP" framing.

## Consequences

- `lesto dev` gains an in-preview AI surface that is honestly scoped: a dev-only DX
  layer whose only differentiator is full-stack local context, not a hosted builder.
- The surface adds **no new agent capability and no production code path** — it is a
  thin, governed client of ADR 0031's spans and ADR 0032's dev MCP server, so its
  blast radius is bounded by those (already-reviewed) layers.
- It is **PREVIEW** end-to-end and must be labelled PREVIEW in any public copy. Coverage:
  **only `@lesto/ai` is gate-exempt** (it declares no `test:cov`); `@lesto/ui-generate`
  **declares `test:cov` and is gated at 100%**, and the dev-only `@lesto/cli` overlay code
  this ADR *adds* is likewise held to the full bar (100% coverage, coded errors) — it is
  pure and testable. "Preview" is a label, not a coverage waiver.
- The cost is concentrated in the **context-assembly + redaction correctness** (no
  PII/secret/path leakage to an external model — the tested `redactContext` stage) and the
  allowlist-gated fail-closed bridge — both small, both pure-testable. The capability-heavy,
  security-sensitive pieces live in the siblings (0031/0032) behind their own reviews.
- Slow iteration upheld: only the **inspect-only** Phase 1 (overlay-client + fix-this
  explain + redaction + the allowlist-gated fail-closed bridge) lands — and only **once a
  real 0032 read consumer exists** (commit gate). **Acting (Phase 2)** and the **activity
  panel (Phase 4)** are **Deferred** (no real 0032 write verb; no 0031 span-feed seam);
  point-and-describe (Phase 3) follows 0032's `data-lesto-loc` + `/__lesto/open`.
