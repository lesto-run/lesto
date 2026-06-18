# ADR 0018 — A relational data layer for `@lesto/db` (foreign keys, joins, richer types)

- **Status:** Proposed
- **Date:** 2026-06-17
- **Deciders:** tech lead + owner
- **Supersedes nothing; extends ADR 0004 (data-layer style), ADR 0006 (async seam), ADR 0005 (validation at the boundary).**
- **Revised 2026-06-17** after an adversarial 3-lens review (correctness / simplicity / sequencing). The revision: a prerequisite **Increment 0 (column identity)** the first draft hand-waved; **deferred the relational eager-loader** (`relations()` + `db.load().with()`) to a follow-on ADR because it is a convenience layer with no second consumer and unresolved semantics; replaced the `createSchemaSql` topo-sort with a cycle-detecting validator; deferred `json<T>`. The honest scope of v-next is **FKs + joins + boolean/timestamp**, on top of a column that finally knows its table.

## Context

`@lesto/db` is a Drizzle-shaped schema-as-value query layer: `defineTable` is the
single source of truth for both DDL and TS row types, `db` is threaded explicitly,
rows are plain objects, every terminal is async (ADR 0004, ADR 0006). It is correct
and well-liked. It is also **single-table and scalar-only**, and that is now the
loudest honest gap against Rails 8 / Laravel 12 / AdonisJS 6 / Prisma / Drizzle:

- **No foreign keys.** A column that points at another table is a bare
  `integer("author_id")` (`packages/migrate/test/migrate.test.ts:282`,
  `packages/queue/src/queue.ts`). Nothing renders a `REFERENCES` clause; nothing
  enforces referential integrity; the relationship exists only in the developer's
  head.
- **No joins.** `db.select().from(t)` is the whole `FROM`. There is no
  `.innerJoin/.leftJoin` and — the blocker beneath it — `conditions.ts` renders
  every column as a bare `"email"`, never table-qualified `"users"."email"`
  (`packages/db/src/conditions.ts:38`). Multi-table queries today drop to the
  `db.raw()` / `db.prepare()` escape hatch (the queue's claim SQL is the canonical
  example).
- **Three column types.** `TEXT | INTEGER | REAL` (`packages/db/src/columns.ts:23`).
  A boolean is an integer-by-convention; a timestamp is a string-by-convention. The
  schema value — which exists precisely to be the single source of truth — doesn't
  actually know what these columns *are*.

This ADR closes that gap. The hard part is not the SQL; it is doing it **without
rebuilding `@lesto/orm`**, which we deleted on purpose (commit `d16feb7`) because its
ActiveRecord shape — inheritance, a global connection, string-keyed attributes, a
`references("category") → categorys` pluralization inflector, and a *synchronous*
seam incompatible with a networked Postgres pool (ADR 0006) — leaked at every
call-site. Relations are exactly where an ORM's bad ideas hide. So the design below
is constrained as much by what it must *not* become as by what it adds.

### The hidden prerequisite: a column does not know its table

The first draft of this ADR asserted that "a column reference already carries its
owning table." **It does not.** A `Column` wraps a `ColumnSpec` whose fields are
`name / sqlType / nullable / unique / primaryKey / autoIncrement / hasDefault /
defaultValue` (`packages/db/src/columns.ts:29-38`) — *no table identity.* Columns
are built standalone by `text("email")` / `integer("id")` *before* they are placed
into a table; `defineTable` maps them by key and name but never tells a column which
table it landed in (`packages/db/src/table.ts:78-82`). Both load-bearing features
here depend on a column knowing its table: the FK thunk must read the *owning table*
off the target column to render `REFERENCES "users"(…)`, and join rendering must
qualify `"users"."email"`. So the real first step is not the easy one — it is
teaching a column its table. That becomes **Increment 0**.

### Non-negotiable constraints inherited from 0004 / 0005 / 0006

1. **Schema-as-value, no strings.** A relationship targets a *column value*
   (`users.id`), never a table name string. The pluralization footgun that died
   with the `TableBuilder` does not come back.
2. **Explicit `db`, no global, no inheritance.** Rows stay plain — no `.save()` /
   `.load()` methods on a row, no lazy-loading proxy, no identity map, no
   `useDatabase()`.
3. **Async-only, no sync escape hatch.** Every new terminal returns a `Promise`
   (ADR 0006); everything must be backable by a `pg.Pool` over a socket.
4. **Dialect parity is a CI gate, not a hope.** Every new bit of SQL — FK DDL, join
   rendering — runs in `db-parity-postgres` against real `postgres:16`, identical
   results on both engines (`packages/integration/test/db-parity.integration.test.ts`).
5. **Validation stays at the boundary (ADR 0005).** The data layer does not
   semantically validate a foreign key ("does this `categoryId` exist?"); the
   *database* enforces referential integrity via the FK constraint, and a violation
   surfaces as a coded `DbError`. App-level existence checks live in the boundary's
   Zod schema, as today.
6. **First-class `transaction()` (ADR 0006).** Multi-table writes that must be
   atomic use `db.transaction` (already implemented, dialect-agnostic), never loose
   `exec("BEGIN")` calls.

## Decision

Ship the relational layer as **four increments on `@lesto/db`** (no new package), in
strict dependency order, each landing behind the parity gate, each non-breaking to
estate. **Foreign keys and joins are the headline; the relational eager-loader is
explicitly out of scope for this ADR** (see "Deferred"). The two load-bearing
anti-ORM decisions are *FK targets are typed column thunks* and *a column carries
its table identity* — both keep this from becoming an ORM by keeping every reference
a typed value the compiler checks.

### 0 · Column identity (the unlisted prerequisite, do first)

`ColumnSpec` gains a `tableName?: string`, populated by `defineTable` when it seals
the table value — the one place that knows both the column and its table. The
column builders (`text`/`integer`/`real`) still construct table-agnostic specs; the
table name is stamped on at `defineTable` time. No SQL, no parity surface, no
behavior change to any existing query — `conditions.ts` keeps rendering bare names
for single-table queries. The only observable is a new invariant: after
`defineTable`, `users.id.spec.tableName === "users"`. This is the foundation FK
rendering and column qualification both stand on; nothing downstream is honest until
it lands.

*Acceptance:* a column reports its table after `defineTable`; every existing test is
green and unchanged.

### 1 · Richer column types — `boolean` and `timestamp`

Add two column builders whose **storage type stays one of the existing three** but
whose **TS type and hydration are honest**:

| Builder | Storage (sqlite / pg) | TS type | Hydration |
|---|---|---|---|
| `boolean(name)` | `INTEGER` / `BIGINT` | `boolean` | `0/1 ⇄ false/true` |
| `timestamp(name)` | `INTEGER` / `BIGINT` (epoch-ms) | `Date` | `epoch-ms number ⇄ Date` |

This is *additive to existing columns* (`text/integer/real` are untouched) but it is
**not free machinery**: `ColumnSpec` needs a `kind: "text" | "integer" | "real" |
"boolean" | "timestamp"` discriminator, `hydrate()` (`queries.ts:56-69`, today
numeric-coercion only) must dispatch on it (0/1→bool, number→`Date`), and the
type-level `CellType` must widen (`timestamp` → `Date`, `boolean` → `boolean`). Each
is one row in the hydration parity test on both drivers — including the Postgres
quirk that `BIGINT` returns as a *string*, which the boolean/timestamp coercion must
survive.

`timestamp` standardizes on **epoch-ms `BIGINT`**, matching the durable stores
(ADR 0013) and dodging the `TIMESTAMPTZ`/timezone parity swamp.

**Deferred from this increment:** `json<T>(name)`. It has zero in-tree consumers
today (it is `text()` + a hand-rolled `JSON.parse` at the call-site, with no parity
risk), and the generic `<T>` adds type plumbing for no current payoff. Add it when
the first real consumer needs it.

### 2 · Foreign keys — typed column thunks, dialect-aware DDL, enforced on both drivers

A new column modifier (now implementable because Increment 0 gave the target column
its table identity):

```ts
export const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),   // ← the new modifier
  title: text("title").notNull(),
});
```

- **The target is a thunk returning a column value**, `() => users.id`, not
  `"users"`/`"id"` strings. The thunk defers evaluation so `posts` and `users` can
  reference each other across a circular import; calling it yields a `Column`, off
  which we read `spec.name` **and `spec.tableName` (Increment 0)**. This is the
  single most important anti-ORM decision: **a wrong reference is a TypeScript error
  at the column, not a pluralized string that explodes at runtime.** The referencing
  column's storage type must match its target's (`references(() => users.id)` on a
  `text` column is a compile error), killing the silent type-mismatch class too.
- **DDL is dialect-aware but standard.** `createTableSql` learns to emit
  `REFERENCES "users"("id") ON DELETE CASCADE` inline (a new branch in
  `columnDeclaration`, `ddl.ts:87`); the only fork is the integer-width one we
  already have (`BIGINT` on pg). `onDelete`/`onUpdate` accept
  `cascade | restrict | set null | no action`.
- **SQLite enforces FKs only with `PRAGMA foreign_keys = ON`** — *off by default,
  per-connection.* **Issuing this pragma in the `openSqlite` adapter
  (`packages/runtime/src/sqlite.ts`, which does not today) is part of this
  increment, and the increment is gated on a parity test that an orphan insert is
  rejected on *both* drivers** — so a missing pragma fails the gate rather than
  silently letting SQLite pass a test it should fail.
- **A referential violation maps to a coded error.** There is no error-mapping seam
  today — both adapters re-throw driver errors raw. This increment adds one: the
  adapter's statement-execution path catches the driver's FK error (Postgres
  `SQLSTATE 23503`, SQLite `SQLITE_CONSTRAINT_FOREIGNKEY`) and rethrows
  `DbError("DB_FK_VIOLATION", …)`, extending the `DbErrorCode` union
  (`packages/db/src/errors.ts:14`). Naming the seam is part of the increment, not an
  afterthought.

**Creation order stays the human's call, with a guardrail — not a topo-sort.** FKs
impose a creation/drop order. Rather than a `createSchemaSql` that topologically
sorts tables (≈150 LOC that *also* splits ordering across two mechanisms, since
migrations are hand-written and run in version order — `migrator.ts:64`), keep the
industry-standard convention the migrator already uses: **declare the referenced
table's migration before the referencing one** (Rails/Laravel do exactly this). Add
one small helper, `assertAcyclicReferences(tables)`, that detects a genuine FK cycle
(`a → b → a`) and throws a *teaching* error ("cycle posts → users → posts; split the
constraint into a follow-up `ALTER TABLE ADD CONSTRAINT`, or use a
nullable-then-backfill column"). Cycles are rare; SQLite can't `ALTER … ADD
CONSTRAINT` at all, so the nullable-then-backfill pattern is the documented escape.
Validation, not automation.

*Dogfood (deferred, non-breaking when it lands):* the first draft said estate's
`posts.authorId` becomes a real `references(() => users.id)` FK — but **that schema
does not exist** (estate has standalone `pages`/`notes`, no posts→users). The real
by-convention FKs that "exist only in the developer's head" are in
`@lesto/mailing-lists`: `subscribers.listId → lists.id`, `broadcasts.listId →
lists.id`, the two on `broadcast_deliveries`. The natural dogfood is
`subscribers.listId.references(() => lists.id, { onDelete: "cascade" })` — a
schema-only change (the migration already creates `lists` before `subscribers`).
It is **deferred out of this increment** to keep it small and verified: FK
enforcement is now live in better-sqlite3, so the change must be proven not to break
any mailing-lists test that inserts under a synthetic `listId`. The increment's
acceptance is the parity gate (an orphan rejected on both drivers), not the dogfood.

**Also deferred out of Increment 2** (decided in a design consult): the coded
`DB_FK_VIOLATION` mapping — `@lesto/runtime` has no `@lesto/db` dependency, so
mapping the SQLite error there would add a dependency edge purely to rename an
error; the whole constraint-violation family (FK, unique, …) gets coded later in a
dedicated adapter error-seam. And `assertAcyclicReferences` — `createSchemaSql` was
already cut, so it would have zero callers, and the DB rejects a real create-order
cycle at `CREATE TABLE` anyway. A reference to a column never placed in a table is
still caught loud, at render time, by `DB_UNRESOLVED_REFERENCE`.

### 3 · Joins in the query builder — qualified columns, namespaced rows

With Increment 0 in place, **table-qualified column rendering** is now possible: a
`Condition` can render `"users"."email"` (from `column.spec.tableName` +
`spec.name`) when a query involves more than one table. Single-table queries keep
emitting bare columns (`conditions.ts:38` path unchanged) — zero churn, zero risk to
existing call-sites.

```ts
const rows = await db
  .select()
  .from(posts)
  .innerJoin(users, eq(posts.authorId, users.id))
  .where(eq(users.email, "ada@example.com"))
  .all();
//  rows: { posts: Post; users: User }[]   ← namespaced by table, not flattened
```

- `.innerJoin` / `.leftJoin` take a table value and an ON `Condition`. A left join
  makes the right side's row `Post | null` at the type level.
- **Rows are namespaced by table** (`{ posts, users }`), Drizzle-core style — never
  flattened, so two `id` columns can't collide. Hydration de-prefixes the flat
  result set into the per-table objects.
- **Self-joins / reused tables require an alias** — `alias(users, "author")` —
  carrying its own qualifier. This is the one ergonomic tax, and it's explicit.

This is the SQL-faithful primitive the queue's hand-rolled join SQL would target,
and — importantly — it is sufficient for every multi-table read in the tree today
(and the headline "relations/JOINs/FKs" gap is fully closed by Increments 0–3).

### Deferred to a follow-on ADR — declarative relations + eager loading

The first draft included a fourth increment: declared `relations()` plus a
`db.load(t, { with: { posts: true } })` relational reader that stitches batched
`IN (…)` queries. **It is removed from this ADR** and deferred to a follow-on
(ADR 0019), for three converging reasons surfaced by the adversarial review:

1. **It is a convenience layer with no second consumer.** Its only reader is the
   loader itself; `relations()` would be a public export nobody else introspects —
   premature abstraction. Raw joins (Increment 3) already cover every real
   multi-table read today.
2. **Its semantics are genuinely unresolved and need real call-sites to settle**,
   not estate's toy users/posts:
   - **No per-parent child bound.** One `WHERE author_id IN (…)` cannot express
     "the 5 most recent posts *per* user" — a global `LIMIT` is wrong. This needs a
     lateral/window strategy, a real design question.
   - **Child ordering** within each parent's array must be specified (the IN query
     orders globally; the stitcher re-partitions).
   - **Root-only filtering.** A `where` on the root cannot express "users who *have*
     a published post" — that needs an `EXISTS`/join the relational reader doesn't
     model. (Today the answer is Increment 3's join + `DISTINCT`, or `db.raw`.)
   - **Isolation honesty.** A multi-query read is *not* a consistent snapshot under
     either driver's default isolation (SQLite `DEFERRED`, Postgres `READ
     COMMITTED`): a concurrent commit between the root and child queries is visible.
     The follow-on ADR must either accept read-committed semantics explicitly or
     opt into a higher isolation level — not claim a "snapshot" it doesn't deliver.
3. **Deferring drops nothing from the stated gap.** "No relations/JOINs/FKs" is
   satisfied by Increments 0–3; ergonomic eager-loading is sugar on top.

The stitched-batched-query approach (one query per relation, `IN (…)`, stitch in
memory — *never* a cartesian eager-join that multiplies rows) remains the intended
strategy; it is recorded here so the design intent isn't lost, but it is designed
and built against 2–3 real call-sites in its own ADR.

## What this is explicitly NOT

- **Not `@lesto/orm` v2.** No inheritance, no row methods, no global connection, no
  lazy proxies, no identity map, no migration-by-magic, no inflector. Re-read
  ADR 0004's "Context" — every bullet there is a thing this design refuses.
- **Not a Drizzle dependency.** The adversarial review re-litigated build-vs-buy and
  confirmed ADR 0004's reasons still hold for this scope: richer types, FKs, and
  qualified-column joins are ~500 LOC hand-rolled, smaller and more controllable
  than pulling Drizzle's relational stack; the agent-native introspection angle
  still argues for owning the schema value.
- **Not a schema-diff migration generator.** Migrations stay hand-written and
  *import* the schema value (ADR 0004); there is no auto-topo-sort and no codegen.
- **Not query-builder maximalism.** No window functions, no recursive CTEs, no
  `GROUP BY`/`HAVING` aggregation in this ADR. `db.raw()` stays the pressure valve
  (the queue keeps its raw `FOR UPDATE SKIP LOCKED` claim — relations do not subsume
  locking).
- **Not the relational eager-loader** (`relations()` / `db.load().with()`) — and
  **not `json<T>`, UUID, `TIMESTAMPTZ`, arrays, enums, or composite keys** — all
  deferred; single-column keys cover every in-tree call-site today.

## Sequencing

Strict dependency order; each step is independently shippable, parity-gated, and
non-breaking on `main`:

0. **Column identity** — `ColumnSpec.tableName`, stamped by `defineTable`. The
   prerequisite the headline features stand on. No SQL surface.
1. **Richer types** — `boolean` + `timestamp` (a `ColumnSpec.kind` discriminator +
   `hydrate()` dispatch + `CellType` widening). Orthogonal to the FK→join chain; can
   land anytime after 0. *(json deferred.)*
2. **Foreign keys** — `references()` thunk (reads `tableName` from 0) + dialect FK
   DDL + the `openSqlite` `PRAGMA foreign_keys = ON` (gated by an
   orphan-rejected-on-both-drivers test) + the `DB_FK_VIOLATION` adapter-seam
   mapping + the `assertAcyclicReferences` guardrail. Estate gets a real `authorId`
   FK (schema-only, non-breaking).
3. **Joins** — qualified-column rendering (from 0) + `innerJoin`/`leftJoin` +
   namespaced rows + `alias`.

The dependency chain is **0 → 2 → 3** (FK rendering and qualified columns both need
the table identity from 0); **1 forks off 0** and is sequenced first only because
it's small and self-contained, *not* because anything downstream needs it — the ADR
no longer pretends richer-types-first signals progress on the hard chain.

## Consequences

- A column finally knows its table — so DDL, FK enforcement, qualified-join queries,
  and (later) MCP schema introspection all read identity from one place.
- Multi-table reads stop dropping to raw SQL; the type system follows a foreign key;
  referential integrity is enforced and coded identically on SQLite and Postgres.
- The parity surface grows by exactly what's enforceable: FK DDL, the SQLite pragma,
  the FK-violation mapping, and join rendering — each a new row in
  `db-parity-postgres`. That cost is the point: it's how "SQLite local → Postgres
  prod, same APIs" stays literally true for relations, not just scalars.
- Scope is honest: this ADR ships the *gap* (relations/JOINs/FKs + the two missing
  scalar types). The ergonomic relational reader — the part that needed real
  call-sites and had unresolved semantics — is named, scoped, and handed to its own
  ADR rather than over-designed against a toy example here.
- Cost: Increment 0 touches the `Column`/`ColumnSpec` type that every query depends
  on, and qualified-column rendering touches the hot path — both are phased to land
  behind the parity gate, revertible at each boundary, proven on both drivers before
  the next begins.

## Open questions (resolve during the Increment 0/1 spike)

- **`timestamp` representation:** epoch-ms `BIGINT` (proposed, matches ADR 0013) vs
  ISO-8601 `TEXT`. The former wins on parity and arithmetic; confirm no consumer
  needs sub-ms or tz before committing.
- **`ColumnSpec.kind` vs. keeping `sqlType` + a parallel logical tag:** one
  discriminator that drives both DDL storage type and hydration, or two fields?
  Settle in the Increment 1 spike.
- **Alias ergonomics:** is `alias(users, "author")` the right spelling, or should a
  self-referential FK (`employees.managerId → employees.id`) get sugar? Decide
  against the first real self-join.
