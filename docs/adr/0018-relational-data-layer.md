# ADR 0018 — A relational data layer for `@keel/db` (relations, joins, foreign keys, richer types)

- **Status:** Proposed
- **Date:** 2026-06-17
- **Deciders:** tech lead + owner
- **Supersedes nothing; extends ADR 0004 (data-layer style), ADR 0006 (async seam), ADR 0005 (validation at the boundary).**

## Context

`@keel/db` is a Drizzle-shaped schema-as-value query layer: `defineTable` is the
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
- **No relation loading.** Fetching a user and their posts is two hand-written
  queries and a manual stitch, every time.
- **Three column types.** `TEXT | INTEGER | REAL` (`packages/db/src/columns.ts:23`).
  A boolean is an integer-by-convention; a timestamp is a string-by-convention; a
  JSON blob is a `TEXT` the caller `JSON.parse`s by hand. The schema value — which
  exists precisely to be the single source of truth — doesn't actually know what
  these columns *are*.

This ADR closes that gap. The hard part is not the SQL; it is doing it **without
rebuilding `@keel/orm`**, which we deleted on purpose (commit `d16feb7`) because its
ActiveRecord shape — inheritance, a global connection, string-keyed attributes, a
`references("category") → categorys` pluralization inflector, and a *synchronous*
seam incompatible with a networked Postgres pool (ADR 0006) — leaked at every
call-site. Relations are exactly where an ORM's bad ideas hide. So the design below
is constrained as much by what it must *not* become as by what it adds.

### Non-negotiable constraints inherited from 0004 / 0005 / 0006

1. **Schema-as-value, no strings.** A relationship targets a *column value*
   (`users.id`), never a table name string. The pluralization footgun that died
   with the `TableBuilder` does not come back.
2. **Explicit `db`, no global, no inheritance.** Rows stay plain. There are no
   `.save()`/`.load()` methods on a row, no lazy-loading proxy, no identity map, no
   `useDatabase()`. Loading is an explicit verb on `db`.
3. **Async-only, no sync escape hatch.** Every new terminal returns a `Promise`
   (ADR 0006). Relation loading must be backable by a `pg.Pool` over a socket
   without `deasync`/`Atomics.wait`.
4. **Dialect parity is a CI gate, not a hope.** Every new bit of SQL — FK DDL, join
   rendering, the eager-load queries — runs in `db-parity-postgres` against real
   `postgres:16`, identical results on both engines (`packages/integration/test/db-parity.integration.test.ts`).
5. **Validation stays at the boundary (ADR 0005).** The data layer does not
   semantically validate a foreign key ("does this `categoryId` exist?"); the
   *database* enforces referential integrity via the FK constraint, and a violation
   surfaces as a coded `DbError`. App-level existence checks live in the boundary's
   Zod schema, as today.
6. **First-class `transaction()` (ADR 0006).** Multi-table writes that must be
   atomic use `db.transaction`, never loose `exec("BEGIN")` calls.

## Decision

Ship the relational layer as **four independent increments on `@keel/db`** (no new
package), each landing behind the parity gate, each dogfooded in `examples/estate`
in the same change. The two load-bearing design calls — *FK targets are typed
column thunks* and *collection loading stitches batched queries rather than
fanning out a cartesian join* — are what keep this from being an ORM.

### 1 · Richer column types (the smallest, independent first step)

Add column builders whose **storage type stays one of the existing three** but
whose **TS type and hydration are honest**. No new SQL storage primitives means no
new parity surface in the storage engine — only in hydration.

| Builder | Storage (sqlite / pg) | TS type | Hydration |
|---|---|---|---|
| `boolean(name)` | `INTEGER` / `BIGINT` | `boolean` | `0/1 ⇄ false/true` |
| `timestamp(name)` | `INTEGER` / `BIGINT` (epoch-ms) | `Date` | `number ⇄ Date` |
| `json<T>(name)` | `TEXT` | `T` | `JSON.parse` / `JSON.stringify` |

`timestamp` standardizes on **epoch-ms `BIGINT`**, matching the convention the
durable stores already chose (ADR 0013) and dodging the timezone/`TIMESTAMPTZ`
parity swamp. `json` is generic so `InferRow` carries the parsed shape. These are
purely additive — `text/integer/real` are untouched — and each is a row in the
hydration parity test. (UUID is deliberately deferred: it wants a `gen_random_uuid()`
default that forks hard across dialects; not worth it for v-next.)

### 2 · Foreign keys — typed column thunks, dialect-aware DDL, ordered creation

A new column modifier:

```ts
export const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorId: integer("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),   // ← the new modifier
  title: text("title").notNull(),
});
```

The three decisions inside `references()`:

- **The target is a thunk returning a column value**, `() => users.id`, not
  `"users"`/`"id"` strings. The thunk defers evaluation so `posts` and `users` can
  reference each other across a circular import; calling it yields a `Column`, off
  which we read `spec.name` and the owning table name. This is the single most
  important anti-ORM decision in the ADR: **a wrong reference is a TypeScript error
  at the column, not a pluralized string that explodes at runtime.** The column's
  storage type must match its target's (a `references(() => users.id)` on a `text`
  column is a compile error), which also kills the silent type-mismatch class.
- **DDL is dialect-aware but standard.** Both engines accept
  `REFERENCES "users"("id") ON DELETE CASCADE` inline in `createTableSql`; the fork
  is only the integer-width one we already have (`BIGINT` on pg). `onDelete` /
  `onUpdate` accept `cascade | restrict | set null | no action`.
- **SQLite enforces FKs only with `PRAGMA foreign_keys = ON`** — *off by default,
  per-connection.* The SQLite adapter (`openSqlite`) issues it on open so the two
  engines behave identically. This is the kind of dialect gotcha the parity gate
  exists to catch, and it gets an explicit test: an orphan insert is rejected on
  *both* drivers.

**Creation/drop ordering becomes the schema's job, not the human's.** FKs impose a
topological order the migrator does not model today (it runs migrations in version
order and trusts the human to declare tables in dependency order —
`packages/migrate/src/migrator.ts:64`). Add a pure helper:

```ts
createSchemaSql(tables: Table[], dialect): string[]   // topo-sorted CREATE, FK edges respected
dropSchemaSql(tables: Table[], dialect): string[]     // reverse order
```

It sorts by `references()` edges; a genuine cycle (mutual FKs) is split into
`CREATE` + a deferred `ALTER TABLE … ADD CONSTRAINT` pass (and flagged loudly,
since it's rare and SQLite can't `ALTER … ADD CONSTRAINT` — those tables must use a
nullable-then-backfill pattern, documented). A referential-integrity violation from
either driver is mapped at the adapter seam to a coded `DbError("DB_FK_VIOLATION")`,
extending the `DbErrorCode` union (`packages/db/src/errors.ts:14`).

### 3 · Joins in the query builder — qualified columns, namespaced rows

The prerequisite is **table-qualified column rendering**. Today a `Condition`
renders `quoteIdentifier(column.spec.name)` → `"email"`. A column reference already
carries its owning table (via the FK work above we can reach it), so qualification
is rendering `"users"."email"` when a query involves more than one table. Single-table
queries keep emitting bare columns (no churn, no risk to existing call-sites).

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
  result set back into the per-table objects.
- **Self-joins and reused tables require an alias** — `alias(users, "author")` —
  which carries its own qualifier. This is the only ergonomic tax, and it's
  explicit.

This layer is SQL-faithful: it's the primitive the queue's hand-rolled join SQL
would target, and it does not pretend collections away.

### 4 · Declarative relations + eager loading — *stitched*, not cartesian

The ergonomic headline. Declare relations as values (separate from the table, so the
table stays a pure column map):

```ts
export const usersRelations = relations(users, ({ many }) => ({
  posts: many(posts),
}));
export const postsRelations = relations(posts, ({ one }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }),
}));
```

Then a relational read verb, distinct from `.select()` so the two layers never blur:

```ts
const list = await db.load(users, {
  with: { posts: true },
  where: eq(users.emailVerifiedAt, /*…*/),
  limit: 20,
}).all();
//  list: (User & { posts: Post[] })[]
```

**The load strategy is the decisive correctness call: collection relations (`many`)
load as separate, batched queries stitched in memory — never a single fan-out
join.** Load the roots (one query), collect their keys, load all children with one
`WHERE author_id IN (…)` query, stitch by key. Rationale:

- A `JOIN` that eager-loads a `hasMany` **multiplies rows** — a user with 50 posts
  comes back 50 times, every scalar user column duplicated 50×. With two
  collections it's a cartesian product. Stitching is O(roots + children) rows over
  the wire instead.
- Two simple `IN` queries are **trivially dialect-portable**; a correlated/lateral
  eager join is where dialect SQL diverges hardest. Stitching keeps the parity gate
  cheap.
- It is the same conclusion Drizzle's relational-queries API reached, for the same
  reasons.

`one`/`belongsTo` relations (at most one child) may use either a join or a batched
`IN`; we default to the **same batched-IN stitch** for one uniform, predictable code
path. Everything runs inside one `db.transaction` so the multi-query read is a
consistent snapshot. **There is no lazy loading** — `user.posts` is populated iff you
asked for it in `with`; accessing an unloaded relation is `undefined`, not a silent
query. That single rule is the line between this and an ORM: loading is always an
explicit, visible verb, never a property-access side effect.

## What this is explicitly NOT

- **Not `@keel/orm` v2.** No inheritance, no row methods, no global connection, no
  lazy proxies, no identity map, no migration-by-magic, no inflector. Re-read
  ADR 0004's "Context" — every bullet there is a thing this design refuses.
- **Not a schema-diff migration generator.** Migrations are still hand-written and
  *import* the schema value (ADR 0004); `createSchemaSql` only orders what you
  already declared. A Drizzle-Kit-style diff/codegen is a separate future ADR.
- **Not query-builder maximalism.** No window functions, no recursive CTEs, no
  `GROUP BY`/`HAVING` aggregation surface in this increment. The `db.raw()` escape
  hatch stays the pressure valve for SQL beyond the DSL (the queue keeps its raw
  `FOR UPDATE SKIP LOCKED` claim — relations do not try to subsume locking).
- **Not UUID/`TIMESTAMPTZ`/array/enum column types** — deferred; each forks dialect
  defaults harder than its payoff for v-next.

## Sequencing

The four increments are independently shippable and independently valuable, in this
order (each gated green, each wired into estate):

1. **Richer types** — additive, lowest risk, unblocks honest `timestamp`/`boolean`
   columns everywhere else. *(~½ the work; no new SQL storage surface.)*
2. **Foreign keys** — `references()` + dialect FK DDL + `PRAGMA` + `createSchemaSql`
   topo-sort + `DB_FK_VIOLATION`. The integrity foundation.
3. **Joins** — qualified-column rendering (the prerequisite refactor) + `innerJoin`/
   `leftJoin` + namespaced rows + `alias`.
4. **Relations + `load(…).with(…)`** — declared relations + the stitched batched
   eager-load. Built on 2 and 3.

estate is the dogfood at every step: it already has a users table; increment 2 gives
posts a real `authorId` FK, increment 4 renders an author's posts via one
`load(users, { with: { posts: true } })` — replacing a hand-stitched pair of
queries, which is the friction-finding the gallery-as-QA loop is for.

## Consequences

- The schema value finally tells the whole truth: a column knows it's a boolean, a
  timestamp, a JSON `T`, or a reference to another table — so DDL, FK enforcement,
  query types, and (later) MCP schema introspection all read it from one place.
- Multi-table reads stop dropping to raw SQL; the type system follows a foreign key.
- The parity surface grows: FK DDL, the SQLite `PRAGMA`, join rendering, and the
  eager-load queries are all new rows in `db-parity-postgres`. That cost is the
  point — it's how "SQLite local → Postgres prod, same APIs" stays literally true
  for relations, not just scalars.
- The migrator gains a notion of table dependency order it lacked; cyclic schemas
  pay an explicit, documented tax rather than failing mysteriously.
- Cost: this is the largest single addition to `@keel/db` since it shipped, and the
  qualified-column refactor touches the hot path of every existing query. It is
  phased precisely so each phase is revertible at its boundary and provable on both
  drivers before the next begins.

## Open questions (resolve during the increment-1 spike)

- **Naming:** `db.load(t, { with })` vs a `db.query(t)` relational builder vs
  extending `.select().with()`. Provisional: `db.load` — a distinct verb keeps the
  two layers unmistakable. Settle it against real estate call-sites.
- **`timestamp` representation:** epoch-ms `BIGINT` (proposed, matches ADR 0013) vs
  ISO-8601 `TEXT`. The former wins on parity and arithmetic; confirm no consumer
  needs sub-ms or tz.
- **Composite foreign keys / composite primary keys:** out of scope for v-next?
  Likely yes — single-column keys cover every in-tree call-site today.
