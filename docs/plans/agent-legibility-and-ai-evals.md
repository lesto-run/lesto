# Agent legibility & AI quality gates — implementation plan

Derived from **ADR 0035**. The committed build-now is **Phase 1**: a
`lesto generate agents` command that renders a project-specific `AGENTS.md` + `llms.txt`
from a pure **convention scan** over the app's real structure (routes, islands,
collections, CLI commands). Per the 2026-06-22 chief-architect synthesis, Phase 1 is the
**highest-leverage, gate-free, cross-ADR-dependency-free cut in the agent-native wave** and
is **built first / promoted to the front of the wave** (it does not depend on ADR 0031's
spans). **Phase 2** (docs-as-MCP wired at `site/` + a **docs-specific** `llms.txt` at a
**distinct path**, dogfooded as the QA gate) is gated on Phase 1's scan being the single
source of agent artifacts **and** on a keystone read-only filter being added to
`@lesto/content-mcp` first — one that closes **both** the advertised list **and the
dispatch path** (the server ships write tools today — `create_entry`/`update_entry`,
advertised `server.ts:569`, dispatched via `TOOL_HANDLERS[toolName]` at `server.ts:539`
after the `name in TOOL_SCHEMAS` admit at `server.ts:528` — and has no read-only mode,
`McpServerOptions = { cwd }`, `server.ts:23-25`); the `site/` mount also requires threading
a **programmatic config** into `createMcpServer` because `site/` has no `docks.config`
(`resolveConfig(cwd)` would throw, `config.ts:135-138`; the `programmaticConfig` arg exists
at `config.ts:112-130`). **Phase 3** (a `lesto eval` CI gate over `@lesto/ai`'s evals hook,
discovered via a new `app/evals/*.eval.ts` convention) is **PREVIEW / opt-in** — it composes
the PREVIEW, coverage-gate-exempt `@lesto/ai` (`packages/ai/src/index.ts:17-19`; exempt
because it declares **no `test:cov`**, `coverage-gate.ts:35`, not because of the word
"preview") behind a **lazy `await import("@lesto/ai")`** with `@lesto/ai` declared an
**optional `peerDependency`** of `@lesto/cli` (mirroring `@lesto/content-core`,
`cli/package.json:39-48`) so the edge has a version constraint without entering the eager
graph, and is labeled PREVIEW in code and public copy.

**Packages:** `@lesto/cli` (the new `generate agents` + `eval` commands and the pure
convention scan / renderers — the only fully-100%-gated surface here);
`@lesto/router` (reused, type-only/thin-runtime, for `scanRoutes` + `DirReader`,
`scan.ts:97`, `index.ts:38-39`; descriptor shape `file-routes.ts:80,119,137`);
`@lesto/content-core` (reused for `getCollections`, re-exported `index.ts:66`, implemented
`runtime.ts:204` — a zero-arg read of the compiled store, so the reader degrades to "no
collections" when content-core is absent or the store is unbuilt; **also modified** — the
read-only mount threads its `programmaticConfig` arg, `config.ts:112-130`, in Inc 8);
`@lesto/content-mcp` (**modified** — gains a read-only `tools` filter on `McpServerOptions`
that closes the list **and** the dispatch path, plus a programmatic-config entry, Inc 7; a
`content-` package, so on the Docks baseline NOT the 100% gate — **except** its
security-boundary read-filter branch, held to explicit 100%); `@lesto/ai` (reused for
`Eval`/`createLlmJudge`/`guard`, `evals.ts:32,64,98` — PREVIEW, imported lazily, declared an
optional peerDep of `@lesto/cli`); `site/` (the docs-as-MCP dogfood + the gallery-as-QA gate
— gains a new `@lesto/content-mcp` workspace dependency in Inc 8).

> **The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on
> touched packages; `bun run ws:typecheck` + the serial coverage gate
> (`bun scripts/coverage-gate.ts`) green; coded errors; truthful doc comments; one
> conventional commit on `main`. Layering invariants, grep-asserted: `@lesto/cli` gains
> **no eager** runtime dependency on `@lesto/ai` — `@lesto/ai` appears **only** inside the
> Phase 3 `lesto eval` path and **only** via a lazy `await import("@lesto/ai")`, so it
> never enters the CLI's static dependency graph (grep: no top-level `from "@lesto/ai"` in
> `@lesto/cli`; no `@lesto/ai` in `cli/package.json` **`dependencies`**). It **is** declared
> an **optional `peerDependency`** (`peerDependencies` + `peerDependenciesMeta.optional`,
> mirroring `@lesto/content-core`, `cli/package.json:39-48`) so the lazy edge carries a real
> version constraint — the invariant is "no `@lesto/ai` in `dependencies` + no top-level
> import," **not** "no `@lesto/ai` entry anywhere." The convention scan and renderers are
> **pure** over injected readers + the `GenerateIO` seam (`packages/cli/src/generate.ts:38-48`)
> — **no** direct `fs`/`process` in the decision path (inject the reader instead);
> `@lesto/cli` gains **no** `@lesto/web` *value* coupling beyond the route-scan it already
> does (`bin.ts:17-19`); the docs-MCP surface at `site/` registers **no write tool** —
> enforced by the `tools: "read"` filter added to `@lesto/content-mcp` (Inc 7), asserted to
> exclude `create_entry`/`update_entry` from the advertised list **and to refuse a by-name
> dispatch of them** (the dispatch path at `server.ts:539` is the load-bearing one); **no**
> `kernel → mcp` edge is introduced by any docs transport (a remote transport, if ever
> built, is mounted by the app/adapter, never kernel).

(Commits are conventional single-line `type(scope): summary` on `main` — **no**
Co-Authored-By / "Generated with Claude" / 🤖 trailer.)

## Increments

1. **The convention scan — pure facts in, agent-artifact model out** — `[keystone]`
   Files: `packages/cli/src/agents/scan.ts` (new), `packages/cli/src/agents/types.ts` (new),
   `packages/cli/src/agents/commands.ts` (new — the exported CLI command-descriptor
   constant).
   The single source the other artifacts render from. A pure
   `scanConventions(routes, islands, collections, cliCommands, configSummary) →
   AgentArtifacts` over already-real facts: route descriptors (shape from `@lesto/router`'s
   `FileRoute`/`DiscoveredFile`, `file-routes.ts:80,119,137`), an **island inventory** (a
   flat list of island module names, produced by the Inc 4 glob-reader over `app/islands/`),
   the collection inventory (from `getCollections`, re-exported `content-core/src/index.ts:66`,
   implemented `runtime.ts:204` — a zero-arg read of the **compiled store**, so the value
   handed to the scan must already be degraded-to-empty when content-core is absent or the
   store is unbuilt; the scan stays pure over whatever list it receives), and a
   **CLI command list** read from a new exported descriptor constant in `commands.ts`.
   There is **no** scannable command constant today (dispatch is imperative
   `if (command === …)` branches, `bin.ts:560,573,587`), and the human `USAGE` array
   (`run.ts:373-400`) is **incomplete** — it omits `mcp`/`openapi`, both dispatchable
   (`bin.ts:560,573`). So the descriptor's **authority is the actual dispatch set** (the
   `command === …` branches + the `run` core's commands), **not** `USAGE` (cross-checked
   only). No disk, no model — exactly the `generate.ts` purity discipline
   (`generate.ts:38-48`). Stays in `@lesto/cli`; uses `@lesto/router` types only.
   Acceptance: `scanConventions` is a pure function with no `fs`/`process` import (grep-asserted);
   given fixture routes/islands/collections/commands it returns a deterministic
   `AgentArtifacts`; an empty app (no routes, no islands, no collections) is representable
   and flagged; the `commands.ts` descriptor constant lists **every dispatchable** `lesto`
   command — **including `mcp` and `openapi`** — and a **two-way** sync test asserts the
   constant and the dispatch set agree (neither direction may silently drop a command);
   covered to 100%.

2. **`AGENTS.md` renderer with a managed region + `--check` drift guard** — `[the binding]`
   Files: `packages/cli/src/agents/render-agents.ts` (new), `packages/cli/src/agents/managed-region.ts` (new),
   `packages/cli/src/errors.ts` (extend the closed `CliErrorCode` union with
   `CLI_AGENTS_MARKER_MALFORMED` — required *before* `managed-region.ts` can throw it and
   compile).
   A pure `renderAgentsMd(artifacts) → string` rendering the route conventions in force,
   the island/collection inventory, and the available `lesto` CLI commands, wrapped in a
   delimited `<!-- lesto:generated -->` … `<!-- /lesto:generated -->` region so an
   author's hand-written guidance outside it is preserved (idempotency rule,
   `generate.ts:29-33`). A pure `mergeManagedRegion(existing, generated)` replaces only
   the region; `--check` diffs and reports drift without writing (the `routes.gen.ts`
   freshness pattern).
   Acceptance: rendering is deterministic/byte-stable; `mergeManagedRegion` preserves
   text outside the markers and replaces inside them; re-merging generated output over its
   own prior output is a no-op (idempotent); `--check` returns a stable drift signal;
   missing/duplicate markers raise a coded `CliError` (`CLI_AGENTS_MARKER_MALFORMED`,
   following the existing `CLI_GENERATE_*` prefix convention, `errors.ts:13-26`); tests
   branch on the code, never the message; 100%.

3. **`llms.txt` renderer** — `[reuses Inc 1]`
   Files: `packages/cli/src/agents/render-llms.ts` (new).
   A pure `renderLlmsTxt(artifacts) → string` emitting the flat, linkable machine index
   (routes + islands + collections + CLI surface) from the same scan. Same purity +
   idempotency discipline as Inc 2.
   Acceptance: deterministic output over fixture artifacts; stable ordering (no Map/Set
   iteration nondeterminism); empty-app case renders a valid minimal index; 100%.

4. **`runGenerateAgents` — inject the readers (incl. islands) + `GenerateIO`, wire idempotent writes** — `[order-critical]`
   Files: `packages/cli/src/agents/run.ts` (new), `packages/cli/src/errors.ts` (extend the
   closed `CliErrorCode` union with `CLI_AGENTS_NOTHING_TO_SCAN` — required *before*
   `run.ts` can throw it and compile).
   The orchestrator that reads conventions through **injected** readers: a `DirReader` for
   `scanRoutes` (`scan.ts:97`/`index.ts:39`); a content-config loader for `getCollections`
   (re-exported `index.ts:66`, implemented `runtime.ts:204` — a zero-arg read of the
   **compiled store**, gated on content-core being installed as an optional peer and the
   store being built; the loader **degrades to "no collections"** rather than throwing when
   the peer is absent or the store is unbuilt, so `--check` stays deterministic); and a
   **new injected island glob-reader** over `app/islands/` (the directory the CLI already
   probes via the `hasIslandsDir` seam, `run.ts:237-244`) returning the island module names
   — islands are covered by neither `scanRoutes` nor `getCollections`, so this reader is the
   only source of the island inventory the renderers emit. Plus the ADR 0019 `GenerateIO` seam
   (`generate.ts:38-48`) and the renderers (Inc 1–3).
   The scan runs **before** any write; a file that exists has only its managed region
   merged, never clobbered; `--dry-run` prints the plan and writes nothing; `--check`
   exits non-zero on drift. Every refusal (unreadable config; an app with no routes, no
   islands, and no collections — nothing to describe) throws a coded `CliError`
   (`CLI_AGENTS_NOTHING_TO_SCAN`). Stays in `@lesto/cli`; all I/O injected so it is tested
   with a fake reader (routes, islands, collections) + fake `GenerateIO` + capturing `out`,
   no disk.
   Acceptance: a test drives `runGenerateAgents` with fake readers (incl. a fake island
   reader)/`GenerateIO` and asserts the exact files + content written and lines printed;
   the island inventory appears in both `AGENTS.md` and `llms.txt`; `--dry-run` writes
   nothing; `--check` exits non-zero on drift and zero when fresh; the nothing-to-scan
   refusal throws `CLI_AGENTS_NOTHING_TO_SCAN` and the test branches on the **code**, never
   the message; **the content-peer-absent and store-not-built paths degrade to "no
   collections" (not a throw, not a state-dependent list)** — each with its own test; no
   real `fs`/`process` reached (grep-asserted); 100%.

5. **Dispatch `generate agents` / `g agents` in the CLI bin** — `[committed]`
   Files: `packages/cli/src/bin.ts`.
   Add the `agents` sub-path next to the existing `generate`/`g` dispatch
   (the `if (command === "generate" || command === "g")` branch at `bin.ts:587`), wiring
   `runGenerateAgents` with the real `GenerateIO`,
   `scanRoutes`/`DirReader`, and content-config loader. Additive; no new runtime
   dependency; the bin stays a thin wiring layer (its pure core is Inc 1–4).
   Acceptance: `lesto generate agents` and `lesto g agents` resolve to
   `runGenerateAgents`; the bin's branch is exercised; `ws:typecheck` green; no new
   forbidden import (grep-asserted: no `@lesto/ai` import added in the Phase 1 path); 100%
   on `@lesto/cli`.

6. **Dogfood Phase 1 on `site/` — generate `AGENTS.md` + the PROJECT `llms.txt`, gate on build** — `[per gallery-as-QA-gate]`
   Files: `site/AGENTS.md` (new, generated), `site/llms.txt` (new, generated — the
   **project** index), `site/build.ts` (a `--check` drift step), `site/package.json` (a
   script).
   Run `lesto generate agents` against `site/` (a real Lesto app, `site/package.json`),
   commit the generated artifacts, and add a `--check` step to `site/build.ts` so a
   convention change that would stale the artifacts fails the build. **Path discipline (must-fix):**
   this increment owns **only** `site/llms.txt` (the convention-scan **project** index); the
   **docs** index is a *different* artifact at a *different* path, owned by Inc 8
   (`site/public/llms-docs.txt`), so the two generators never clobber one path and `--check`
   never reports perpetual drift. This is the QA gate: the feature is not done until `site/`
   builds with the artifacts present and the drift check green.
   Acceptance: `site/AGENTS.md` + `site/llms.txt` exist and match a fresh `--check`;
   `site/`'s build runs the drift check and fails on staleness; `site/` builds (and
   deploys) with the artifacts; the generated `AGENTS.md` accurately lists `site/`'s docs
   collection + the full CLI surface (incl. `mcp`/`openapi`); **no other increment writes
   `site/llms.txt`** (the docs index lives at `site/public/llms-docs.txt`); 100% on touched
   `@lesto/cli` paths.

7. **Read-only mode for `@lesto/content-mcp` (the docs-MCP keystone + programmatic-config entry)** — `[keystone — blocks Inc 8]`
   Files: `packages/content-mcp/src/server.ts` (the `tools` filter + a `config?: EngineConfig`
   option threaded into `resolveConfig`), `packages/content-mcp/test/…` (coverage; the
   read-filter branch is held to **explicit 100%** — see below).
   The existing server is **not** read-only: it builds, advertises (`const tools = TOOLS`,
   `server.ts:569`), and dispatches `create_entry`/`update_entry` via
   `TOOL_HANDLERS[toolName]` (`server.ts:511-514,539`) after the `name in TOOL_SCHEMAS` admit
   (`server.ts:528`), and `McpServerOptions` is `{ cwd }`-only (`server.ts:23-25`). Two
   surgical changes:
   (a) **read-only filter (security boundary).** Add `tools?: "read" | "all"` to
   `McpServerOptions` (default `"all"`, preserving current behavior) and filter **all of**:
   the advertised `TOOLS` array (the `ListToolsRequestSchema` handler, `server.ts:569`);
   **the dispatch table the `handleToolCall` path actually reads** — `TOOL_HANDLERS` at
   `server.ts:539`; and `handleToolCall` must **reject** any name outside the filtered set
   (not merely names absent from `TOOL_SCHEMAS`). Filtering only the advertised list is
   security theater — an agent can call `create_entry` *by name* through the dispatch path.
   (b) **programmatic-config entry (unblocks Inc 8).** Add a `config?: EngineConfig` (or
   equivalent) option to `createMcpServer`/`startMcpServer` and pass it through
   `resolveConfig(cwd, programmaticConfig)` (`config.ts:112-130`) so a caller with no
   `docks.config` (i.e. `site/`) can still mount; preserve the cwd-resolution default when
   `config` is omitted.
   `content-mcp` is a `content-` package, so it rides the Docks coverage baseline
   (`coverage-gate.ts:27` skips `content-`), **not** the 100% serial gate — **except** the
   new `tools: "read"` branch, which is a **security boundary** and is therefore held to
   **explicit 100% coverage (both the list filter and the dispatch refusal), independent of
   the Docks baseline** (per ADR 0035 *Decision Phase 2* #1).
   Acceptance: with `tools: "read"`, the advertised list excludes
   `create_entry`/`update_entry`; a **negative test calls `create_entry` BY NAME** under
   `tools: "read"` and asserts a **coded refusal** (not just absence from `list_tools`);
   with `tools: "all"` (and the default) behavior is unchanged (existing tests pass
   byte-for-byte); `createMcpServer({ cwd, config })` resolves via `programmaticConfig` and a
   test mounts against a config object with **no** `docks.config` on disk (proving the Inc 8
   path); the read-filter branch reports **100%** coverage; the `content-mcp` Docks baseline
   does not regress.

8. **Docs-as-MCP: mount the read-only content-mcp server at `site/` (via programmatic config) + emit the DOCS `llms.txt`** — `[reuses Inc 3 + Inc 7; blocked by Inc 7]`
   Files: `site/lesto.content-mcp.ts` (new — a thin entrypoint), `site/package.json`
   (**new** `@lesto/content-mcp` workspace dependency **and** an `mcp:docs` script),
   `site/public/llms-docs.txt` (the **docs** index — same renderer as Inc 3, **a distinct
   path from Inc 6's `site/llms.txt`**).
   Mount the **read-only-filtered** `@lesto/content-mcp` stdio server against `site/`'s `docs`
   collection — **feeding the programmatic config** because `site/` has **no** `docks.config`
   (`createMcpServer({ cwd, tools: "read", config })`, using Inc 7's new `config` option +
   `server.ts:543`; `config` is `site/lesto.content.ts`'s default export, `site/lesto.content.ts:89`).
   A plain `createMcpServer({ cwd, tools: "read" })` here would **throw at startup**
   (`resolveConfig(cwd)` → `No docks.config…`, `config.ts:135-138`), so threading `config` is
   mandatory, not optional. An agent building a Lesto app then pulls real docs as grounded
   context via `list_collections`/`get_collection_schema`/`get_entry`/`search_content` (built
   `server.ts:137-176`). The new `site → @lesto/content-mcp` edge is allowed (`site/` is an
   app, not kernel). The **docs** `llms.txt` reuses the Inc 3 renderer over the `docs`
   collection and is written to `site/public/llms-docs.txt` (NOT `site/llms.txt`, which Inc 6
   owns). Transport is stdio (what content-mcp ships, `server.ts:619`); a remote transport is
   deferred and would never be mounted by kernel.
   Acceptance: the `mcp:docs` entrypoint starts the content-mcp stdio server over `site/`'s
   collection **fed by the programmatic `config`** (a test asserts it mounts with **no
   `docks.config` on disk**, i.e. it does NOT throw); with `tools: "read"` it exposes only
   read tools (asserted via Inc 7's filter: `create_entry`/`update_entry` excluded from the
   advertised list **and** refused on a by-name dispatch); the **docs** index is written to
   `site/public/llms-docs.txt` and lists the docs pages, and **does not touch `site/llms.txt`**
   (no clobber, no `--check` drift against Inc 6); the new `site → @lesto/content-mcp`
   dependency introduces **no** `kernel → mcp` edge (grep-asserted); `site/` still
   builds/deploys; new `@lesto/cli` renderer paths at 100% (content-mcp rides the Docks
   baseline, not the 100% gate — except its read-filter branch, per Inc 7 / ADR 0035).

9. **PREVIEW `lesto eval` gate over `@lesto/ai`'s evals hook (discovery convention + lazy import + optional peerDep)** — `[preview]`
   Files: `packages/cli/src/eval.ts` (new — the `runEval` core + the **default on-disk
   loader** for the discovery convention), `packages/cli/src/bin.ts` (dispatch),
   `packages/cli/src/errors.ts` (any new `CLI_EVAL_*` codes — extend the closed
   `CliErrorCode` union *before* the throwing code compiles), `packages/cli/package.json`
   (declare `@lesto/ai` as an **optional `peerDependency`** — `peerDependencies` +
   `peerDependenciesMeta.optional`, mirroring `@lesto/content-core`, `cli/package.json:39-48`).
   **Discovery convention (must-fix):** evals live at **`app/evals/*.eval.ts`**, each module
   default-exporting one or more `Eval`s; `runEval` ships a **default on-disk loader** that
   globs that convention (the injected loader is for tests). Without a real where-do-evals-live
   convention, `lesto eval` has nothing to load and the gate is hollow.
   A `runEval(args, deps)` then gathers the discovered `Eval`s and runs them as a gate —
   discover → run serially → non-zero exit on failure — modeled on
   `scripts/coverage-gate.ts`. It composes `@lesto/ai`'s `createLlmJudge`/`guard`/`Eval`
   (`evals.ts:32,64,98`) and branches on the eval **code** (`EvalResult.code`,
   `evals.ts:27-28`; `AI_GUARDRAIL_BLOCKED`, `evals.ts:102`), never a message. **PREVIEW /
   opt-in, lazy import + optional peer:** marked PREVIEW in the command's doc + `--help`; an
   app declaring no evals (no `app/evals/`) is **not** gated (zero-exit, no auto-fail);
   `@lesto/ai` is resolved via a lazy `await import("@lesto/ai")` **inside** the `runEval`
   path, so it never enters `@lesto/cli`'s **eager** graph and `cli/package.json` gains **no**
   `@lesto/ai` entry in **`dependencies`** — but it **is** declared an **optional
   `peerDependency`** so the lazy edge carries a version constraint (not a bare, unconstrained
   `import()`). Ships **no** accuracy/benchmark claim.
   Acceptance: the **default on-disk loader discovers a fixture eval at `app/evals/*.eval.ts`**
   (not only an injected fake); `runEval` runs fixtures and exits non-zero iff an eval fails;
   a no-evals app (no `app/evals/`) exits zero; the runner branches on `EvalResult.code`/the
   guard code, not a message string; the command's doc + `--help` say PREVIEW; `@lesto/ai`
   is **absent from `cli/package.json` `dependencies` but present as an optional
   `peerDependency`**, and there is **no top-level `from "@lesto/ai"` import** (both
   grep-asserted); the model transport is injected so the LLM-judge path is tested with no
   network (the `@lesto/ai` fake-transport discipline); pure `runEval` + loader logic at
   100% (the dynamically-imported `@lesto/ai` is PREVIEW-exempt as it stands).

## Layering invariants (grep-asserted; folded into the bar block)

- The convention scan + renderers (Inc 1–3) are **pure** — no `fs`/`process`/network in
  the decision path; all I/O via the injected `GenerateIO` + readers (incl. the island
  glob-reader).
- `@lesto/cli` adds **no eager `@lesto/ai` dependency** — `@lesto/ai` appears **only** in
  the Phase 3 `lesto eval` command (Inc 9) and **only** via a lazy `await
  import("@lesto/ai")`, so `cli/package.json` lists no `@lesto/ai` entry in `dependencies`
  and there is no top-level `from "@lesto/ai"` in `@lesto/cli` (grep-asserted). It **is**
  declared an **optional `peerDependency`** (mirroring `@lesto/content-core`,
  `cli/package.json:39-48`) so the lazy edge carries a real version constraint — the
  invariant is "no `@lesto/ai` in `dependencies` + no top-level import," **not** "no
  `@lesto/ai` entry anywhere."
- The docs-MCP surface at `site/` registers **no write tool** — enforced by the
  `tools: "read"` filter added to `@lesto/content-mcp` (Inc 7), which excludes
  `create_entry`/`update_entry` from the advertised list **and refuses them on the dispatch
  path** (`TOOL_HANDLERS` at `server.ts:539` — the load-bearing lookup; a by-name call is
  rejected, asserted by a negative test in Inc 7 and Inc 8).
- **No `kernel → mcp` edge** is introduced by the new `site → @lesto/content-mcp`
  dependency or any docs transport — a remote transport (if ever built) is mounted by the
  app or a `@lesto/mcp-http`-style adapter, never kernel.
- **Distinct artifact paths:** the convention-scan **project** index is `site/llms.txt`
  (Inc 6); the **docs** index is `site/public/llms-docs.txt` (Inc 8). No increment writes
  both, so neither clobbers the other and `--check` never reports cross-generator drift.
- Generated artifacts (`AGENTS.md` managed region, both `llms.txt` files) are **byte-stable**;
  the `--check` step re-scans and diffs each against its own generator (the `routes.gen.ts`
  freshness discipline).

## Owned elsewhere (do not duplicate)

- **Route discovery** — `@lesto/router`'s `scanRoutes` over an injected `DirReader`
  (`scan.ts:97`, `index.ts:38-39`) and the `FileRouteKind`/`DiscoveredFile`/`FileRoute`
  descriptor shape (`file-routes.ts:80,119,137`). The scan **reads** these; it does not
  reimplement route parsing.
- **Collection inventory** — `@lesto/content-core`'s `getCollections` (re-exported
  `index.ts:66`, implemented `runtime.ts:204` — a zero-arg read of the compiled store). The
  scan reads it (degrading to "no collections" when content-core is absent or the store is
  unbuilt); it does not re-glob content.
- **Programmatic config resolution** — `@lesto/content-core`'s `resolveConfig(cwd,
  programmaticConfig)` (`config.ts:112-130`). Inc 7 threads this through `createMcpServer`'s
  new `config` option; it does not reimplement config loading.
- **The docs MCP server** — `@lesto/content-mcp`'s `createMcpServer`, `ToolBuilder`, read
  tools, and schema-validated dispatch (read-tool builders `server.ts:137-176`; dispatch
  `handleToolCall`/`TOOL_HANDLERS` `server.ts:504-515,521-541`; entrypoint `server.ts:543`).
  Inc 7 **adds a read-only filter (list + dispatch) + a programmatic-config entry** to it (a
  small, surgical change — not a rebuild) and Inc 8 **mounts** the filtered server; neither
  reimplements the server, the `ToolBuilder`, or argument validation.
- **The evals hook** — `@lesto/ai`'s `Eval`/`createLlmJudge`/`guard` and the
  `EvalResult.code`/`AI_GUARDRAIL_BLOCKED` contract (`evals.ts:27-28,32,64,98,102`). Inc 9
  **runs** these (via a lazy import behind an optional peerDep); it does not reimplement
  scoring, the LLM-judge, or the guard.
- **The generator I/O seam** — the ADR 0019 `GenerateIO` (`generate.ts:38-48`). Inc 1–6
  reuse it; they do not open a second filesystem path.

## Deferred (per ADR 0035 — not in this plan)

- **Remote/HTTP docs MCP transport** — gated on a hosted-docs-as-MCP consumer; mounted by
  app/adapter, never kernel.
- **`AGENTS.md` for nested/monorepo sub-apps** — gated on a real multi-app repo.
- **Semantic/RAG search in the docs MCP** — `content-search` has the machinery
  (`rag-fallback.ts`); gated on an MCP consumer that needs it, and ships PREVIEW (pulls in
  PREVIEW AI surface). The shipped `search_content` is substring (`server.ts:269-302`).
- **An evals dataset runner / score dashboard** — gated on an app with a curated eval
  dataset wanting trend tracking (ADR 0021's deferred convenience layer).
