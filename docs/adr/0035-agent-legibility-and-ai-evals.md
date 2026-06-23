# ADR 0035 — Agent legibility & AI quality gates (make any Lesto app legible to any coding agent, and hold AI features to a test bar)

- **Status:** Accepted (ratified 2026-06-23). **Phase 1** (the `lesto generate agents`
  generator emitting a project-specific `AGENTS.md` + `llms.txt` from the app's own
  conventions) is the committed build-now and is shippable at the full bar — and, per the
  2026-06-22 chief-architect synthesis, it is **the highest-leverage, gate-free,
  cross-ADR-dependency-free cut in the whole agent-native wave**, so it is **promoted to the
  front of the wave's build order** (it does *not* depend on ADR 0031's spans; only the
  later trace-attachment phases do). **Phase 2** (docs-as-context: the docs site exposed
  over MCP + a docs-specific `llms.txt`, dogfooded on `site/`) is designed here and gated on
  Phase 1's convention-scan being the single source of "what a Lesto app is" **and** on a
  new read-only mode being added to `@lesto/content-mcp` (the server ships write tools today
  — see *Context* #2 and *Reviews*); the mount also requires threading a **programmatic
  config** into `createMcpServer` because `site/` has no `docks.config` (see *Decision
  Phase 2* #2 and *Reviews*). **Phase 3** (a `lesto eval` CI gate over `@lesto/ai`'s
  `createLlmJudge`/`guard`) is **PREVIEW / opt-in** — it composes the PREVIEW,
  coverage-gate-exempt `@lesto/ai` (`packages/ai/src/index.ts:17-19`; the exemption is the
  **absence of a `test:cov` script**, not the word "preview" — `scripts/coverage-gate.ts:35`)
  behind a **lazy/dynamic import**, with `@lesto/ai` declared as an **optional
  peerDependency** of `@lesto/cli` (mirroring `@lesto/content-core`,
  `packages/cli/package.json:43-48`) so the edge has a real version constraint without
  entering the supported CLI's eager dependency graph; it rides at that package's preview
  bar, not the 100% gate. Revised three times 2026-06-22 — two internal adversarial passes
  plus the independent red-team + chief-architect pass — that cut scope and corrected the
  docs-MCP, CLI-command, eval-discovery, and dependency claims. See *Reviews*.
- **Date:** 2026-06-22
- **Deciders:** tech lead + owner (ratification pending)
- **Builds on / touches:** ADR 0021 (PREVIEW app-builder AI primitives — reuses the
  `Eval`/`createLlmJudge`/`guard` hook at `packages/ai/src/evals.ts:32,64,98`, and
  inherits its PREVIEW status). ADR 0019 (`lesto generate` — reuses the pure,
  fully-injected `GenerateIO` seam at `packages/cli/src/generate.ts:38-48` so the new
  generator is tested with no disk). ADR 0023 (file-based routing — reads the route
  conventions via `@lesto/router`'s `scanRoutes` over an injected `DirReader`,
  `packages/router/src/scan.ts:97`, `index.ts:38-39`; descriptor shape
  `FileRouteKind`/`DiscoveredFile`/`FileRoute` at `file-routes.ts:80,119,137`).
  `@lesto/content-core` (`getCollections`, re-exported `index.ts:66`, implemented
  `runtime.ts:204` — a **zero-arg read of the compiled content store**, so the inventory is
  gated on the store having been built and on content-core being installed; see *Decision
  Phase 1* #1 and *Reviews*) for the collection inventory. `@lesto/content-mcp`
  (already an MCP server with stdio transport + `ToolBuilder`, `server.ts:543,619`) for
  docs-as-MCP — **but** it advertises and dispatches write tools
  (`create_entry`/`update_entry`, advertised `server.ts:569`, dispatched
  `server.ts:511-514,539`) and has no read-only mode (`McpServerOptions` is `{ cwd }`-only,
  `server.ts:23-25`), so Phase 2 first adds a read-only filter that closes **both** the
  advertised list **and** the dispatch path (see *Decision Phase 2*). The docs site at
  `site/` (a real Lesto app, `site/package.json`; it has **no** `docks.config` — it feeds
  `site/lesto.content.ts`'s default export to `runPipeline` manually, `site/src/content.ts:16-22`,
  `site/lesto.content.ts:89`) as the dogfood + QA gate; the mount therefore threads a
  **programmatic config** through `resolveConfig`'s `programmaticConfig` arg
  (`packages/content-core/src/config.ts:112-130`). Sibling ADRs 0031–0034 (see *Context*).

## Context

This is the legibility-and-quality leg of the five-ADR agent-native wave. ADR 0031
(agent-observable-runtime) is the **keystone** the wave builds on — LLM/tool/MCP spans on
the unified browser→API→DB trace; ADRs 0032 (dev-loop control plane) and 0033 (in-preview
AI surface) are the dev-loop and preview surfaces (0033 is gated on 0032's dev MCP
server); ADR 0034 (agent-native schema & contract) is the governed-schema-and-contract
battery. **This ADR — 0035 — is the legibility and quality-gate battery: it makes any
Lesto app instantly legible to *any* coding agent, and it puts a test bar under the AI
surfaces 0033/0034 introduce.** Two demanded, concrete requirements:

1. **A coding agent dropped into a Lesto app has to *infer* the conventions.** There is
   no machine-readable map of how a Lesto app is laid out. The conventions are real and
   discoverable in code — file routes (`page`/`layout`/`loading`/`error`/`not-found`,
   typed `[param]`/`[...catch]` segments, route groups; `packages/router/src/file-routes.ts:80-177`),
   islands (real, glob-discoverable modules under `app/islands/`; the CLI already probes
   that directory via the `hasIslandsDir` seam, `packages/cli/src/run.ts:237-244`), content
   collections (`getCollections`, re-exported `packages/content-core/src/index.ts:66`,
   implemented `runtime.ts:204`), the `lesto()` builder API, and the CLI surface
   (`generate`/`g`, `dev`, `mcp`, `openapi`, …). The CLI surface, note, is **not** today a
   structured constant the scan can read: `bin.ts` dispatch is imperative `if (command ===
   …)` branches (`bin.ts:560,573,587`) and the only command *text* is the human-formatted
   `USAGE` array (`run.ts:373-400`) — **which is incomplete**: it omits `mcp` and `openapi`,
   both of which ARE dispatchable (`bin.ts:560,573`). So describing the CLI surface requires
   a **new** small exported command-descriptor constant (see *Decision Phase 1* #1) whose
   authority is the **actual dispatch set** (the `command === …` branches in `bin.ts` plus
   the `run` core), **not** the `USAGE` text — `USAGE` is treated as docs to cross-check, and
   a two-way sync test asserts the constant and the dispatch set agree (including `mcp` and
   `openapi`). It is not "a constant the CLI already owns." Either way, an agent has to
   *reverse-engineer*
   these every time. `AGENTS.md` is the emerging cross-agent convention (Claude Code, Cursor, and
   others read a top-of-repo agent instructions file); `llms.txt` is the emerging
   convention for a machine-readable site/project index. **Neither exists anywhere in
   this repo today** (a tree-wide search for `AGENTS.md`/`llms.txt`/`llms-full.txt`
   returns nothing). An app author should not hand-author these — they should be
   *generated from the app's own conventions* so they cannot drift.

2. **The docs are not available to the agent *building* a Lesto app.** The docs site
   (`site/`) is a real Lesto app whose pages are Markdown collections rendered at build
   time (`site/lesto.content.ts`, `site/src/content.ts`). An agent building an app on
   Lesto has no way to pull those docs as grounded context — it falls back on its
   training cutoff. `@lesto/content-mcp` already exposes content collections over MCP
   with read tools (`list_collections`/`get_collection_schema`/`get_entry`/`search_content`,
   built `packages/content-mcp/src/server.ts:137-176`) over a stdio transport
   (`server.ts:543,619`) — i.e. the docs-as-MCP machinery substantially exists. **But the
   same server also builds, advertises, and dispatches *write* tools** —
   `create_entry`/`update_entry` (built `server.ts:176-205`; `createMcpServer` advertises
   `const tools = TOOLS` = *all* tools, `server.ts:569`; `handleToolCall` admits any name in
   `TOOL_SCHEMAS` — `if (!(name in TOOL_SCHEMAS))`, `server.ts:528` — then dispatches via
   `TOOL_HANDLERS[toolName]` *unconditionally*, `server.ts:511-514,539`) — and
   `McpServerOptions` has only `{ cwd }` (`server.ts:23-25`), so there is **no read-only
   mode**. Mounting `createMcpServer` as-is at `site/` would let an agent *mutate the docs*
   over MCP. Note the dispatch path is a **third surface**: filtering only the advertised
   `TOOLS` list is security theater, because `handleToolCall` reaches `TOOL_HANDLERS`
   directly by name — an agent can invoke `create_entry` *by name* even though it was never
   advertised (advertising is not enforcement). A second buildability fact: mounting at
   `site/` would also **throw at startup** — `createMcpServer` calls `resolveConfig(cwd)`
   (`server.ts:546`), which throws `No docks.config.{ts,js,mjs} found` when no config file
   exists (`config.ts:135-138`), and `site/` has none. What is therefore missing is (a) a
   read-only filter in `@lesto/content-mcp` that closes **both** the advertised list **and**
   the dispatch lookup, plus (b) a way to feed `site/`'s programmatic content config into
   `createMcpServer` (via `resolveConfig`'s `programmaticConfig` arg, `config.ts:112-130`),
   then (c) wiring that filtered server at `site/` and emitting a docs-specific `llms.txt`
   index for the docs (distinct from Phase 1's project `llms.txt`).

3. **AI features have no test gate.** `@lesto/ai` ships the evals *hook* — `Eval` is a
   pure `(input, output) => Promise<EvalResult>` (`packages/ai/src/evals.ts:32`),
   `createLlmJudge` composes an LLM-judge eval (`evals.ts:64`), and `guard` refuses a
   failing output with a coded `AI_GUARDRAIL_BLOCKED` (`evals.ts:102`,
   `errors.ts` `AiErrorCode`). But there is **no runner that gathers an app's evals and
   gates CI on them** the way `scripts/coverage-gate.ts` gates coverage — and, just as
   importantly, **there is no convention for *where an app's evals live***: `@lesto/ai`
   exports only the `Eval` type + hooks (`ai/src/index.ts`), with no `app/evals/` glob, no
   `*.eval.ts` convention, and no `evals` field on the app config. A runner that only
   accepts an *injected* loader has nothing concrete to load, so `lesto eval` would be a
   hollow gate. Phase 3 therefore **defines a discovery convention** (`app/evals/*.eval.ts`,
   each default-exporting `Eval`s) so the real command has something on disk to find. The AI
   surfaces the rest of this wave introduces (0033's in-preview chat/fix, 0034's proposed
   migration tools) need a quality bar, or "agent-native" is an unbacked claim.

What this is **not**: not a visual CMS / Studio editor; not a docs-authoring tool; not an
evals *harness/dataset/dashboard* (ADR 0021 deliberately shipped the hook and deferred
the convenience layer, `evals.ts:11-13`); not an accuracy/quality *claim* about any AI
surface — no number ships without published evals.

## The core idea: the app's conventions are the single source of agent legibility

One named abstraction: a **convention scan** — a pure function over the app's already-real
structural facts (routes, islands, collections, CLI commands, the `lesto()` config) that
emits *every* agent-facing artifact. `AGENTS.md`, `llms.txt`, and the docs-as-MCP
inventory are all **renderings of the same scan**, never hand-authored, so they cannot
drift from the code an agent will actually meet.

| Concern | Resolution from the convention scan |
|---|---|
| **Agent instructions** (`AGENTS.md`) | Rendered from the scanned routes/islands/collections/CLI — "here is how *this* app is laid out and how to work in it." |
| **Machine index** (`llms.txt`) | Rendered from the same scan + the docs collection — a flat, linkable index an agent can fetch. |
| **Machine index — docs** (docs `llms.txt`) | A **distinct** docs-specific index rendered from `site/`'s `docs` collection (Phase 2), at a path that does **not** collide with the Phase 1 project `llms.txt`. |
| **Docs as grounded context** (MCP) | The docs collection (a scan input) exposed over the `@lesto/content-mcp` read tools, behind a **new read-only filter** that closes **both** the advertised list **and** the dispatch path (the server ships write tools today), fed `site/`'s programmatic config. |
| **AI quality** (`lesto eval`) | Orthogonal: a runner over the app's own `Eval`s discovered via the `app/evals/*.eval.ts` convention — a gate, not a generator output. |

The scan is the *minimal* sound abstraction: it is a pure read over facts the framework
already computes (`scanRoutes`, `getCollections`), so it is 100%-testable with injected
readers and zero disk, exactly like `lesto generate` (`generate.ts:38-48`). Collapse it —
hand-author `AGENTS.md` — and it drifts the first time a route convention changes.

## Decision

Ship a generator that renders agent-facing artifacts from the convention scan; expose the
docs over MCP by adding a read-only filter to the content-mcp server and mounting that
filtered server at `site/`; and add a PREVIEW `lesto eval` gate over `@lesto/ai`'s evals
hook (behind a lazy import). Build in phases; commit only Phase 1 now.

### Phase 1 — build now: `lesto generate agents` from the convention scan

Three integration points, each on the right side of the existing layering:

1. **A pure convention scan (CLI layer, fully injected).** A new
   `runGenerateAgents(args, deps)` reuses the ADR 0019 `GenerateIO` seam
   (`generate.ts:38-48`) — injected `exists`/`read`/`write` + a capturing `out` — and
   adds injected **readers** for the conventions: the route descriptors via
   `@lesto/router`'s `scanRoutes` over an injected `DirReader` (`scan.ts:97`,
   `index.ts:38-39` — a *type-only* + thin-runtime use; the CLI already imports
   `scanRoutes`/`@lesto/router` and `@lesto/web`, `bin.ts:18-19`); the collection
   inventory via `getCollections` (re-exported `content-core/src/index.ts:66`, implemented
   `runtime.ts:204`) — a **zero-arg read of the compiled content store**, so the reader must
   **degrade gracefully** to "no collections" when content-core is not installed (it is an
   optional peerDep, `cli/package.json:43-48`) or the store has not been built, rather than
   throwing or emitting a workflow-state-dependent list; an **island inventory** via a new
   injected glob-reader over `app/islands/` (the directory the CLI already probes via the
   `hasIslandsDir` seam, `run.ts:237-244` — neither `scanRoutes` nor `getCollections` covers
   islands, so this is a deliberate small new reader); and the CLI surface via a **new
   exported command-descriptor constant** whose authority is the **actual dispatch set** —
   the `command === …` branches in `bin.ts` (`bin.ts:560` `mcp`, `573` `openapi`, `587`
   `generate`/`g`, plus the `run` core's commands) — **not** the human `USAGE` text
   (`run.ts:373-400`), which omits `mcp`/`openapi`. A two-way sync test asserts the constant
   and the dispatch set agree (so neither `mcp` nor `openapi` can silently fall out of the
   generated `AGENTS.md`/`llms.txt`). There is no scannable command list today, so this
   constant is a small new artifact, not something "the CLI already owns." The scan is a pure
   function
   `(routes, islands, collections, cliCommands, lestoConfigSummary) → AgentArtifacts` —
   no disk in the decision, exactly the `generate.ts` discipline.

2. **`AGENTS.md` + `llms.txt` renderers (pure).** Two pure renderers over the scan
   output. `AGENTS.md` is the cross-agent instructions file: the route conventions in
   force, the island/collection inventory, the available `lesto` CLI commands, and a
   short "how to add X" section derived from the same generators `lesto g` ships. `llms.txt`
   is the flat machine index. **Idempotency + a managed region:** following the
   `lesto generate` idempotency rule (a file that exists is not clobbered,
   `generate.ts:29-33` docstring), the generator writes a clearly-delimited
   **`<!-- lesto:generated -->` managed region** so an author's hand-written guidance
   above/below it is preserved while the scanned section is regenerated byte-stably; a
   `--check` flag re-scans and diffs (drift guard, the `routes.gen.ts` freshness pattern).

3. **Wire it into the CLI dispatcher.** `bin.ts` gains a `generate agents` / `g agents`
   path next to the existing `generate`/`g` dispatch (the `if (command === …)` branch at
   `bin.ts:587`), calling `runGenerateAgents` with the real `GenerateIO` + readers. No new
   runtime; additive.

- **Coded errors / fail-loud.** Every refusal (unreadable app config, an app with no
  `app/routes` and no collections — nothing to describe) throws a stable
  `CliError` code (the `packages/cli/src/errors.ts` pattern, SCREAMING_SNAKE, following the
  existing `CLI_GENERATE_*` prefix, e.g. `CLI_AGENTS_NOTHING_TO_SCAN`,
  `CLI_AGENTS_MARKER_MALFORMED`). Because `CliErrorCode` is a **closed union**
  (`errors.ts:13-26`), each new code requires extending that union *before* the throwing
  code compiles — so `errors.ts` is touched in the very first increment that needs a code.
  Tests branch on the code, never the message.

Scope discipline: Phase 1 is additive, introduces no new runtime dependency and no new
package edge, and is 100%-testable as pure functions over injected readers + a fake
`GenerateIO`. It is **shippable at the full bar** (this is *not* a preview surface — it
reads structure, it does not call a model).

### Phase 2 — designed here, gated on Phase 1: docs-as-MCP + a docs `llms.txt`, dogfooded on `site/`

The docs-as-MCP machinery *substantially* exists in `@lesto/content-mcp`: a `Server`
exposing `list_collections`/`get_collection_schema`/`get_entry`/`search_content` read
tools over the `getCollections` engine (built `server.ts:137-176,543`). But the **same
server also builds and dispatches write tools** (`create_entry`/`update_entry`, built
`server.ts:176-205`, dispatched `server.ts:511-514`), advertises *all* of them
(`const tools = TOOLS`, `server.ts:569`), and exposes no read-only mode (`McpServerOptions`
is `{ cwd }`-only, `server.ts:23-25`). So Phase 2 is **mostly** wiring, but it has a
**keystone first step**: add a read-only mode to `@lesto/content-mcp` before any mount.

1. **Add a read-only mode to `@lesto/content-mcp` (keystone).** Extend `McpServerOptions`
   with `tools?: "read" | "all"` (default `"all"`, preserving today's behavior). The filter
   must close **all three** surfaces, because advertising is not enforcement:
   (a) the advertised `TOOLS` list (`server.ts:569`); (b) the **dispatch table the
   `handleToolCall` path actually consults** — `TOOL_HANDLERS` (`server.ts:504-515`), read
   at `server.ts:539` after the `name in TOOL_SCHEMAS` admit at `server.ts:528`; and
   (c) `handleToolCall` itself must **reject** a name outside the filtered set (not merely
   reject names absent from `TOOL_SCHEMAS`). Filtering only the advertised list is security
   theater — an agent can still invoke `create_entry`/`update_entry` *by name* through the
   dispatch path. The previous draft's claim that the existing server "adds no write tools"
   was wrong, and an earlier revision's "filter the list and the table" missed that the
   *dispatch lookup* is the load-bearing path. This step lands in `@lesto/content-mcp`,
   which is a `content-` package and so rides the Docks coverage baseline; **but** because
   this branch is a **security boundary**, its acceptance requires **explicit 100% coverage
   on the new `tools: "read"` branch (both the list filter and the dispatch refusal),
   independent of the package's lower Docks baseline** (see *Deferred — Correction*). A
   **negative test** calls `create_entry` **by name** under `tools: "read"` and asserts a
   coded refusal — not merely that it is absent from `list_tools` output.
2. **Mount the filtered (read-only) content-mcp surface at `site/`, feeding its programmatic
   config.** `site/` has **no** `docks.config`, so `createMcpServer({ cwd })` would throw at
   startup (`resolveConfig(cwd)` throws `No docks.config…`, `config.ts:135-138`). The fix is
   to **thread a programmatic config**: extend `createMcpServer` to accept the app's resolved
   content config and pass it through `resolveConfig`'s existing `programmaticConfig` arg
   (`config.ts:112-130`), sourcing `site/`'s default-exported config (`site/lesto.content.ts:89`,
   the `docs`/`blog`/`changelog` collections). With that, the read-only-filtered server
   exposes `site/`'s `docs` collection to an agent building a Lesto app — its convention scan
   (Phase 1) tells the agent the conventions; this gives it the *reference docs* as grounded
   context. This adds a new `site → @lesto/content-mcp` workspace dependency (allowed:
   `site/` is an app, not kernel). The transport `@lesto/content-mcp` ships today is **stdio**
   (`server.ts:543,619`) — Phase 2 mounts that; a remote/HTTP docs transport is **deferred**
   to a real-consumer gate (see *Deferred*), and would be mounted by the **app** or a small
   adapter, **never** by kernel (the wave-wide `kernel → mcp` no-cycle invariant; cf. ADR
   0028 / 0031).
3. **Emit a docs-specific `llms.txt`** from the `docs` collection — the same scan-then-render
   shape as Phase 1, run over `site/`'s `docs` collection, so the public docs site advertises
   a machine index. This artifact is the **docs** index and is **conceptually distinct** from
   Phase 1's project `llms.txt`; to avoid clobbering / perpetual `--check` drift, the two are
   written to **distinct paths** — Phase 1's project index at `site/llms.txt`, the docs index
   at `site/public/llms-docs.txt` (served as the docs machine index). The `--check` drift
   gate covers each artifact against its own generator. This is the `gallery-as-QA-gate`
   dogfood: `site/` must build and deploy with both artifacts present, or the feature is not
   done.

Phase 2's read-only MCP surface inherits content-mcp's existing fail-closed,
schema-validated tool dispatch (`server.ts:521-541`); after the read filter it advertises
and dispatches **no write tools** (docs are authored in the repo, not over MCP) — and the
acceptance for the mount asserts that the `read` filter excludes `create_entry`/
`update_entry` from the advertised list **and** that a by-name dispatch of them is refused.

### Phase 3 — PREVIEW / opt-in, gated on a real consumer: the `lesto eval` CI gate

A `lesto eval` command that gathers an app's declared `Eval`s and runs them as a gate,
modeled on `scripts/coverage-gate.ts` (discover → run serially → non-zero exit on
failure). It composes `@lesto/ai`'s `createLlmJudge`/`guard`/`Eval`
(`evals.ts:32,64,98`).

- **A real discovery convention, not just an injected loader.** Evals live at
  **`app/evals/*.eval.ts`**, each module default-exporting one or more `Eval`s. The runner
  ships a **default on-disk loader** that globs this convention (alongside the injected
  loader the tests use), so the real `lesto eval` has something concrete to find — a gate
  that cannot locate an app's evals is a hollow gate. The acceptance asserts the default
  loader discovers a **fixture eval on disk** at `app/evals/`, not only an injected fake.
- **PREVIEW, explicitly, behind a lazy import — with a declared optional peer.** Because it
  depends on the PREVIEW, coverage-gate-exempt `@lesto/ai` (`ai/src/index.ts:17-19`; the
  exemption is the **absence of a `test:cov` script** picked up by `coverage-gate.ts:35`,
  not the literal word "preview"), the `lesto eval` gate ships at **that** bar: marked
  PREVIEW in code and in any public copy, **opt-in** (an app that declares no evals is not
  gated by it; CI never auto-fails on it for apps that have not adopted it), and it does
  **not** itself become a 100%-coverage-gated package surface beyond its own pure runner
  logic. **The `@lesto/ai` import is a lazy/dynamic `await import("@lesto/ai")` inside the
  `runEval` path**, so the supported, full-bar `@lesto/cli` does **not** gain a hard, eager
  dependency edge on a PREVIEW package: `@lesto/ai` is resolved only when `lesto eval`
  actually runs. **But the edge must still carry a version constraint:** `@lesto/ai` is
  declared an **optional `peerDependency`** of `@lesto/cli` (mirroring the established
  `@lesto/content-core` precedent — `peerDependencies` + `peerDependenciesMeta.optional`,
  `cli/package.json:39-48` — which is also dynamically imported), *not* "no entry at all."
  A bare `import("@lesto/ai")` with no declared peer relationship has no version constraint
  and only resolves by accidental workspace hoisting; the optional peer fixes that while
  keeping `@lesto/ai` out of `dependencies` and out of the eager graph. The invariant is
  therefore "**no `@lesto/ai` in `dependencies`, and no top-level `from "@lesto/ai"`
  import**" — *not* "no `@lesto/ai` entry anywhere in `cli/package.json`." (The alternative
  — a separate optional `@lesto/eval` package — was considered and rejected as premature.)
- **Modest claim only.** This gives AI features *a* test gate (pass/fail against the app's
  own rubrics) — it is **not** an accuracy/quality claim and ships **no** benchmark
  numbers. The evals an app writes are the app's; Lesto ships the *runner and the gate
  seam*, not a published eval suite or quality score.
- **The decision contract is a code, not a string.** A failed gate surfaces the eval's
  own `EvalResult.code` (`evals.ts:27-28`) and the `AI_GUARDRAIL_BLOCKED` code from
  `guard` (`evals.ts:102`); the runner branches on codes, the same cross-package
  discipline as the queue's `PERMANENT_FAILURE` structural marker
  (`packages/queue/src/errors.ts`).

**Ordering:** Phase 1's scan lands first (it is the single source the other artifacts
render from). Phase 2 reuses Phase 1's renderer shape but **must** add the content-mcp
read-only filter (keystone) before mounting at `site/`. Phase 3 is independent and may land
anytime, but ships marked PREVIEW (behind a lazy `@lesto/ai` import).

## Non-goals

- **Not a visual CMS / Studio editor.** Docs-as-MCP is *read-only context* — enforced by a
  new `tools: "read"` filter in `@lesto/content-mcp` that excludes the server's write tools
  from the advertised list **and refuses them on the dispatch path** (a by-name call to
  `create_entry`/`update_entry` is rejected, not merely un-advertised) at the `site/` mount;
  authoring stays in the repo. (Claims guardrail: "a content engine," not "a visual CMS.")
- **Not an evals harness / dataset runner / dashboard.** ADR 0021 deferred the
  convenience layer (`evals.ts:11-13`); `lesto eval` is a thin gate over the existing
  hook, nothing more.
- **No AI accuracy/quality claim, no benchmark numbers.** The gate is pass/fail against an
  app's own rubric; nothing public claims a score (messaging §5 banned register).
- **No hand-authored, drift-prone `AGENTS.md`.** Artifacts render from the scan; the only
  hand-authored text lives outside the managed region.
- **No remote/HTTP docs MCP transport in this ADR.** Stdio only (what content-mcp ships);
  remote is deferred to a real consumer, and would never be mounted by kernel.
- **The `lesto eval` gate is not held to the 100% coverage gate** beyond its own runner —
  it inherits `@lesto/ai`'s PREVIEW exemption, and says so loudly.

## Deferred — recorded, not scheduled; each gated on a real consumer

- **Remote/HTTP docs MCP transport** — gated on a hosted-docs-as-MCP consumer (an agent
  reaching docs over the network, not a locally-configured stdio server). When built, it
  is mounted by the app or a `@lesto/mcp-http`-style adapter, **never** kernel (no
  `kernel → mcp` cycle).
- **`AGENTS.md` for nested/monorepo sub-apps** — gated on a real multi-app repo wanting
  per-package agent files; the Phase 1 scan is single-app.
- **Embedding/RAG over the docs for MCP search** — `@lesto/content-search` has the
  machinery (`packages/content-search/src/rag-fallback.ts`), but the content-mcp
  `search_content` tool is substring today (`server.ts:269-302`); upgrading it to
  semantic search is gated on an MCP consumer that needs it, and would ship PREVIEW (it
  pulls in PREVIEW AI surface).
- **An evals dataset runner / score dashboard** — gated on an app with a curated eval
  dataset wanting trend tracking; ADR 0021's deferred convenience layer.
- **Correction recorded (so it is not re-derived):** the coverage gate's exemption rule is
  the **absence of a `test:cov` script** *plus* the `content-` prefix skip — **not** the
  word "preview." `scripts/coverage-gate.ts` skips every `content-`-prefixed package
  (line 27) and any package that declares no `test:cov` (line 35). So: `@lesto/content-mcp`
  rides the Docks baseline (it is a `content-` package); `@lesto/ai` is exempt because it
  declares **no** `test:cov` (its `index.ts:17-19` note says so); but `@lesto/ui-generate`
  **does** declare `test:cov`, so it **is** gated at 100% (a sibling-ADR overclaim
  corrected wave-wide). For *this* ADR: new `@lesto/cli` code (Phase 1/3 runner logic) **is**
  fully gated; the Phase 2 read-only filter lives in the content-baseline package — **but its
  security-boundary branch (`tools: "read"` list filter + dispatch refusal) is held to
  explicit 100% regardless of that baseline** (see *Decision Phase 2* #1).

## Reviews

- **Internal adversarial pass — three lenses.**
  - **Correctness/security.** Surfaced that docs-as-MCP must stay **read-only** (no write
    tools at `site/`), and that any future remote transport must not be mounted by kernel
    (the wave-wide no-cycle invariant). Pinned the `lesto eval` decision contract to the
    eval **code** (`evals.ts:27-29,102`), not a message string. Confirmed the AGENTS.md
    managed-region + `--check` drift guard so a regenerated file is byte-stable and an
    author's hand-written guidance is never clobbered.
  - **Simplicity/scope.** **Cut** building an evals harness/dashboard (ADR 0021 already
    deferred it — `lesto eval` is a thin gate). **Cut** rebuilding docs-as-MCP — the
    content-mcp server already ships the read tools and stdio transport (`server.ts:543`),
    so Phase 2 is *wiring*, not new machinery. **Corrected** the coverage-gate assumption:
    `content-mcp` is a `content-` package and thus **excluded** from the 100% serial gate
    (`coverage-gate.ts`), so new content-mcp code does not ride the same bar as new CLI code.
  - **Sequencing/coupling.** Established the scan as the single source so `AGENTS.md`,
    `llms.txt`, and the docs index cannot diverge; ordered the scan **before** the
    renderers. **Downgraded** the `lesto eval` gate to PREVIEW/opt-in to match
    `@lesto/ai`'s preview status (`index.ts:18-20`) rather than smuggling a preview
    dependency into a full-bar command. Kept the convention scan web-decoupled and
    fully-injected (the `generate.ts` discipline) so it is 100%-testable with no disk.
- **What survived as already-minimal:** the convention-scan keystone, the reuse of the
  ADR 0019 `GenerateIO` seam, and the reuse (with a small read-only filter, not a rebuild)
  of the content-mcp server.

- **Second internal adversarial pass — 3 must-fix + 4 should-fix, all applied.** A
  code-grounded re-read of the cited files found three correctness errors in the first
  draft and four sequencing/layering gaps, all now fixed in place:
  - **MUST-FIX (security): the "read-only" docs-MCP claim was false.** `@lesto/content-mcp`
    builds, advertises (`const tools = TOOLS`, `server.ts:569`), and dispatches
    (`server.ts:511-514`) `create_entry`/`update_entry`, and `McpServerOptions` is
    `{ cwd }`-only (`server.ts:23-25`) — there is **no** read-only mode. Mounting it as-is
    at `site/` would let an agent mutate the docs. **Fix:** Phase 2 now has a keystone
    first step — add `tools?: "read" | "all"` to `@lesto/content-mcp` that filters **both**
    the advertised `TOOLS` and the dispatch table to the four read tools — and the mount
    acceptance asserts the write tools are excluded from list *and* dispatch, rather than
    asserting a property the server does not have.
  - **MUST-FIX (correctness): no `cliCommands` constant exists.** The draft cited
    `bin.ts:553-588` as "the static CLI-command list the CLI already owns." It does not
    exist: dispatch is imperative `if (command === …)` branches (`bin.ts:560,573,587`) and
    the only command text is the human `USAGE` array (`run.ts:373-400`). **Fix:** a new
    exported command-descriptor constant (sourced from `USAGE`) is now an explicit small
    artifact in Inc 1, and the prose no longer claims the CLI already owns it.
  - **MUST-FIX (scope): islands were rendered but not scanned.** Islands were listed as an
    `AGENTS.md`/`llms.txt` artifact but were neither a `scanConventions` parameter nor a
    reader. Islands are real (`app/islands/`, `run.ts:238`) but covered by neither
    `scanRoutes` nor `getCollections`. **Fix:** a new injected glob-reader over
    `app/islands/` and an `islands` parameter on `scanConventions` + `AgentArtifacts`, with
    its own acceptance.
  - **SHOULD-FIX (layering): full-bar `@lesto/cli` must not eagerly depend on PREVIEW
    `@lesto/ai`.** **Fix:** the `lesto eval` runner imports `@lesto/ai` via a lazy
    `await import("@lesto/ai")`, keeping the edge out of the CLI's eager dependency graph
    (a separate `@lesto/eval` package was considered and rejected as premature).
  - **SHOULD-FIX (sequencing): closed `CliErrorCode` union.** New `CLI_AGENTS_*` codes
    require editing `errors.ts` *before* the throwing code compiles, so `errors.ts` is now
    in the Files of the first increment that needs a code (Inc 4) and of Inc 8.
  - **SHOULD-FIX (scope): new `site → @lesto/content-mcp` dependency** is now called out
    explicitly (allowed: `site/` is an app), with the no-`kernel → mcp` invariant kept.
  - **NITs:** corrected the coverage-gate "Correction recorded" prose to a single clean
    sentence; tightened anchors (`bin.ts:17-18` for the router/web imports, `bin.ts:587`
    for the generate dispatch, `server.ts:137-176` read-tool builders vs `176-205` write).

- **Independent red-team + chief-architect pass (2026-06-22).** A 9-lens independent
  red-team (per-ADR + cross-cutting security/layering/sequencing/honesty) plus a
  chief-architect synthesis reviewed ADRs 0031–0035 against the **current** tree. Verdict
  for 0035: **ratify-with-fixes** — Phase 1 called out as "a genuinely sound, minimal
  abstraction … fully on the right side of layering" and "the highest-leverage, gate-free
  cut," recommended **promoted to the front of the wave**. All seven must-fixes are applied
  in place:
  - **MUST-FIX (security): the read-only filter must close the DISPATCH path, not just the
    advertised list.** `handleToolCall` admits any name in `TOOL_SCHEMAS`
    (`server.ts:528`) then dispatches via `TOOL_HANDLERS[toolName]` (`server.ts:539`) —
    filtering only the advertised `TOOLS` list is security theater (an agent can invoke
    `create_entry` *by name*). **Fix:** Phase 2 #1 now filters the **dispatch lookup**
    (`TOOL_HANDLERS`, `server.ts:539`) and makes `handleToolCall` **refuse** names outside
    the filtered set, with a **negative test** that calls `create_entry` by name under
    `tools: "read"` and asserts a coded refusal. Because this branch is a security boundary
    in a content-baseline package, it is held to **explicit 100% coverage** despite the
    `content-` exemption (Plan Inc 7).
  - **MUST-FIX / BLOCKER (Inc 8): mounting content-mcp at `site/` throws.** `site/` has no
    `docks.config`, and `createMcpServer({ cwd })` calls `resolveConfig(cwd)`
    (`server.ts:546`), which throws `No docks.config…` (`config.ts:135-138`). **Fix:** Phase 2
    #2 + Plan Inc 8 now **thread a programmatic config** — `createMcpServer` accepts the
    resolved config and passes it through `resolveConfig`'s `programmaticConfig` arg
    (`config.ts:112-130`), sourced from `site/lesto.content.ts:89`.
  - **MUST-FIX (sequencing): Inc 6 and Inc 8 both wrote `site/llms.txt`.** Two generators on
    one path → clobber / perpetual `--check` drift. **Fix:** the project index stays at
    `site/llms.txt` (Inc 6); the docs index moves to `site/public/llms-docs.txt` (Inc 8), and
    each `--check` covers its own generator.
  - **MUST-FIX (Inc 9): no eval-discovery convention.** **Fix:** Phase 3 now defines
    `app/evals/*.eval.ts` (default-exporting `Eval`s) with a default on-disk loader and an
    acceptance that the real loader discovers a fixture eval on disk — not only an injected
    fake.
  - **MUST-FIX (Inc 1): the command list was sourced from `USAGE`, which omits
    `mcp`/`openapi`.** `USAGE` (`run.ts:373-400`) is incomplete; both `mcp` and `openapi` are
    dispatchable (`bin.ts:560,573`). **Fix:** the descriptor constant is now sourced from the
    **actual dispatch set** (the `command === …` branches), with a two-way sync test;
    `USAGE` is treated as docs to cross-check, not the authority.
  - **MUST-FIX (layering): `@lesto/ai` must be an optional peerDependency, not "no entry."**
    A bare `import("@lesto/ai")` with no declared peer has no version constraint and resolves
    only by accidental hoisting; the repo precedent is `@lesto/content-core` as an optional
    peer (`cli/package.json:39-48`). **Fix:** declare `@lesto/ai` as an optional
    `peerDependency`, keep the lazy `await import`, and restate the invariant as "no
    `@lesto/ai` in `dependencies` + no top-level import" (not "no entry anywhere").
  - **SHOULD-FIX (correctness): `getCollections` reads the compiled store, gated on
    content-core being installed + the store built.** It is a zero-arg read of `loadData()`
    (`runtime.ts:204`), not "the app's content config." **Fix:** the collection reader now
    **degrades gracefully** to "no collections" when content-core is absent (optional peer)
    or the store is unbuilt, with acceptances for both paths, so `--check` stays
    deterministic.
  - **NIT (honesty): the coverage-exemption rule is `test:cov`-absence + the `content-`
    skip, not "preview."** Corrected the "Correction recorded" prose accordingly (and noted
    `@lesto/ui-generate` IS gated because it declares `test:cov`).
  - **Re-anchoring:** every `file:line` citation was re-checked against the current tree.
    Confirmed-current: `server.ts:23-25,137-176,176-205,504-515,521-541,528,539,543,569,619`;
    `evals.ts:32,64,98,102`; `errors.ts:13-26`; `generate.ts:38-48`; `coverage-gate.ts:27,35`;
    `bin.ts:17-19,560,573,587`; `run.ts:373-400`; `scan.ts:97`; `router/index.ts:38-39`.
    Corrected: `evals.ts:98`→`:102` for `AI_GUARDRAIL_BLOCKED` and `:27-29`→`:27-28` for
    `EvalResult.code`; `run.ts:238`→`:237-244` (the `hasIslandsDir` probe); `getCollections`
    re-anchored to `runtime.ts:204` (impl) alongside `index.ts:66` (re-export);
    `file-routes.ts:80-177`→`:80,119,137` (the `FileRouteKind`/`DiscoveredFile`/`FileRoute`
    defs); `ai/src/index.ts:18-20`→`:17-19`. New anchors added:
    `config.ts:112-130,135-138` (programmaticConfig + the throw) and `cli/package.json:39-48`
    (the content-core optional-peer precedent). The stale `tools.ts:46` reference was dropped
    (no longer load-bearing).

## Consequences

- Any Lesto app gains a generated, drift-proof `AGENTS.md` + `llms.txt` — so Claude
  Code / Cursor / etc. meet the app's real conventions instead of reverse-engineering
  them. This is the concrete payoff of the "agent-native" positioning, shippable at the
  full bar with no model in the loop.
- The docs become grounded context for an agent *building* on Lesto, reusing the
  content-mcp server already in the tree — additive, read-only, dogfooded on `site/` as
  the QA gate.
- AI features get *a* quality gate (`lesto eval`) — honestly scoped as PREVIEW/opt-in,
  with **no** accuracy or benchmark claim. It is the cheapest sound primitive: a runner
  over the evals hook ADR 0021 already shipped, not a harness.
- Cost, stated: the `lesto eval` gate is the least mature piece (it rides PREVIEW
  `@lesto/ai`) and must not be over-claimed; the docs-as-MCP transport is stdio-only until
  a remote consumer earns the HTTP surface. Slow iteration upheld — only the convention
  scan + its first two renderers are the committed keystone; the rest is gated.
