---
title: Migrations
description: Versioned schema migrations with up/down, applied automatically on boot, rendered for SQLite and Postgres.
section: Batteries
order: 1
---

# Migrations

Schema changes are versioned migrations. `@lesto/migrate` applies pending ones in
order, records what ran, and renders DDL for whichever dialect you boot on.

## Declare a migration

A migration has a `version` and an `up` (and optionally a `down`). The `Schema`
builder runs DDL — including the `createTableSql` / `dropTableSql` derived from a
`@lesto/db` table:

```ts
import { createTableSql, dropTableSql } from "@lesto/db";
import type { MigrationEntry } from "@lesto/migrate";

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

## Apply on boot

Hand the migrations to `createApp`; the kernel runs the pending ones before the
first request and returns which versions it applied:

```ts
await createApp({ db: handle, app, migrations });
```

## Run them yourself

`new Migrator(db, migrations)` drives the same machinery directly — handy in
scripts and tests:

```ts
import { Migrator } from "@lesto/migrate";

const migrator = new Migrator(db, migrations);
await migrator.migrate();   // apply pending, return applied versions
await migrator.rollback();  // reverse the most recent
```

Migrations render DDL for both SQLite and Postgres from one definition, so the
same schema travels from a local file to a managed database unchanged. See
**[Data](/batteries/data)**.
