## ADR 0004 — Data layer style: away from ActiveRecord, toward Drizzle-shaped

- **Status:** Accepted — **all phases complete** (2026-06-09)
- **Date:** 2026-06-09
- **Deciders:** tech lead + owner
- **Implementation note (2026-06-09):** Phase A shipped `packages/db` (`defineTable`, typed columns, `createDb`, conditions, DDL — 31 tests, 100% cov). Phase B migrated `packages/identity` off `@keel/orm` (`User extends Model` and the global `useDatabase` are gone from identity; the service takes an explicit `db: Db`, the schema is a value (`users`) backing both queries and the migration's DDL, helpers are camelCase functions taking explicit `db`). Phase C.1 migrated `@keel/mailing-lists` to `@keel/db` (`List`/`Subscriber` rows replace the Model classes; `createMailingLists({ db, mailer, token? })` is the new closure-factory; `mailingListsMigration` ships with the package — consumers no longer hand-roll the CREATE TABLE; 9 tests, 100% cov, no @keel/db API growth needed). Identity + mailing-lists both dropped `@keel/orm` from their deps.

**Scout finding (Phase C):** `@keel/content-store` and `@keel/queue` were *expected* to need migration but already talk raw `SqlDatabase` and never imported `@keel/orm` — they need no work. The real Phase C consumers are `@keel/mailing-lists` (done), `examples/blog` (needs `.orderBy/.limit/.offset` added to `@keel/db`), and `packages/admin` (the meta-introspection consumer — forces the validation-as-boundary decision, ADR 0005 candidate).

**Phase C.2 shipped (2026-06-09):** `@keel/db` grew `.orderBy(column, direction?)`, `.limit(n)`, `.offset(n)`, and `.count()` as an immutable chain on a new `SelectQuery<T>` type. Modifiers are last-wins; `.get()` always uses `LIMIT 1` regardless of user `.limit`; `.count()` honors `WHERE` but ignores `orderBy`/`limit`/`offset` (a limited count is almost always a bug). SQLite quirk: `OFFSET` without `LIMIT` emits `LIMIT -1 OFFSET n` so the offset still applies. 42 tests, 100% lines/branches/functions/statements.

**Phase C.3 shipped (2026-06-09):** `examples/blog` migrated. `posts` is a `defineTable` value; `Post = InferRow<typeof posts>` (plain row); `insertPost` / `listPosts` / `countPosts` take explicit `db`; `postsMigration` ships in the same module as the table (deleted the standalone `migrations.ts`). The controller is `buildControllers(db)` (factory pattern, matches identity + mailing-lists). The `static validations` rule (title presence) became a one-line check in `insertPost` — full validation story is deferred to ADR 0005. Blog runs end-to-end (`bun run examples/blog/run.ts`) — boot, seed, dispatch HTML page + JSON API all green. Used the new `.orderBy(posts.id, "asc")` verb directly. Dropped `@keel/orm` from the deps.

**Phase C complete on the consumer side.** Remaining: `packages/admin` (forces ADR 0005 — validation), and Phase D (delete `kernel.useDatabase`, mark `@keel/orm` legacy, update `create-keel` templates).

**Phase C.4 shipped (2026-06-09):** `@keel/admin` migrated. The resource shape `{ name, table, insertSchema, updateSchema, fields }` from ADR 0005 became real: tables come from `@keel/db`, schemas from Zod. `createAdmin(db, resources)` is the closure factory. Primary-key resolution happens at construction (a missing PK fails *now*, not on the first request) via `table.columnList.find(c => c.spec.primaryKey)` — works for both `id`/autoIncrement and natural keys (slug). Validation surfaces as `ADMIN_VALIDATION_FAILED` carrying Zod's `flatten()`-ed error. Update/destroy do a pre-fetch so absent-row is `ADMIN_RECORD_NOT_FOUND` rather than a silent zero-changes write. Dropped `@keel/orm` from admin's deps. 17 tests, 100% lines/branches/functions/statements.

**Phase C complete.** Phase D (kernel cleanup + `@keel/orm` deprecation + `create-keel` templates) is now unblocked.

**Phase D shipped (2026-06-09):** the cleanup pass. `kernel.useDatabase(config.db)` is gone (zero in-tree orm consumers were left, so the call was dead); the kernel rewrote its boot doc and dropped `@keel/orm` from its deps. The kernel test, plus the cli and mcp test fixtures, all moved from `extends Model` + global `useDatabase`/`resetConnection` ceremony to local `defineTable` + an explicit `Db` from `createDb`. `@keel/orm` itself is marked **LEGACY** — its `index.ts` JSDoc and its `package.json` description both point at `@keel/db` for new code, and the package stays in the workspace unchanged for any out-of-tree app that still depends on it. The `create-keel` scaffold now emits `defineTable` + `createDb` + `zod` (the canonical post-ADR-0004 shape), not `extends Model`. Zero in-tree imports of `@keel/orm` remain.

**ADR 0004 is fully realized.** `@keel/db` is the data layer; `@keel/orm` is preserved for back-compat with no path forward for new in-tree work.

## Context

Keel's brand promise is "Rails+Laravel+WordPress+Next, best-of." On the
*batteries*-included framing (auth as a real battery, queue as a real battery,
content as a real battery), the Rails reference is load-bearing — that is the
whole reason `@keel/identity` ships and Next.js does not.

On the *data layer specifically*, we have copied the Rails shape too directly.
Today `@keel/orm` is ActiveRecord:

- `class User extends Model` — inheritance carries query/persistence/validation
  surface onto every domain class.
- Global connection — `useDatabase(db)` sets module-scoped state; `Model`
  reaches for it implicitly through `database()`.
- Hash-of-attributes — `User.create({ password_hash: "…", email_verified_at: null })`
  with snake_case keys, the column name is the API.
- Weak return types — `User.findBy({ email })` typechecks as `User | undefined`
  *because of a TS overload*, but `where({ email })` returns rows shaped
  by `Attributes` (a string→unknown map), not by the model's columns. The
  inference is one level deep.

`@keel/migrate` mirrors the same convention: a small builder DSL whose output
is *only* DDL, no shared schema artifact the query side can introspect. So the
columns in a migration and the columns the ORM allows are two parallel string
lists that must be kept consistent by the human writing them.

This shape leaks downstream every time. In `@keel/identity` I had to:

- Cast the result of `User.findBy({email})` to `User | undefined` initially
  (the inferred type was `Model`).
- Write the column names twice — once in the migration's table builder, once
  in `static columns = [...]` on the model.
- Reach attributes via `this.get("password_hash") as string`, because the
  model has no typed view of its own columns.
- Reason about a singleton DB connection in tests (every test file gets a
  fresh worker, but inside one file `useDatabase` is process-global and order
  matters).

The JS-native pattern Drizzle (and prisma's recent direction, and kysely) has
landed on is the opposite shape:

```ts
// schema.ts — one declaration, the source of truth for shape AND query types
export const users = sqliteTable("users", {
  id: integer().primaryKey({ autoIncrement: true }),
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  emailVerifiedAt: text(),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});
export type User = InferSelectModel<typeof users>;

// query — explicit db, typed columns, no inheritance, no global
const user = await db.select().from(users).where(eq(users.email, email)).get();
```

No magic inflection, no implicit connection, no string columns, no `extends`.
Every column reference is the typed column object; the inferred row type is
correct without a cast.

## Decision

**Shift `@keel/orm` from ActiveRecord toward a Drizzle-shaped schema-and-query
layer over the next phase. Pass the database explicitly. Make the schema the
single source of truth for both DDL and query types.**

The brand-level "batteries-included, conventions-over-configuration" stance is
unchanged. The change is **where the convention lives**: Drizzle is *also*
convention-over-configuration — the convention is just expressed in TypeScript
types, not in inherited class behavior and runtime metaprogramming.

### What changes

| | Today (Rails-y) | Target (JS-y, Drizzle-shaped) |
|---|---|---|
| **Schema** | Migration DSL emits DDL; model declares `columns = [...]` separately | One `defineTable(...)` whose value backs both `CREATE TABLE` and query types |
| **Connection** | Global `useDatabase(db)`; models look it up implicitly | `db` is a function argument — to every query function, every service factory |
| **Receiver** | `class User extends Model` (inheritance) | `users` is a value (table object); rows are plain objects with inferred types |
| **Query** | `User.where({ email }).first()` | `db.select().from(users).where(eq(users.email, x)).get()` |
| **Field case** | snake_case throughout (`password_hash`) | camelCase in TS, snake_case in DB via column rename |
| **Validation** | `static validations = { … }` on the model | Functions over typed inputs; Zod/Valibot at boundaries, not on the model |
| **Migrations** | `up(schema)` / `down(schema)` classes; column list duplicated | Snapshot-diff against the schema value (Drizzle Kit pattern); or hand-written migrations that *import* the schema value |

### What stays Rails-ish

- **Batteries-included assembly.** `@keel/identity`, `@keel/queue`, `@keel/mail`
  still ship turnkey. The change is internal plumbing — the caller still gets
  a one-call `createIdentity({...})`.
- **Convention defaults.** Auto `id`, auto `createdAt`/`updatedAt`, sensible
  index naming — kept, but expressed in the schema builder, not the inflector.
- **The "one substrate" thesis.** Users in *your* DB, joined naturally to RBAC
  and content — unchanged. This ADR is about *how* you reach that DB.

### Where this differs from a literal Drizzle adoption

We may or may not depend on Drizzle directly. The interesting bet is the
*shape* — schema-as-value, typed columns, explicit db — not the package.
Reasons to write our own thin layer instead of importing Drizzle:

- Keep the dependency surface small (Keel ships a lot of packages; one
  query-layer dep that pulls a query-builder + a Kit + driver-specific dialect
  modules is a meaningful weight).
- Maintain freedom on the agent-native angle (MCP-exposed schema introspection,
  Studio writing rows) which is a Keel-specific concern Drizzle doesn't have
  reason to optimize for.
- Avoid being on the receiving end of Drizzle's future API churn.

But this is a secondary question. The primary decision is the *shape*.

## Migration plan (sketch — not committed)

Cannot rewrite `@keel/orm` in a single PR; every package depending on `Model`
(identity, content-store, queue) would break together. The path is:

1. **Phase A — build the new shape alongside.** New package `@keel/db` (or
   `@keel/schema` + `@keel/query`) that ships `defineTable`, the typed query
   builder, and explicit-db functions. No consumers yet. New packages may
   adopt it immediately.
2. **Phase B — migrate one consumer.** `@keel/identity` is the smallest and
   newest; flip it to the new shape, prove the journey end-to-end again. This
   is the load-bearing test of the design.
3. **Phase C — migrate content-store + queue.** These are bigger; each
   gets its own slice. `@keel/orm` keeps working throughout.
4. **Phase D — deprecate `@keel/orm`, mark `Model` as legacy.** Once the
   in-repo consumers are all off it. Existing apps depending on it keep
   working until a major version cut.

A migration is reversible at every phase boundary — if Phase B lands and we
hate it, the new package gets archived and life continues.

## Non-goals

- **Replacing `@keel/migrate` outright.** The schema-builder DSL is fine; what
  changes is that migrations *import* the schema value rather than restating
  column names. The Migrator's recording/rollback machinery is unaffected.
- **An async API rewrite.** The synchronous `SqlDatabase` shape is a known
  block on Postgres (see [[keel-maturity-reality]]); it deserves its own ADR
  and is *not* this ADR's scope.
- **Throwing out the batteries-included brand.** Keel is not becoming a
  "bring your own ORM" framework. The data layer is still in the box.

## Consequences

- The data layer becomes idiomatic TypeScript. New contributors familiar with
  Drizzle / Prisma / Next.js conventions land immediately; today they hit
  Ruby muscle memory.
- The schema is checkable: an unknown column is a TypeScript error, not a
  runtime SQL error.
- Explicit `db` threading clears the global; tests stop racing on
  `useDatabase` order.
- The MCP/agent surface gets cleaner: agents can read the schema value
  directly to know what columns exist, no need to introspect a class.
- Cost: a real migration effort across content-store, queue, identity, and
  the kernel boot path. Phased, but real.
