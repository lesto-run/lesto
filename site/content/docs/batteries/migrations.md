---
title: Migrations
description: Versioned schema migrations with up/down, applied automatically on boot, rendered for SQLite and Postgres.
section: Batteries
order: 1
---

# Migrations

Schema changes are versioned migrations. `@lesto/migrate` applies the pending
ones in order, records each one as it succeeds, and renders DDL for whichever
dialect you boot against. The recorded set is the source of truth: a migration
runs exactly when its version is absent from the bookkeeping table, so the run
is idempotent and safe to repeat on every boot.

You define each table once as a [`@lesto/db`](/batteries/data) schema value and
render it for the engine you are on. There is no separate column DSL to keep in
sync — your migration imports the same table value your queries do.

## Declare a migration

A `MigrationEntry` pairs a `version` string with a `migration` that has an `up`
and (encouraged) a `down`. The `Schema` object handed to each runs DDL; the
`createTableSql` / `dropTableSql` helpers from `@lesto/db` turn a table value
into the `CREATE TABLE` / `DROP TABLE` statement. Pass `schema.dialect` through
so the table renders for the engine the migration is running against:

```ts
import { createTableSql, defineTable, dropTableSql, integer, text } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";

export const products = defineTable("products", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  price: integer("price").notNull(),
  stock: integer("stock").notNull(),
});

export const migrations: MigrationEntry[] = [
  {
    version: "001_create_products",
    migration: {
      up: (schema) => schema.execute(createTableSql(products, schema.dialect)),
      down: (schema) => schema.execute(dropTableSql(products)),
    },
  },
];
```

`schema.dialect` is read-only — it is the engine the migrator is running this
migration against (`"sqlite"` by default, `"postgres"` when you boot on
Postgres). Threading it into `createTableSql` is what lets one definition emit
the right surrogate-key form per engine; see [cross-dialect](#one-definition-both-dialects)
below.

## Beyond tables

`Schema` owns the rest of a migration's vocabulary that the value layer does
not. `addIndex` creates an index over one or more columns, defaulting to a
stable `idx_<table>_<columns>` name so repeated runs name the same index:

```ts
{
  version: "002_index_products_name",
  migration: {
    up: (schema) => schema.addIndex("products", "name"),
    down: (schema) => schema.execute("DROP INDEX idx_products_name"),
  },
},
```

`addIndex` takes `{ unique, name }`; pass `unique: true` for a `UNIQUE` index or
`name` to override the generated one. `addColumn(table, name, type, opts)` adds a
single column with the usual `{ null, unique, default }` modifiers, and
`dropTable(name)` drops one by name.

For anything the builder does not cover, `schema.execute(sql)` is the escape
hatch — it runs arbitrary SQL against the same connection:

```ts
up: (schema) => schema.execute("ALTER TABLE products ADD COLUMN sku TEXT"),
```

## Apply on boot

Hand your migrations to `createApp`. The kernel runs the pending ones before the
first request is served and reports which versions it applied on the returned
app:

```ts
import { createApp } from "@lesto/kernel";

// `web` is your composed lesto() app; `db` the driver handle it queries through.
const app = await createApp({ db, app: web, migrations });

app.migrationsApplied; // ["001_create_products", "002_index_products_name"]
```

A Postgres deploy must set `dialect: "postgres"` so the boot migrations render
Postgres DDL (and engage the advisory-lock guard that keeps a fleet from
migrating the same database twice):

```ts
await createApp({ db, app: web, migrations, dialect: "postgres" });
```

Pass the literal `"skip"` instead of an array for a fleet member that must not
migrate on boot — when one instance or a separate release step owns the
migration and the rest come up against the already-migrated schema.

## Run them yourself

`new Migrator(db, migrations)` drives the same machinery directly — handy in
scripts, seeds, and tests:

```ts
import { Migrator } from "@lesto/migrate";

const migrator = new Migrator(db, migrations);

await migrator.migrate();   // apply pending, returns the applied versions
await migrator.rollback();  // reverse the most recently applied migration
await migrator.status();    // [{ version, applied }] for every known version
```

`migrate()` returns the versions it actually applied (empty when up to date).
`rollback()` runs the latest migration's `down` and removes its record,
returning the version it reversed (or `undefined` when nothing is applied). Pass
`{ dialect: "postgres" }` as the third argument to render Postgres DDL, the same
way `createApp` does under the hood.

## One definition, both dialects

The same migration renders SQLite in dev and Postgres in prod. Identifiers,
constraints, and defaults are byte-identical across engines; only two things
fork, both driven by the `dialect` you thread through. An auto-increment primary
key spells `AUTOINCREMENT` on SQLite and `GENERATED ALWAYS AS IDENTITY` on
Postgres, and an `INTEGER` widens to `BIGINT` on Postgres so epoch-ms timestamps
and large counters never overflow its 32-bit `int4`. You write the table once;
the parity is verified in CI against both engines.

## Notes and gotchas

- **Versions order and record the run.** Migrations apply in lexicographic order
  on the `version` string — the scheme timestamped or zero-padded prefixes
  (`001_…`, `20260620_…`) are built for. Each applied version is recorded in a
  `schema_migrations` table, so re-running `migrate()` is a safe no-op for
  everything already applied.
- **`down` enables rollback.** A migration without a `down` is irreversible in
  effect, but `rollback()` still drops its record so the version is no longer
  considered applied. Always pair `createTableSql` with a `dropTableSql` `down`
  when you want a clean reverse.
- **Thread `schema.dialect`.** Forgetting it on a Postgres deploy emits
  SQLite-only DDL that Postgres rejects. When in doubt, always render with
  `createTableSql(table, schema.dialect)`.
- **One statement per `execute`.** `schema.execute(sql)` sends the string to the
  driver's `exec` verbatim. Cloudflare D1 rejects multi-statement strings, so
  issue each statement as its own `execute` call rather than joining them with
  semicolons.
- **Failure rollback differs by engine.** Each migration's DDL and its
  bookkeeping insert commit as one atomic unit. On SQLite each migration commits
  independently, so a failure keeps the earlier ones applied (Rails-style). On
  Postgres the advisory-locked run is a single transaction — a failure rolls
  back every migration in that run, and the fixed set re-applies cleanly on the
  next boot.

A complete, runnable migrations array — two tables migrated through
`createApp({ migrations })` — lives in the
[admin example](https://github.com/lesto-run/lesto/tree/main/examples/admin).
See also **[Data](/batteries/data)** for the table-definition and query layer
these migrations share.
