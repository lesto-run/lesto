---
title: Data
description: Define typed tables, run migrations, and query across SQLite and Postgres with one type-safe builder.
section: Batteries
order: 0
---

# Data

`@lesto/db` is a typed query builder over a `SqlDatabase` handle. You define
tables as plain values, and inserts, selects, updates, and joins are inferred
from them — there is no base class, no global connection, and no row methods.
The same schema value backs both your queries and your DDL, so the column list
lives in exactly one place. The same builder runs against SQLite in development
and Postgres in production; the only statement that differs between the two is
offset-without-limit, decided at render time from the dialect you pass.

Reach for it when you want a thin, SQL-faithful layer with end-to-end types and
no ORM machinery: there is no `.save()`, no lazy-loading proxy, and no identity
map. Foreign keys and joins are supported (per
[ADR 0018](https://github.com/lesto-run/lesto/blob/main/docs/adr/0018-relational-data-layer.md));
declarative `relations()` and eager-loading were deliberately deferred.

## Define a table

`defineTable` takes a name and a column map. Columns come in five kinds —
`text`, `integer`, `real`, `boolean`, and `timestamp` — each chained with
modifiers like `.notNull()`, `.unique()`, `.primaryKey()`, `.default()`, and
`.references()`. A new column is nullable until you mark it `.notNull()`.

```ts
import { defineTable, integer, text, boolean, timestamp } from "@lesto/db";

export const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  published: boolean("published").notNull().default(false),
  createdAt: timestamp("created_at").notNull(),
});
```

The table value is *also* the column-reference table: `posts.title` is the
typed column the query layer binds against.

## Infer types

The schema value is the source of truth for your TypeScript types too. Three
helpers derive shapes from it — no hand-written interfaces, no drift:

```ts
import type { InferRow, InferInsert, InferUpdate } from "@lesto/db";

type Post = InferRow<typeof posts>;
//   { id: number; title: string; body: string; published: boolean; createdAt: Date }

type NewPost = InferInsert<typeof posts>;
//   id and published are optional (default / auto-increment); the rest required

type PostPatch = InferUpdate<typeof posts>;
//   every column optional
```

Nullable, defaulted, and auto-assigned columns become optional on insert.
`boolean` reads back as a JS `boolean` and `timestamp` as a `Date` — both store
as `INTEGER` but hydrate honestly.

## Open a database

The builder runs over any handle that satisfies the `SqlDatabase` seam. Two
drivers ship with Lesto — `openSqlite` from `@lesto/runtime` for development
(defaults to in-memory; pass a filename to persist) and `openPostgres` from
`@lesto/pg` for production. Both return the handle plus a `close`:

```ts
import { openSqlite } from "@lesto/runtime";

const { db: handle, close } = await openSqlite("app.db");
```

```ts
import { openPostgres } from "@lesto/pg";

const { db: handle, close } = await openPostgres({
  connectionString: process.env.DATABASE_URL,
});
```

## Query

`createDb(handle)` wraps a driver handle in the typed `Db`. Each verb is a
fluent chain that terminates in an awaited driver call — `.get()` for the first
row (always `LIMIT 1`) or `undefined`, `.all()` for every row, `.run()` for a
write returning `{ changes }`, and `.count()` for a count:

```ts
import { createDb, eq } from "@lesto/db";

const db = createDb(handle);

// INSERT — .returning().get() hands back the inserted row, hydrated.
const created = await db
  .insert(posts)
  .values({ title: "On Engines", body: "…", createdAt: new Date() })
  .returning()
  .get();

// SELECT
const all = await db.select().from(posts).orderBy(posts.id, "asc").all();
const one = await db.select().from(posts).where(eq(posts.id, created.id)).get();
const total = await db.select().from(posts).count();

// UPDATE / DELETE — WHERE is required (no unbounded writes).
await db.update(posts).set({ published: true }).where(eq(posts.id, created.id)).run();
await db.delete(posts).where(eq(posts.id, created.id)).run();
```

## Conditions

Conditions are small typed values you pass to `.where()`. The column reference
fixes the value type — `eq(posts.id, "x")` is a compile error. `and` / `or`
combine them:

```ts
import { and, or, eq, gt, like, inList } from "@lesto/db";

await db
  .select()
  .from(posts)
  .where(
    and(
      eq(posts.published, true),
      or(like(posts.title, "On %"), gt(posts.id, 10)),
    ),
  )
  .all();

await db.select().from(posts).where(inList(posts.id, [1, 2, 3])).all();
```

`isNull(col)` / `isNotNull(col)` test a nullable column the same way — pass them
to `.where()` like any other condition.

## Join two tables

A join promotes a flat select into a result keyed *by table* — `{ posts, authors }` —
so two same-named `id` columns never collide. `.innerJoin` / `.leftJoin` each
take a table value and an `ON` condition; a left join makes the joined side
`… | null` for rows with no match.

```ts
import { defineTable, integer, text, createDb, eq } from "@lesto/db";

const authors = defineTable("authors", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
});

const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  authorId: integer("author_id").references(() => authors.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
});

const db = createDb(handle);

const rows = await db
  .select()
  .from(posts)
  .innerJoin(authors, eq(posts.authorId, authors.id))
  .where(eq(authors.name, "Ada"))
  .all();

// rows: { posts: Post; authors: Author }[]  — namespaced, not flattened
rows[0].posts.title;
rows[0].authors.name;
```

To join a table to itself, give one side an `alias(table, "name")` with a
distinct name. A foreign key declares its target as a thunk — `() => authors.id` —
whose column type must match, so a wrong reference fails at compile time.

## Transactions

`db.transaction(fn)` runs `fn` inside a single transaction — commit when the
promise resolves, rollback when it rejects. `fn` receives a `tx` that is a full
`Db` bound to the transaction's connection, so every query inside runs on the
same connection (the only correct shape on a pooled Postgres driver):

```ts
await db.transaction(async (tx) => {
  const author = await tx.insert(authors).values({ name: "Ada" }).returning().get();
  await tx.insert(posts).values({ authorId: author.id, title: "Hello" }).run();
});
```

## Batches

`db.batch([...])` runs a list of queries as **one atomic unit**: every
statement commits, or none does. Pass builders without their terminal. Each one
compiles to the same SQL that its `.all()` / `.run()` / `.returning().get()`
sends. You get one typed result per query, in order:

```ts
import { eq, rawChanges } from "@lesto/db";

const [seat, event] = await db.batch([
  db.insert(seats).values({ eventId, userId }).returning(), // the inserted row
  db.update(events).set({ status: "full" }).where(eq(events.id, eventId)), // { changes }
]);
```

A select yields its rows, `insert(…).values(…)` / `update` / `delete` yield
`{ changes }`, and `.returning()` yields the inserted row. `rawRows(sql, params)`
and `rawChanges(sql, params)` add hand-written statements to the same batch. An
empty batch resolves `[]`. Inside `db.transaction`, `tx.batch` runs in the open
transaction.

**A batch cannot branch on its own reads.** Every statement is fixed before the
batch runs, so no JavaScript runs between them. A later statement does see the
earlier writes in SQL, so move each check into the write itself:

- `INSERT … SELECT … WHERE <condition>` writes only when the condition holds.
- `UPDATE … WHERE state = ?` claims a row; `changes()` in the next statement
  tells you whether the claim landed.
- A `UNIQUE` index refuses a duplicate and rolls the whole batch back.
- A guard statement can fail on purpose. For example,
  `rawChanges("INSERT INTO guard (ok) SELECT NULL WHERE changes() = 0")` writes
  `NULL` into a `NOT NULL` column. It aborts the batch when the earlier write did
  not happen.

Cloudflare D1 sets this rule: its only atomic primitive is a batch. `db.batch`
keeps the same rule on every driver. A batch written for SQLite or Postgres
runs unchanged on D1.

### The `SqlDatabase` seam

Every driver handle implements `batch(statements)`. Each statement is
`{ sql, params, returns: "rows" | "changes" }`. The handle runs the list
atomically and resolves one result per statement. A result is
`{ returns: "rows", rows }` or `{ returns: "changes", changes }`.
`openSqlite`, the OPFS driver, `@lesto/pg` and Hyperdrive run it as one
`BEGIN`…`COMMIT` on one connection (`batchViaTransaction` from `@lesto/db` is
that shared implementation); `d1ToSqlDatabase` makes one native `d1.batch()`
call. A hand-written `SqlDatabase` must add `batch` — usually
`batch: (statements) => batchViaTransaction(handle, statements)`.

## Column builders

| Builder | Storage | JS type | Notes |
|---|---|---|---|
| `text(name)` | `TEXT` | `string` | |
| `integer(name)` | `INTEGER` | `number` | widens to `BIGINT` on Postgres |
| `real(name)` | `REAL` | `number` | |
| `boolean(name)` | `INTEGER` | `boolean` | stored `0`/`1` |
| `timestamp(name)` | `INTEGER` | `Date` | stored epoch-ms |

Modifiers: `.notNull()`, `.unique()`, `.primaryKey({ autoIncrement })`,
`.default(value)`, and `.references(() => other.col, { onDelete, onUpdate })`.
Referential actions are `cascade`, `restrict`, `set null`, and `no action`.

## Condition helpers

| Helper | SQL |
|---|---|
| `eq(col, v)` | `col = v` (or `col = otherCol` for a join `ON`) |
| `ne(col, v)` | `col <> v` |
| `gt` / `gte` / `lt` / `lte` | `>`, `>=`, `<`, `<=` |
| `like(col, pattern)` | `col LIKE pattern` (text columns only) |
| `inList(col, values)` | `col IN (…)` (empty list ⇒ matches nothing) |
| `isNull(col)` / `isNotNull(col)` | `col IS [NOT] NULL` |
| `and(...)` / `or(...)` | combine conditions |

Every value rides a `?` placeholder, so SQL injection is structurally
impossible. Terminals: `get()`, `all()`, `run()`, `count()`, and `returning()`
(insert only).

Errors are coded, not just prose: a refused operation throws a `DbError` with a
stable `DbErrorCode` such as `DB_EMPTY_INSERT`, `DB_EMPTY_UPDATE`,
`DB_UNRESOLVED_REFERENCE`, `DB_DUPLICATE_JOIN_NAMESPACE`, or
`DB_BATCH_RESULT_MISMATCH` (a driver's `batch()` broke its contract). Branch on the
`code`, never the message.

## Notes and gotchas

- **It is a query builder, not an ORM.** Query roots are single-table
  (`select().from(t)`); for multi-table reads, use a join (or `db.raw()` for SQL
  the DSL does not model).
- **`UPDATE` and `DELETE` require a `WHERE`.** There is no unbounded write.
- **Dialect via `createDb(handle, { dialect })`.** Defaults to `"sqlite"`; pass
  `"postgres"` in production. Cross-dialect parity is verified in CI against a
  real Postgres, so "SQLite local, Postgres prod, same APIs" stays literally
  true.
- **`db.raw(sql, params)` and `db.exec(sql)`** are the escape hatches for SQL
  outside the builder. `raw` binds `?` parameters and reads rows back — use it
  for row-returning statements (a `SELECT`, or a write with `RETURNING`); a
  non-returning write through `raw` throws on SQLite. `exec` runs a
  side-effecting, parameter-free statement (DDL) — and pass it **one statement
  per call**: Cloudflare D1 rejects multi-statement strings.
- **Observability via `createDb(handle, { onQuery })`.** An optional sink
  receives every executed query's SQL text and `durationMs` — values never
  appear (they ride `?` placeholders), and a throwing sink is contained.

## See also

- [Migrations](/batteries/migrations) — applying schema changes on boot.
- [Validation](/guides/validation) — validating input at the boundary before it
  reaches the data layer.
- [`examples/blog`](https://github.com/lesto-run/lesto/tree/main/examples/blog)
  is a complete, runnable app built on `@lesto/db`: a typed schema, a migration,
  and a page plus JSON API reading through the same handle.
