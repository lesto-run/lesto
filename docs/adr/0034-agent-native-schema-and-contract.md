# ADR 0034 — Agent-native schema operations & app contract (MCP resources now; governed migration tools deferred)

- **Status:** Accepted (ratified 2026-06-23). This ADR is **split** after the
  2026-06-22 independent review (see *Reviews*). **Part A — committed build-now:** read-only
  MCP *resources* + a `describe_app` tool (the app's route map, OpenAPI document, schema
  shape, and content collections handed to an agent without tool round-trips). Additive,
  non-destructive, cycle-safe (`@lesto/openapi` is pure), fully testable as pure functions —
  it is on **this wave's gate**. **Part B — deferred, off this wave's gate:** the governed
  migration tools (`propose_migration` / `apply_migration`) and the doc edits that unlock the
  "migrate from Claude" claim. Part B is **designed here but explicitly blocked on ADR 0028
  Phase 3a** (the MCP-governance increment that puts `requirePermission` / `MCP_FORBIDDEN` /
  `actorRoles` on `LestoMcpContext`, retires the binary `requireOperator`/`mode` gate, and
  adds the **actor** to the audit record) **and on a real `userId → roles` store** — *neither
  of which exists in code today* (the live MCP gate is the binary `requireOperator` over a
  `mode` flag, `tools.ts:254-264`; `McpAuditRecord` has **no** actor field, `tools.ts:77-95`).
  Part B is **removed from this wave's gate and tracked as a separate ADR-0028-blocked epic**,
  so it cannot surface on the board as "ready" while un-startable. Part A does **not** depend on
  ADR 0028, ADR 0031's spans, or any other sibling — it ships on its own.
  Revised three times 2026-06-22 — an internal adversarial pass that cut scope, a second
  correctness/sequencing pass (phantom-API fix + Phase-3a re-pointing), and the third
  independent red-team/chief-architect pass recorded under *Reviews*.
- **Date:** 2026-06-22
- **Deciders:** tech lead + owner (ratification pending)
- **Builds on / touches:** ADR 0028 (operator control plane — **Accepted, but Phase 3a/3b are
  unbuilt**: it owns the principal model + `policy.allows` gate + the actor-in-audit pattern
  Part B governs migrations with, and the `userId → roles` store Part B requires), ADR 0018
  (relational data layer — the `@lesto/db` schema values migrations render DDL from, incl.
  `createTableSql` — `packages/db/src/ddl.ts:132`, the `create_table` renderer **if** that verb
  is kept; see the create_table decision), ADR 0023 (file-based routing — the route map Part A
  exposes as a resource). Composes `@lesto/mcp` (`buildTools` — `tools.ts:336`; `dispatch` —
  `tools.ts:608`; `LestoMcpContext` — `tools.ts:99`; the `McpAuditSink` — `tools.ts:96`),
  `@lesto/migrate` (`Migrator` — `migrator.ts:143,195`; `Schema` — `schema.ts:18`,
  `dropTable`/`addColumn`/`addIndex`/`execute`; `MigrationEntry` — `migrator.ts:13`), `@lesto/db`
  (`createTableSql` — `ddl.ts:132`; `quoteIdentifier` — `identifier.ts`; already a dep,
  `packages/mcp/package.json:14`), `@lesto/authz` (`Policy.allows`), and the `lesto mcp` CLI
  (`packages/cli/src/mcp.ts`). Sibling wave: **ADR 0031** (agent-observable runtime — a shared
  span-name vocabulary the *later* trace-attachment phases agree on; **Part A does not depend on
  it**), **ADR 0032** (dev-loop control plane), **ADR 0033** (in-preview AI surface — consumes
  the source/contract resources Part A exposes), **ADR 0035** (agent legibility & AI evals — the
  migration tools are an eval target there; no quality claim without those evals).

## Context

This wave's honest reframing (per the 2026-06-22 review): the two genuinely shippable,
gate-free, high-leverage cuts are **ADR 0035 Phase 1** (AGENTS.md/llms.txt) and **this ADR's
Part A** (MCP resources + `describe_app`). They are the cheapest, most broadly-credible
"agent-native" proofs and should land **first**. The "0031 is the keystone" framing
over-states a sequencing dependency: Part A needs nothing from 0031's spans — only the later
trace-attachment work does.

Part A closes a real, present gap: an agent can *talk about* a Lesto app but cannot *see its
shape* without round-tripping tools. **Part B designs the path to** the larger
"migrate-the-schema-from-Claude" gap — but that close lands only at the **end** of a
multi-step chain blocked on ADR 0028's unbuilt roles store, and is therefore the **least
likely of this wave to ship**. The demo guardrails forbidding the migrate beat stay exactly
as-is until `apply_migration` actually ships:

- `docs/devrel/wedge-demo-script.md:95-98` — *"Do NOT stage a 'migrate the schema from
  Claude' beat. There is no schema/migration MCP tool yet… (If/when a migration tool
  ships, add a beat — not before.)"*
- `docs/brand/messaging.md:78` — *"Schema migrations are NOT an MCP tool yet (CLI/code
  only) — do not imply 'migrate the schema from Claude.'"*

The raw materials exist and are good but are not bound to MCP:

- **The MCP control plane is real but exposes only *tools*, never *resources*.** The
  server advertises `capabilities: { tools: {} }` (`packages/mcp/src/server.ts:58`) and
  `buildTools` (`tools.ts:336`) returns nine tools (the return array at `tools.ts:552-563`):
  `list_routes`, `handle_request`, `generate_ui`, and content read/write. An agent that
  wants the app's *shape* must round-trip `list_routes` (and has no way at all to see the
  schema or the OpenAPI document). MCP's **resources** primitive is the right shape for
  "here is the app's contract" — read-once context, not a tool call — and it is unused.
  Note: `@lesto/mcp` is **stdio-only** today (no HTTP transport, and no MCP `resources`
  capability) — Part A adds the resources capability over the existing stdio transport.
- **The OpenAPI generator exists and is pure, but is CLI-only.** `toOpenApi(routes, info,
  options)` (`packages/openapi/src/openapi.ts:130`) builds an OpenAPI 3.1 document from the
  route list; `lesto openapi` writes it to disk (`packages/cli/src/openapi.ts`). No MCP
  surface serves it. (Honest limitation, already documented: it is the **route-shape
  skeleton** — request/response *body schemas* are post-1.0, `openapi.ts:125-128`, and the
  CLI prints that caveat, `cli/src/openapi.ts:110`.) `@lesto/openapi` is **pure and
  cycle-safe** (verified: `@lesto/mcp` does not dep it today — it is the one new pure dep
  Part A adds).
- **The migrator is real, transactional, and dialect-aware — but has no MCP, and no CLI
  apply command.** `Migrator.migrate()` runs pending `MigrationEntry`s in version order under
  a cross-process advisory lock (`packages/migrate/src/migrator.ts:143`); `Schema` is the DDL
  editor (`schema.ts:18`); `MigrationEntry = { version, migration: { up, down? } }`
  (`migrator.ts:13`). Migrations run **at kernel boot** against `config.db`
  (`packages/kernel/src/kernel.ts:244-248`). The only authoring path is `lesto g migration`,
  which emits a migration *file* (`cli/src/generate.ts:760-767`; version scheme
  `YYYYMMDDHHMMSS` at `versionStamp`, `generate.ts:794-795`) — there is **no** `lesto migrate`
  apply command, and certainly no MCP tool.
- **The `@lesto/migrate` DDL editor interpolates identifiers RAW (the real security line).**
  `Schema.dropTable` runs `` `DROP TABLE ${name}` `` (`schema.ts:25`), `addColumn` runs
  `` `ALTER TABLE ${table} ADD COLUMN ${name} ${type}${modifiers}` `` (`schema.ts:45`),
  `addIndex` runs `` `CREATE ${unique}INDEX ${name} ON ${table} (${cols.join(", ")})` ``
  (`schema.ts:63`) — **no quoting, no validation**. `@lesto/db`'s `createTableSql` quotes the
  *identifier* via `quoteIdentifier` (`ddl.ts:122,135`) but renders the column **type** raw
  (`sqlType` returns `spec.sqlType` verbatim, `ddl.ts:84-87`). So routing typed agent input
  (`{ table, column, type }`) straight onto these methods is a **DDL-injection vector** that
  never touches `Schema.execute` — the original "no raw-SQL field" invariant defended the
  wrong line. Part B's invariant is rewritten accordingly (below).
- **The governance model Part B must reuse exists only on paper (ADR 0028).**
  `policy.allows(roles, permission)` is the deny-by-default authz oracle
  (`packages/authz/src/policy.ts`); the MCP audit sink records every dispatch (`McpAuditRecord`
  — `tools.ts:77-95`; `dispatch` at `tools.ts:608`). But MCP's *current* gate is the coarse
  binary `requireOperator` over a `mode` flag (`tools.ts:254-264`, `modeOf` at
  `tools.ts:187-189`), with **no caller identity** and an audit that records the *tool*, not
  *who* (`McpAuditRecord` is `{ tool, inputHash, outcome, durationMs }`, `tools.ts:77-95` — no
  `actor`). That is exactly what ADR 0028 Phase 3a re-scopes onto the principal model — **and
  it is unbuilt.**

What this is **not** trying to be: it is **not** a schema-design DSL, **not** auto-migration /
drift-detection, and **not** "the agent edits prod tables." The hard, demanded thing is
narrow: let an agent **READ the app's shape** (Part A, now) and — eventually, behind ADR
0028's governance — **SAFELY EVOLVE its schema** through a propose-then-apply gate that is
fail-closed, dry-run-first, attributable, and identifier-validated (Part B, deferred).

## The keystone: the contract is data, the migration is a deferred two-step gated verb

One named idea: **an agent gets the app's contract as a *resource* (read, no round-trip),
and — once governance exists — changes the schema only through a *propose → apply* gate where
propose is non-destructive and apply is governed and attributable.** The two halves compose,
but only the first is committed now:

| Concern | Resolution | Status |
|---|---|---|
| **Legibility** | The route map, OpenAPI document, schema shape, and content collections are MCP **resources** — an agent reads the contract once, before it acts, instead of inferring it from tool calls. `describe_app` is the one-call tool form for clients without resource support, and **gracefully degrades** when content peers are absent. | **Committed (Part A)** |
| **Safe evolution** | A migration is never a single destructive tool. `propose_migration` *generates a file and returns a diff/dry-run* with **identifier-validated, type-allowlisted** input — it touches **no** live schema. `apply_migration` is the only mutating step: gated, audited, attributable, and refusing to register without an actor resolver. | **Deferred (Part B), blocked on ADR 0028 Phase 3a + roles store** |
| **Governance** | Both mutating verbs route through ADR 0028's `policy.allows(actorRoles, …)` + the actor-in-audit record. There is **no** un-governed path to schema change over MCP, and **no interim `requireOperator`/operator-mode path** for a destructive apply. | **Deferred (Part B)** |

## Decision

Bind `@lesto/mcp` to the app's contract **now** (Part A), and design the migrator binding
behind ADR 0028's principal gate as a **deferred, separately-tracked epic** (Part B).

### Part A — build now, on this wave's gate: MCP resources + `describe_app` (read-only)

Three integration points, all additive and non-destructive, on the right side of the
existing layering, with **no dependency on ADR 0028 or ADR 0031**:

1. **Advertise and serve MCP resources (`@lesto/mcp`).** The server today declares only
   `capabilities: { tools: {} }` (`server.ts:58`). Add a `resources` capability and a
   `buildResources(context)` function — symmetric with `buildTools` (`tools.ts:336`) —
   returning pure `{ uri, name, mimeType, read() }` descriptors for: the **route map**
   (`context.routes`, already on `LestoMcpContext`, `tools.ts:103`), the **OpenAPI document**
   (`toOpenApi(context.routes, info)` — reusing `@lesto/openapi`, `openapi.ts:130`, no new
   generator), the **content collections** (`getCollections()` from `@lesto/content-core`, as
   `list_content_collections` already does, `tools.ts:418-435`), and the **declared schema
   shape** (the app's known `MigrationEntry` versions + `@lesto/db` `defineTable` column
   names/types surfaced as a read-only descriptor — see *the schema-shape gap*). The `read()`
   handlers are pure over the context and tested directly. **Coverage discipline (per the
   layering review):** the `resources/list` + `resources/read` registration in `server.ts` is
   **not** the 1-line passthrough today's `server.ts` is — it adds a dispatch/select branch.
   Either keep `server.ts` a true one-handler-per-capability passthrough with **all** select
   /dispatch logic in the covered `resources.ts`/`tools.ts` (grep-assert: `server.ts` adds no
   new branch), **or** narrow the `packages/mcp/vitest.config.ts` exclusion to the specific
   un-coverable wire lines. The plan picks the first (logic-in-covered-module) and asserts it.

2. **A `describe_app` tool (`@lesto/mcp`).** One non-destructive tool returning the same
   contract as a single payload `{ routes, openapi, collections, schema }`, for MCP clients
   that don't yet support resources. `destructive: false`; runs in read-only mode; added to
   the `buildTools` return array (`tools.ts:552-563`) after the read tools, before the write
   tools (stable order). Pure handler, tested directly. **Graceful degradation is mandatory
   (must-fix):** the collections half goes through `requireContent(context)`, which **throws
   `MCP_CONTENT_PACKAGES_MISSING`** when `context.loadContent` is absent (`tools.ts:178-181`)
   — i.e. for **any** app without `@lesto/content-*`. So `describe_app` (and the collections
   resource) must yield an **empty-but-valid** `collections` value on a content-less app, the
   same way an absent `context.schema` yields an empty schema resource — **never** a hard
   refusal. A perfectly contract-readable app (routes/openapi/schema present, content absent)
   must still describe.

3. **The OpenAPI `info` seam (`@lesto/mcp`).** `toOpenApi` requires an `OpenApiInfo`
   (`openapi.ts:42-49`); the resource/tool default to `{ title: "Lesto API", version:
   "0.0.0" }` (mirroring `cli/src/openapi.ts:32`) and accept an injected override on
   `LestoMcpContext`, so no new app-config coupling. Two standing limitations are carried
   **verbatim** into the resource description so an agent never mistakes absence for a defect:
   (a) the route-shape-only caveat (no body schemas, `openapi.ts:125-128`); and (b) — per the
   review nit — the resource serves the **unfiltered** route set: `context.routes` is
   `{ method, pattern }[]` (`tools.ts:103`) with **no** `internal` flag, whereas
   `toOpenApi`'s `isInternal` predicate (`openapi.ts:33-38`) can drop internal/admin routes
   in the CLI path. The resource therefore documents every route (no new leak —
   `list_routes` already exposes all routes — but it differs from the CLI's filtered
   document); state this in one sentence, or thread an `isInternal` predicate if the app
   supplies one.

**The schema-shape gap (stated, not hidden).** `@lesto/db`/`@lesto/migrate` model a schema as
*executable* `MigrationEntry`s + `defineTable` values, not as an introspectable JSON shape —
there is no `schema.describe()` today (`migrate/src/index.ts`, `db/src/table.ts`). Part A
surfaces what is *cheaply* available without inventing a reflection layer: the list of known
migration **versions** + each `defineTable`'s column names/types where the app hands them to
the context (an absent `context.schema` → an empty-but-valid resource, no throw). A full
normalized schema-introspection model is recorded under *Deferred*, gated on the migration
tools that actually need it. **No PREVIEW claim of "complete schema reflection."**

Scope discipline: Part A is additive, introduces no new runtime and no new package edge
(`@lesto/mcp` already deps `@lesto/migrate` `package.json:17`, `@lesto/kernel` `:16`;
`@lesto/openapi` is the one new workspace dep, type-and-value, pure and cycle-safe), and is
100%-testable as pure functions over a `LestoMcpContext`.

### Part B — designed here, DEFERRED off this gate, blocked on ADR 0028 Phase 3a + the roles store

Part B is **not** on this wave's gate and **not** a startable board chain until its ADR-0028
prerequisites land. It is recorded here so the design is reviewable and so the board can track
the off-board blockers (see *Board prerequisites*). The hard prerequisites:

- **ADR 0028 Phase 3a** — `requirePermission(context, permission)` over `policy.allows`,
  `actor`/`actorRoles` on `LestoMcpContext`, the `MCP_FORBIDDEN` coded error, and the **actor
  added to `McpAuditRecord`** — *retiring* the binary `requireOperator`/`mode` gate. **None of
  this exists in code today** (verified: `tools.ts:254-264` is the binary gate;
  `McpAuditRecord` `tools.ts:77-95` has no `actor`).
- **A real `userId → roles` store** — a non-interactive MCP agent has no `?role=` knob;
  remote/agent authz is meaningless without persistent roles. ADR 0028 Phase 3a is itself
  gated on this store, so Part B **inherits** that gate.

#### Part B.1 — `propose_migration` (non-destructive, governed, identifier-validated)

1. **Generate, never apply.** The tool takes a bounded, typed change and returns a generated
   `MigrationEntry`-shaped **file** (version-stamped `YYYYMMDDHHMMSS`, the bare-timestamp
   portion of the on-disk `${version}_${name.snake}` scheme — `generate.ts:794-795,765`)
   **plus a rendered DDL diff/dry-run** — the SQL `Schema.addColumn` (`schema.ts:29`) /
   `addIndex` (`schema.ts:52`) / `dropTable` (`schema.ts:24`) *would* emit, computed without
   touching the live database. It writes the file to `app/migrations/` (the convention,
   `generate.ts:765`) or returns it for the client to write; it **never** calls
   `Migrator.migrate()`. `destructive: false` for the *schema* (it writes a source file, like
   `lesto g`), but governed all the same.
2. **The security invariant is identifier validation + a closed type enum (rewritten
   must-fix).** The original "no caller-supplied SQL string reaches `execute`" invariant is
   **necessary but not sufficient** and gives false assurance: the bounded typed *fields* are
   themselves un-parameterized injection vectors, because `Schema`'s editor methods
   interpolate `table`/`name`/`type`/`cols` **raw** (`schema.ts:25,45,63`) and `createTableSql`
   renders the column **type** raw (`ddl.ts:84-87`). The real invariant is:

   > **Every agent-supplied identifier (table, column, index name) is validated against a
   > strict allowlist (`/^[A-Za-z_][A-Za-z0-9_]*$/`) — or routed through
   > `@lesto/db`'s `quoteIdentifier` (`ddl.ts:122,135`) — before it reaches any DDL string,
   > AND the column `type` is constrained to a CLOSED enum of known SQL types, never a free
   > string.**

   This holds at the MCP boundary *regardless of* the ADR 0028 governance gate (it is an
   injection defense, not an authz defense). `schema.ts`'s editors do **no** quoting
   themselves, so validation/quoting at the MCP boundary is **mandatory**. Acceptance carries
   **identifier-/type-injection cases** (e.g. `type: "INTEGER); DROP TABLE users;--"`,
   `table: "users; DELETE FROM sessions;--"`) that must be rejected. The grep-assert becomes:
   *the typed input has no raw-SQL field, every identifier passes the validator/`quoteIdentifier`,
   and `type` is the enum* — **not** merely "no `execute` call."
3. **Governed by ADR 0028's principal.** Even file generation is gated:
   `requirePermission(context, "schema:propose")` — fail-closed, refusing a coded
   `MCP_FORBIDDEN`. `requirePermission`, `context.actorRoles`, `MCP_FORBIDDEN`, and the
   actor-in-audit are **all owned by ADR 0028 Phase 3a**; this ADR consumes them, it does not
   introduce them. The diff is the artifact the (eventual) wedge demo *shows* before shipping.
4. **A bounded change vocabulary, not arbitrary SQL.** The tool accepts a small typed set.
   Three map directly onto `Schema`'s real editor methods — `add_column → Schema.addColumn`
   (`schema.ts:29`), `add_index → Schema.addIndex` (`schema.ts:52`), `drop_table →
   Schema.dropTable` (`schema.ts:24`). The fourth, `create_table`, is **cut from the MCP
   vocabulary** (see the decision below) — table creation stays CLI/code-only. Arbitrary
   `Schema.execute(rawSql)` from agent input is **out of scope** for the MCP surface (it stays
   a hand-authored escape hatch).

   **`create_table` decision (must-fix — CUT from MCP):** `createTableSql(table, dialect)`
   (`ddl.ts:132`) requires a real `@lesto/db` `Table` value — a `tableName` plus a
   `columnList` of `Column`s, each carrying name/sqlType/nullable/primaryKey/unique/default/FK
   (`db/src/table.ts:36-83`, `ddl.ts:90-136`). To build that from MCP input, the `create_table`
   tool-input schema would have to let an agent express per-column
   name+type+nullability+pk+unique+default+FK — which **is** a column-design surface over MCP,
   in direct tension with the "**not** a schema-design DSL" non-goal. **Decision: `create_table`
   is not an MCP tool.** Table creation remains CLI/code-only (`lesto g migration` +
   `createTableSql` in app code). The MCP migration vocabulary is **only**
   `add_column`/`add_index`/`drop_table`. This also removes the only path by which an
   agent-supplied column **type** could reach the raw `sqlType` render (`ddl.ts:87`); the
   remaining `add_column` type field is constrained by the closed type enum above.

#### Part B.2 — `apply_migration` (governed, audited, never under the legacy gate)

`apply_migration` is the only destructive verb, and it carries every ADR 0028 guardrail:

1. **Permission-gated, fail-closed.** `requirePermission(context, "schema:apply")` — a
   dedicated high-privilege permission distinct from `schema:propose`. `destructive: true`;
   refuses with `MCP_FORBIDDEN` outside the grant. There is **no** silent fail-open.
2. **NEVER registers or runs under the legacy `requireOperator`/`mode` gate (hard, tested
   invariant — must-fix).** The review flagged a landmine: ADR 0033/0034 leave open "run the
   dev MCP server in operator mode," and wiring a destructive apply to the **existing** binary
   `requireOperator` (`tools.ts:254-264`) would ship an **UNATTRIBUTED** governed apply —
   operator mode is a process-wide binary flag with no actor, and `McpAuditRecord` has no
   actor field (`tools.ts:77-95`). **There is no interim operator-mode path for any
   destructive schema verb.** `apply_migration` registers **only** when a real actor resolver
   + actor-bearing audit record are present (ADR 0028 Phase 3a), and otherwise **fails closed
   — it is absent from `buildTools` output entirely.** Negative test (must-fix): with no
   resolver wired, `apply_migration` does **not** appear in `buildTools`.
3. **Dry-run before apply is mandatory; attributable on apply.** Apply runs the
   already-proposed `MigrationEntry` through `Migrator.migrate()` (`migrator.ts:143`) — already
   transactional and idempotent — and records the **resolved actor** in the MCP audit record
   (`McpAuditRecord` extended with `{ actor }` by ADR 0028 Phase 3a, `tools.ts:77-95`). An
   unattributed governed apply is **refused**, not accepted with a forged actor.
4. **The roles store is the hard prerequisite.** Same explicit prerequisite ADR 0028 names for
   its Phase 3. This ADR does not re-solve it; it depends on it.
5. **Observability composes ADR 0031 (when its seam exists).** `apply_migration` emits an
   **audit record now** (`tools.ts:608` dispatch path); trace-span attachment to the unified
   trace lands **only when ADR 0031 Phase 1's `@lesto/mcp` dispatch-tracer seam exists** —
   that seam is itself **Accepted (ADR 0031 Phase 1) but unbuilt**, so the span is
   gated on it, not asserted against it.

### The downstream claim is gated on Part B.2 (a follow-up doc task, not a claim now)

Only **after** `apply_migration` ships at the full bar do the two honesty guardrails become
editable: `docs/devrel/wedge-demo-script.md:95-98` (add the "migrate from Claude" beat) and
`docs/brand/messaging.md:78` (drop "NOT an MCP tool yet"). This is recorded as a **follow-up
doc increment gated on Part B.2**, never a claim to make early. Because Part B.2 is itself
deep-gated on ADR 0028's unbuilt roles store, this claim is the **least likely of the wave to
ship** — so the framing here is "this ADR **designs the path** to close the migrate-from-Claude
gap," not "this ADR closes it."

## Non-goals

- **Not a schema-design DSL or auto-migration.** No drift detection, no
  diff-the-live-database, no "infer the migration from a description of the end state." The
  agent proposes a *bounded, typed change* (`add_column`/`add_index`/`drop_table` only);
  `create_table` is **not** an MCP verb (it would be a column-design surface — see the
  create_table decision). A human (or a governed apply) ships it.
- **Not arbitrary DDL over MCP — and identifier-safe, not merely "no raw-SQL field."** The
  MCP vocabulary accepts **no caller-provided SQL string**, AND every agent-supplied
  identifier is validator-/`quoteIdentifier`-checked and every column type is a closed-enum
  value before it reaches a DDL string (`schema.ts` interpolates raw — `schema.ts:25,45,63`;
  `createTableSql` renders the type raw — `ddl.ts:87`). The grep-/test-assert is *"no raw-SQL
  input field; every identifier passes the validator/quote; `type` is the enum"* — **not**
  "no `execute` call."
- **Not a destructive apply under the legacy gate.** `apply_migration` never registers or
  runs under `requireOperator`/operator-mode; with no actor resolver it is absent from
  `buildTools`.
- **Not row-level / data security.** `@lesto/authz` is role→permission only; `allows` has no
  row predicate. Governance is per-`(resource, action)` — here `schema:propose` /
  `schema:apply`.
- **Not "complete schema reflection."** Part A surfaces the cheaply-available declared shape;
  full introspection is deferred (no PREVIEW overclaim).
- **No silent fail-open.** Both migration verbs deny by default; there is no ungoverned
  schema-change path over MCP.
- **No "migrate from Claude" claim until Part B.2 ships.** The guardrail docs stay as-is.

## Deferred — recorded, not scheduled; each gated on a real consumer

- **All of Part B (`propose_migration` / `apply_migration` + the migrate-from-Claude claim)**
  — a separately-tracked epic **blocked on ADR 0028 Phase 3a + the `userId → roles` store**,
  off this wave's gate. See *Board prerequisites*.
- **Full schema introspection** (a normalized, JSON-serializable model of every table,
  column, type, constraint, FK, and index) — gated on the migration tools (Part B) needing
  more than version-list + declared columns to render a precise diff, and on ADR 0033's
  preview surface wanting a richer schema resource.
- **OpenAPI request/response body schemas** (Zod-extracted, the documented post-1.0 follow-on,
  `openapi.ts:125-128`) — the resource serves the route-shape skeleton until that lands; gated
  on the Zod-extraction tier shipping in `@lesto/openapi`.
- **`create_table` over MCP** — cut (column-design DSL); revisit only with a bounded,
  no-FK/no-constraint design and a real consumer demand.
- **`rollback`/`down` over MCP** — `Migrator.rollback()` exists (`migrator.ts:195`) but a
  *governed agentic rollback* is deferred; gated on a real "undo the last agent-applied
  migration" demand and on Part B.2 audit proving who applied it.
- **Remote/HTTP MCP transport for migration tools** — `@lesto/mcp` is stdio-only today;
  remote transport inherits ADR 0028 Phase 3b's prerequisites (OAuth Resource Server,
  audience-bound tokens, no `kernel → mcp` cycle); not in scope here.
- **Migration *approval* / step-up before apply** (a second-operator sign-off on a destructive
  apply) — gated on the step-up primitive ADR 0028 defers.

## Board prerequisites (off-board blockers Part B depends on)

Part B's chain must **not** surface as "ready" when Part A completes (the review caught the
deep-gated chain becoming startable the moment a Part-A task closed). Track these as explicit
tracking tasks, and make every Part B card **blocked by** them:

- `ADR 0028 Phase 1 — principal model` (unbuilt)
- `userId → roles store` (unbuilt)
- `ADR 0028 Phase 3a — MCP governance` (`requirePermission` / `MCP_FORBIDDEN` / `actorRoles`
  / actor-in-audit; unbuilt)

Part B is best moved to a **separate epic** not released by this wave's gate. See the returned
board actions.

## Reviews

- **Grounded single pass.** Confirmed *no* `lesto migrate` apply CLI exists (migrations run at
  kernel boot, `kernel.ts:244-248`; `lesto g migration` only writes a file,
  `generate.ts:760-767`) — so "governed apply" is genuinely new surface. Confirmed the MCP
  server advertises only `tools`, not `resources` (`server.ts:58`), making Part A additive.
  Pinned the OpenAPI route-shape-only limitation (`openapi.ts:125-128`).
- **3-lens internal adversarial pass (correctness/security · simplicity/scope ·
  sequencing/coupling).** Cut arbitrary-DDL-over-MCP; changed apply from a single destructive
  tool to a propose→apply gate; made both verbs fail-closed; demoted full schema introspection
  to Deferred; reused `@lesto/openapi`'s `toOpenApi`; surfaced the ADR 0028 dependency.
- **Second internal adversarial pass (2026-06-22).** Fixed a phantom `Schema.createTable` API
  (re-mapped to `addColumn`/`addIndex`/`dropTable` + `@lesto/db`'s `createTableSql`);
  re-pointed the governance prerequisite from ADR 0028 Phase 1 to **Phase 3a**; restated the
  "no arbitrary DDL" invariant; softened the apply-span acceptance to ADR 0031's unbuilt seam.
- **Independent red-team + chief-architect pass (2026-06-22) — applied.** The verdict was
  **split**; every must-fix is applied in place:
  - *(must-fix, structure — SPLIT)* Split this ADR into **Part A (committed-now: resources +
    describe_app)** on this wave's gate, and **Part B (deferred: governed migration tools +
    the migrate-from-Claude claim)** moved to a separate **ADR-0028-blocked epic, off this
    gate** — so the board no longer surfaces the deep-gated migration chain as "ready" the
    moment a Part-A task completes. Added a *Board prerequisites* section naming the off-board
    blockers.
  - *(blocker, security — Part B)* The migration invariant defended the **wrong line**.
    `schema.ts:25/45/63` interpolate name/table/type/cols **raw** into `db.exec`, and
    `createTableSql` renders the column type raw (`ddl.ts:87`) — so `type: "INTEGER); DROP
    TABLE users;--"` injects DDL **without** touching `execute`, passing the old grep-assert.
    Rewrote the invariant to: **every identifier validated against `/^[A-Za-z_][A-Za-z0-9_]*$/`
    (or `quoteIdentifier`-quoted) AND column type constrained to a CLOSED enum**, with
    identifier-/type-injection acceptance tests; this holds independent of the 0028 gate.
  - *(must-fix, security — Part B)* Stated as a **hard, tested invariant** that
    `apply_migration` NEVER registers or runs under the legacy binary `requireOperator`/
    operator-mode (no interim path — that would ship an unattributed governed apply;
    `McpAuditRecord` has no actor, `tools.ts:77-95`). Negative test: it is **absent from
    `buildTools`** without an actor resolver.
  - *(must-fix, correctness — Part A)* `describe_app`/the collections resource must
    **gracefully degrade** when content peers are absent — `requireContent` **throws
    `MCP_CONTENT_PACKAGES_MISSING`** today (`tools.ts:178-181`), so the old "dispatches without
    refusal" acceptance was unmeetable on a content-less app. Added an empty-but-valid
    collections value + a content-less-app acceptance.
  - *(must-fix, scope — Part B)* **Cut `create_table`** from the MCP migration vocabulary: its
    input is a partial column-design DSL (`createTableSql` needs a full `Table` with per-column
    design, `db/src/table.ts:36-83`), contradicting the "not a schema-design DSL" non-goal.
    Table creation stays CLI/code-only. Recorded the decision.
  - *(must-fix, coverage — Part A)* The `resources/list`+`resources/read` registration is real
    branching logic, **not** the 1-line passthrough today's `server.ts` is; parking it under
    the whole-file `server.ts` coverage exclusion would smuggle logic past the 100% gate. Moved
    all select/dispatch logic into the covered `resources.ts` (server.ts stays a true
    passthrough, grep-asserted to add no branch). A **new security-boundary branch in any
    content-prefixed package still requires explicit 100%**, the `content-` baseline skip
    notwithstanding.
  - *(must-fix, grounding)* Re-anchored **every** `file:line` citation to the current tree
    (every original `tools.ts`/`server.ts` anchor was stale by 40-480 lines). Key fixes:
    `capabilities` `server.ts:58` (was 29); `buildTools` `tools.ts:336` + return array
    `tools.ts:552-563` (was 471-481); `McpAuditRecord` `tools.ts:77-95` (was 35); `dispatch`
    `tools.ts:608` (was 527); `requireOperator` `tools.ts:254-264` (was 188); `routes` field
    `tools.ts:103` (was 60-61); `listContentCollections` `tools.ts:418-435` (was 352-365);
    `requireContent` throw `tools.ts:178-181`; `@lesto/db` dep `package.json:14` (was 16);
    `@lesto/migrate` `:17` / `@lesto/kernel` `:16` (was 19/18); kernel migrate
    `kernel.ts:244-248` (was 23-24,69); `versionStamp` `generate.ts:794-795`; `Schema`
    methods `schema.ts:24/29/52/67`; `createTableSql` `ddl.ts:132` + raw `sqlType` `ddl.ts:87`.
  - *(should-fix, honesty)* Softened the framing from "this ADR closes the biggest honesty
    gap" to "this ADR **designs the path** to close it; the close lands only with Part B.2,
    deep-gated on ADR 0028's unbuilt roles store" — Part B is the least likely of the wave to
    ship.
  - *(should-fix, sequencing)* Downgraded the "0031 is the keystone" framing: **Part A has no
    dependency on ADR 0031's spans** (only the later trace-attachment work does) and should
    ship first alongside ADR 0035 Phase 1.
  - *(nit, scope)* Dropped the over-broad "estate builds/deploys" gate from the Part-A
    dogfood acceptance — read-only resources are orthogonal to build/deploy; the meaningful
    gate is that estate's `lesto mcp` **lists** the four resources + `describe_app` over stdio.
  - *(nit, correctness)* Noted the OpenAPI resource serves the **unfiltered** route set (no
    `internal`-route exclusion vs the CLI's `isInternal` path, `openapi.ts:33-38`).

## Consequences

- An agent can finally **see the app's contract** (routes, OpenAPI, collections, and the
  **declared** schema shape — migration versions + `defineTable` columns where supplied,
  **not** full reflection; an absent `context.schema` or absent content peers yield
  empty-but-valid resources, never a refusal) as first-class MCP resources — closing the
  "Claude can talk about the app but not see it" gap for *shape*, the way `handle_request`
  closed it for behavior. **This is the part that ships now.**
- Schema evolution over MCP is **designed** as a fail-closed, dry-run-first, identifier-safe,
  attributable propose→apply gate — but is **deferred off this wave's gate**, blocked on ADR
  0028 Phase 3a + the `userId → roles` store, and must clear its own adversarial + security
  review (notably the identifier-injection defense) before any of it lands.
- The wedge demo's migrate-from-Claude honesty gap closes **only when Part B.2 ships** — the
  guardrail docs (`messaging.md:78`, `wedge-demo-script.md:95-98`) are edited as a gated
  follow-up, never ahead of the code; this ADR **designs the path**, it does not yet close it.
- Slow iteration upheld: only Part A (read-only resources + `describe_app`) lands first, with
  no dependency on ADR 0028 or ADR 0031; the destructive migration verbs follow behind ADR
  0028's principal gate and roles store, and the claim follows behind the shipped tool.
