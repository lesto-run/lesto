## ADR 0004 — Data layer style: away from ActiveRecord, toward Drizzle-shaped

- **Status:** Proposed (planning only — not implemented)
- **Date:** 2026-06-09
- **Deciders:** tech lead + owner

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
