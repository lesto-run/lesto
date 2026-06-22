# Agent-native schema operations & app contract — implementation plan

Derived from **ADR 0034**, which the 2026-06-22 independent review **split**:

- **Part A — committed, on this wave's gate:** MCP *resources* (route map, OpenAPI document,
  content collections, declared schema shape) + a `describe_app` tool — additive, read-only,
  100%-testable, **no dependency on ADR 0028, ADR 0031, or any sibling**. This is Increments
  **1-4** below.
- **Part B — deferred, OFF this wave's gate:** `propose_migration` (generate a file + diff/
  dry-run, never apply, identifier-validated) and `apply_migration` (governed, audited,
  fail-closed, never under the legacy gate), plus the doc edit that unlocks the
  "migrate from Claude" claim. **Blocked on ADR 0028 Phase 3a** (`requirePermission` /
  `MCP_FORBIDDEN` / `actorRoles` / actor-in-audit, retiring the binary `requireOperator`/`mode`)
  **and on the `userId → roles` store** — *neither exists in code today* (the live gate is the
  binary `requireOperator`, `tools.ts:254-264`; `McpAuditRecord` has no actor field,
  `tools.ts:77-95`). This is Increments **5-7**, each marked `[DEFERRED — off gate]` with its
  off-board prerequisites named. **They must not surface on the board as "ready" when Part A
  completes** — see *Board prerequisites*.

This plan details Part A in full and records Part B's deferred increments with their
prerequisites. Only Increments 1-4 are committed to this wave's gate.

**Packages:** `@lesto/mcp` (gains `buildResources` + `describe_app` in Part A; the migration
tools in deferred Part B), `@lesto/openapi` (reused for the contract document; the one new
pure, cycle-safe workspace dep; no change beyond consumption), `@lesto/migrate` (the
`Migrator`/`Schema` reused by Part B; no change in Part A), `@lesto/db` (the `defineTable`
values whose shape the schema resource surfaces in Part A; `quoteIdentifier` — used by Part B
identifier validation; already a dep, `packages/mcp/package.json:14`), `@lesto/authz`
(`policy.allows`, consumed by Part B via ADR 0028's injected gate), `@lesto/cli` (`lesto mcp`
wiring passes the new context fields in Part A), `examples/estate` (the dogfood / QA gate — its
`lesto mcp` server must **list** the resources).

> **The bar, every committed increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage
> on touched packages; `bun run ws:typecheck` + the serial coverage gate
> (`bun scripts/coverage-gate.ts`) green; coded errors; truthful doc comments; one
> conventional commit on `main`. **Coverage exemption is the *absence* of a `test:cov` script**
> (`scripts/coverage-gate.ts:35`) **plus the `content-` prefix skip (`:27`)** — not a "preview"
> field (none exists). `@lesto/mcp` declares `test:cov` → **everything here is gated at 100%**;
> a **new security-boundary branch in any content-prefixed package still needs explicit 100%**.
> Layering invariants, grep-asserted: `@lesto/mcp` gains **no** `@lesto/web` runtime coupling
> for resources (existing deps stay — `migrate`, `kernel`, `content-*`; `@lesto/openapi` is the
> one new pure dep); **no** `@lesto/auth` runtime dep (the principal seam is **injected** per
> ADR 0028, not imported); **no `kernel → mcp` edge** (any remote transport is the app's job,
> deferred — `@lesto/mcp` is stdio-only today); the (deferred) migration tools accept **no
> caller-supplied SQL string** AND validate every identifier (`/^[A-Za-z_][A-Za-z0-9_]*$/` or
> `@lesto/db`'s `quoteIdentifier`, `ddl.ts:122,135`) and constrain `type` to a closed enum;
> deny-by-default — both migration verbs fail-closed on `policy.allows`, no silent fail-open,
> and `apply_migration` is **absent from `buildTools` without an actor resolver**.

## Part A increments (committed — this wave's gate)

1. **Add an MCP `resources` capability + `buildResources` skeleton** — `[keystone]`
   Files: `packages/mcp/src/resources.ts` (new), `packages/mcp/src/index.ts`,
   `packages/mcp/src/server.ts`.
   Introduce `buildResources(context: LestoMcpContext): LestoResource[]` symmetric with
   `buildTools` (`tools.ts:336`) — each resource a pure `{ uri, name, mimeType, read() }`
   descriptor — starting with the **route map** resource (`context.routes`, already on the
   context, `tools.ts:103`). Advertise `resources: {}` in the server capabilities (today only
   `tools: {}`, `server.ts:58`). **Coverage discipline (must-fix from the layering review):**
   the `resources/list`+`resources/read` registration adds a select/dispatch branch — it is
   **not** the 1-line passthrough today's `server.ts` is. Keep **all** select/dispatch logic in
   the covered `resources.ts`; `server.ts` stays a true one-handler-per-capability passthrough,
   grep-asserted to add **no new branch** (do **not** rely on the whole-file `server.ts`
   coverage exclusion to hide logic).
   Acceptance: `buildResources` returns the route-map resource with a stable `uri`
   (e.g. `lesto://routes`) and `application/json` mimeType; its `read()` returns
   `context.routes`; `server.ts` advertises the `resources` capability and adds no new branch
   (grep-asserted); resource list order is stable and asserted; typecheck + serial coverage
   gate green; 100%.

2. **Add the OpenAPI, collections, and schema-shape resources (graceful-degrade)** —
   `[reuses Inc 1]`
   Files: `packages/mcp/src/resources.ts`, `packages/mcp/src/tools.ts`.
   Add three more descriptors to `buildResources`: **OpenAPI** (`toOpenApi(context.routes,
   info)` — reusing `@lesto/openapi`, `openapi.ts:130`; `@lesto/openapi` added as a workspace
   dep — pure, cycle-safe), **content collections** (`getCollections()`, as
   `list_content_collections` already reads, `tools.ts:418-435`), and **schema shape** (the
   cheaply-available shape per ADR 0034's *schema-shape gap*: known migration versions + each
   declared `defineTable`'s column names/types, surfaced from a new optional `context.schema`
   field — never inventing reflection). **Graceful degradation (must-fix):** `getCollections()`
   is reached via `requireContent(context)`, which **throws `MCP_CONTENT_PACKAGES_MISSING`**
   when `context.loadContent` is absent (`tools.ts:178-181`); the collections resource must
   instead yield an **empty-but-valid** value (mirroring the absent-`context.schema` →
   empty-schema behavior), **never** a throw. The OpenAPI resource description carries the
   route-shape-only limitation verbatim (`openapi.ts:125-128`) **and** notes it is the
   **unfiltered** route set (no `internal`-route exclusion vs the CLI's `isInternal` path,
   `openapi.ts:33-38`). Add an optional `openApiInfo` field to `LestoMcpContext` defaulting to
   `{ title: "Lesto API", version: "0.0.0" }` (`cli/src/openapi.ts:32`).
   Acceptance: all four resources present with stable URIs and JSON mimeType; the OpenAPI
   `read()` equals `toOpenApi(routes, info)`; the collections `read()` equals `getCollections()`
   shape **when content peers are wired** and an **empty-but-valid value when they are absent
   (no throw)** — asserted both ways; the schema resource surfaces only declared
   versions/columns, its description states "route-shape / declared-shape only, not full
   reflection," and absent `context.schema` yields a documented empty-but-valid resource;
   typecheck + serial coverage gate green; 100%.

3. **Add the `describe_app` tool (graceful-degrade)** — `[the binding]`
   Files: `packages/mcp/src/tools.ts`.
   Add a non-destructive `describe_app` tool returning `{ routes, openapi, collections,
   schema }` as one payload — the same contract as the resources, for MCP clients without
   resource support. `destructive: false`; runs in read-only mode (no `requireOperator`);
   appended to the `buildTools` return array (`tools.ts:552-563`) after the content read
   tools, before the write tools, preserving stable order. Pure handler, tested directly;
   reuses the resource builders so the payload can never drift from the resources.
   **Graceful degradation (must-fix):** on a content-less app (`context.loadContent` absent),
   the `collections` key is the same empty-but-valid value as the collections resource —
   `describe_app` must **dispatch without refusal** on an app that has routes/openapi/schema
   but no content peers (the old acceptance was unmeetable because `requireContent` throws).
   Acceptance: `describe_app` appears in `buildTools` output at the documented position;
   `destructive` is `false` and it dispatches in read-only mode without refusal **including on
   a content-less app** (asserted — `collections` is empty-but-valid, not a thrown
   `MCP_CONTENT_PACKAGES_MISSING`); its payload's four keys equal the corresponding resources'
   `read()` outputs (drift asserted); the `MCP_*` error union is unchanged (no new refusal
   path); typecheck + serial coverage gate green; 100%.

4. **Wire resources + `describe_app` through `lesto mcp` and dogfood in estate** —
   `[per gallery-as-QA-gate]`
   Files: `packages/cli/src/mcp.ts`, `examples/estate/*` (app config / mcp wiring).
   Pass `openApiInfo` (from the app's meta when present) and `schema` (the app's declared
   migration versions + `defineTable` columns) into the `LestoMcpContext` `runMcp` builds
   (`cli/src/mcp.ts:75-104`) — both optional, both pure, no new live import in the injected
   core. Confirm `examples/estate`'s `lesto mcp` server **lists** the four resources and
   `describe_app` over stdio. (`lesto mcp` runs through `runMcp`, **not** estate's bespoke
   `dev.ts`, so this is the legitimate serving check.)
   Acceptance: `runMcp`'s built context carries `openApiInfo` and `schema` (asserted in the
   existing fake-`loadApp` test, `cli/src/mcp.ts` test); estate's `lesto mcp` **lists** the
   four resources + `describe_app` over stdio; typecheck + serial coverage gate green; 100%.
   *(Per the review nit: the over-broad "estate builds/deploys" clause is dropped — read-only
   resources are orthogonal to build/deploy; the meaningful gate is the resource listing.)*

## Part B increments (DEFERRED — off this wave's gate, blocked on ADR 0028)

> **None of Increments 5-7 are on this wave's gate.** Each is blocked on off-board ADR 0028
> prerequisites (see *Board prerequisites*) and must be tracked in a **separate
> ADR-0028-blocked epic**, not released by this wave's gate. The old Inc 5 (a "consume
> `MCP_FORBIDDEN`/`requirePermission`" placeholder) is **merged into Inc 5b** per the review:
> with the prerequisites absent it was a no-op placeholder that reads as "ready, 30 min" but
> cannot start.

5b. **[DEFERRED — ADR 0028 Phase 3a + roles store] Add `propose_migration` (non-destructive,
   governed, identifier-validated)** — `[order-critical]`
   Files: `packages/mcp/src/tools.ts`, `packages/mcp/src/migration-tool.ts` (new).
   *Prerequisites (off-board): ADR 0028 Phase 3a — `requirePermission(context, permission)`
   over `policy.allows`, `actor`/`actorRoles` on `LestoMcpContext`, the `MCP_FORBIDDEN` coded
   error, actor-in-`McpAuditRecord` — retiring `requireOperator`/`mode`; AND the `userId →
   roles` store. **Neither exists in code today.*** Add a `propose_migration` tool with a
   **bounded, typed** change vocabulary of **only** `add_column`/`add_index`/`drop_table` —
   mapping onto real `Schema` editor methods: `add_column → Schema.addColumn` (`schema.ts:29`),
   `add_index → Schema.addIndex` (`schema.ts:52`), `drop_table → Schema.dropTable`
   (`schema.ts:24`). **`create_table` is CUT** (must-fix): `createTableSql` needs a full
   `@lesto/db` `Table` (per-column name/type/nullable/pk/unique/default/FK,
   `db/src/table.ts:36-83`, `ddl.ts:90-136`) — a column-design surface that contradicts the
   "not a schema-design DSL" non-goal. Table creation stays CLI/code-only. The tool generates a
   version-stamped (`YYYYMMDDHHMMSS` — the bare-timestamp portion of `versionStamp`/the
   `${version}_${name.snake}` on-disk scheme, `generate.ts:794-795,765`) `MigrationEntry`-shaped
   file **and** a rendered DDL diff/dry-run, touching **no** live database; it never calls
   `Migrator.migrate()`. Gated by `requirePermission(context, "schema:propose")`.
   `destructive: false`.
   **Security invariant (rewritten must-fix — identifier validation + closed type enum):**
   `Schema`'s editors interpolate identifiers **raw** (`schema.ts:25,45,63`) with no quoting,
   so "no raw-SQL field" is **not** sufficient. Every agent-supplied identifier (table, column,
   index name) is validated against `/^[A-Za-z_][A-Za-z0-9_]*$/` — or routed through `@lesto/db`'s
   `quoteIdentifier` (`ddl.ts:122,135`) — before it reaches any DDL string, AND the column
   `type` is a value from a **CLOSED enum** of known SQL types, never a free string. This holds
   independent of the ADR 0028 gate (it is an injection defense).
   Acceptance: each kept change kind renders the exact DDL its `Schema` source would emit
   (asserted against `schema.ts` output); the returned file is a valid `MigrationEntry` shape
   with a sortable version; the live DB is never touched (no `migrate()` call — asserted with a
   spy db); a caller lacking `schema:propose` gets `MCP_FORBIDDEN`; **identifier-/type-injection
   cases are rejected** — e.g. `type: "INTEGER); DROP TABLE users;--"` and
   `table: "users; DELETE FROM sessions;--"` both refuse (asserted); the typed input has **no**
   raw-SQL field, every identifier passes the validator/`quoteIdentifier`, and `type` is the
   enum (grep-/assert-checked); `create_table` is **absent** from the vocabulary (asserted);
   typecheck + serial coverage gate green; 100%.

6. **[DEFERRED — Inc 5b + roles store] Add `apply_migration` (governed, audited, never under
   the legacy gate)** — `[order-critical]`
   Files: `packages/mcp/src/tools.ts`, `packages/mcp/src/migration-tool.ts`.
   *Prerequisites (off-board): Inc 5b; ADR 0028 Phase 3a actor-in-audit; the ADR 0028 `userId →
   roles` store; **and, for the span acceptance only, ADR 0031 Phase 1 (the `@lesto/mcp`
   dispatch tracer seam)** — itself unbuilt.* Add `apply_migration`: `destructive: true`, gated
   by `requirePermission(context, "schema:apply")` (a distinct, higher-privilege permission),
   running the already-proposed `MigrationEntry` through `Migrator.migrate()` (`migrator.ts:143`,
   already transactional/idempotent) and recording the **resolved actor** in the audit record
   (`McpAuditRecord` extended with `{ actor }` by ADR 0028 Phase 3a, `tools.ts:77-95`).
   **NEVER under the legacy gate (hard, tested invariant — must-fix):** `apply_migration` must
   **not** register or run under the binary `requireOperator`/operator-mode (`tools.ts:254-264`)
   — operator mode is a process-wide flag with no actor, and `McpAuditRecord` has no actor field,
   so an interim operator-mode apply would ship an **unattributed governed apply**. There is
   **no** interim operator-mode path for any destructive schema verb. Registration is
   conditioned on a real actor resolver + actor-bearing audit; with no resolver wired the tool
   **fails closed — it is absent from `buildTools` entirely**. Emits an **audit record now**;
   trace-span attachment lands **when ADR 0031 Phase 1's dispatch tracer seam exists**.
   Acceptance: apply runs `Migrator.migrate()` and returns the applied version(s); a caller
   lacking `schema:apply` gets `MCP_FORBIDDEN`; an apply with no resolved actor is refused (not
   forged); **with no actor resolver, `apply_migration` is absent from `buildTools` output
   (negative test)**; the audit record carries the actor; the audit record is emitted
   unconditionally, and once ADR 0031 Phase 1's seam exists the apply span attaches to the
   existing `traceId` (asserted only behind that seam); typecheck + serial coverage gate green;
   100%.

7. **[DEFERRED — Inc 6 ships] Unlock the "migrate from Claude" claim (doc follow-up)** —
   `[docs]`
   Files: `docs/devrel/wedge-demo-script.md`, `docs/brand/messaging.md`.
   *Prerequisite: Inc 6 shipped at the full bar.* Replace the guardrails that forbid the beat:
   `wedge-demo-script.md:95-98` ("Do NOT stage a 'migrate the schema from Claude' beat") becomes
   an *added* beat, and `messaging.md:78` drops "Schema migrations are NOT an MCP tool yet."
   Per the claims guardrail, this edit happens **only after** the tool ships — never ahead of
   it. Because Inc 6 is deep-gated on ADR 0028's unbuilt roles store, this is the **least likely
   of the wave to ship**.
   Acceptance: both docs reflect the shipped `propose_migration`/`apply_migration` tools; the
   new wedge beat shows the dry-run/diff before apply (the safety story); no claim exceeds
   shipped reality (governed, attributable, dry-run-first, identifier-validated); the messaging
   matrix entry matches the engineering bar; no over-promise. (Doc-only; no coverage gate, but
   the claims guardrail is the acceptance bar.)

## Board prerequisites (off-board blockers for Part B)

Part B (Inc 5b-7) must **not** surface as "ready" when Part A (Inc 1-4) completes. Track these
as explicit tracking tasks and make every Part B card **blocked by** them:

- `ADR 0028 Phase 1 — principal model` (unbuilt)
- `userId → roles store` (unbuilt)
- `ADR 0028 Phase 3a — MCP governance` (`requirePermission` / `MCP_FORBIDDEN` / `actorRoles` /
  actor-in-audit; unbuilt)

Best: move Part B into a **separate ADR-0028-blocked epic** not released by this wave's gate.

## Layering invariants (grep-asserted; folded into the bar block above)

- `@lesto/mcp` gains **no** `@lesto/web` runtime coupling for the contract resources; the one
  new dep is `@lesto/openapi` (pure, cycle-safe). The existing `migrate`/`kernel`/`content-*`
  deps are unchanged. `@lesto/mcp` is **stdio-only** today (no HTTP/resources before Part A).
- **No `kernel → mcp` edge.** The resources/tools are served by the app's `lesto mcp` (above
  both); any remote transport is deferred (ADR 0028 Phase 3b).
- The auth/principal seam is **injected** (`actor`/`actorRoles` on `LestoMcpContext`), never an
  `@lesto/auth` runtime import — so external-IdP vs first-party-AS is just which impl is wired.
- **No arbitrary DDL over MCP — and identifier-safe (Part B).** No caller-supplied SQL string
  reaches `Schema.execute` (`schema.ts:67`), AND every agent-supplied identifier passes
  `/^[A-Za-z_][A-Za-z0-9_]*$/` or `quoteIdentifier` (`ddl.ts:122,135`) and `type` is a
  closed-enum value, **before** any DDL string — because `schema.ts` interpolates raw
  (`schema.ts:25,45,63`) and `createTableSql` renders the type raw (`ddl.ts:87`). The
  grep-/assert is *"no raw-SQL input field; every identifier validated/quoted; `type` is the
  enum"* — not "no `execute` call." `create_table` is **not** an MCP verb.
- **Deny-by-default + no legacy gate for apply (Part B).** Both migration verbs fail-closed on
  `policy.allows`; `apply_migration` fails closed on a missing resolver (absent from
  `buildTools`) and **never** registers under the legacy `requireOperator`/operator-mode.

## Coverage exemption — the real rule (correcting the wave's premise)

The serial coverage gate keys on the **presence of a `test:cov` script**
(`scripts/coverage-gate.ts:35`) plus the **`content-` prefix skip** (`:27`) — **not** a
"preview" field (none exists in any `package.json`). Among the AI packages, only `@lesto/ai` is
exempt (it declares no `test:cov`); `@lesto/ui-generate` **declares** `test:cov` → it **is**
gated at 100%. `@lesto/mcp` declares `test:cov` → **all of Part A is gated at 100%.** A **new
security-boundary branch in a content-prefixed package still requires explicit 100%** despite
the prefix skip — relevant if any Part B helper ever lands in a content-* package.

## Owned elsewhere (do not duplicate)

- **The principal model (`actor`/`actorRoles` on `LestoMcpContext`, `requireOperator`→
  `requirePermission`, `MCP_FORBIDDEN`, `mode` retirement, actor-in-audit) AND the `userId →
  roles` store** — owned by **ADR 0028 Phase 3a / the operator-control-plane plan**. **Unbuilt
  today** (live gate is the binary `requireOperator`, `tools.ts:254-264`; `McpAuditRecord` has
  no `actor`, `tools.ts:77-95`). Part B *injects* and *consumes* it (Inc 5b-6) and inherits the
  roles-store gate; it does **not** reimplement the resolver, the gate, or the roles store.
- **The OpenAPI document generation** — owned by `@lesto/openapi` (`toOpenApi`, `openapi.ts:130`).
  Part A *consumes* it for the contract resource; it adds **no** second generator and does not
  extend it to body schemas (that tier is its own post-1.0 work).
- **The migrator's transactionality / ordering / advisory lock** — owned by `@lesto/migrate`
  (`migrator.ts:143`). `apply_migration` *calls* `migrate()`; it does not re-implement apply
  semantics.
- **The unified trace + exporter** — owned by **ADR 0031** + `@lesto/observability` /
  `@lesto/web`. The migration spans *attach* to the existing trace (when 0031's seam exists);
  this plan adds no parallel telemetry pipeline.

## Deferred (per ADR 0034 — not in this plan)

- **All of Part B** — a separate ADR-0028-blocked epic, off this wave's gate (above).
- **Full schema introspection** (normalized table/column/type/constraint/FK/index model) —
  gated on the migration tools needing a precise diff and on ADR 0033 wanting a richer schema
  resource.
- **OpenAPI request/response body schemas** (Zod-extracted) — gated on the `@lesto/openapi`
  extraction tier; the resource serves the route-shape skeleton until then.
- **`create_table` over MCP** — cut (column-design DSL); revisit only with a bounded design +
  real demand.
- **Governed `rollback`/`down` over MCP** — gated on a real "undo the last agent-applied
  migration" demand + Part B.2 audit.
- **Remote/HTTP MCP transport for migration tools** — `@lesto/mcp` is stdio-only; remote
  transport inherits ADR 0028 Phase 3b's OAuth-RS prerequisites and the no-`kernel → mcp`-cycle
  rule.
- **Migration approval / step-up before apply** — gated on the step-up primitive ADR 0028
  defers.
