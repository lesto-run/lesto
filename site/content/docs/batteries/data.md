---
title: Data
description: Define typed tables, run migrations, and query across SQLite and Postgres with one type-safe builder.
section: Batteries
order: 0
---

# Data

`@lesto/db` is a typed query builder over a `SqlDatabase` handle. You define
tables as values, and inserts, selects, and joins are inferred from them — the
same builder running against SQLite in development and Postgres in production.

## Define a table

```ts
import { defineTable, integer, text, type InferRow } from "@lesto/db";

export const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull(),
});

// A row, exactly as SELECT yields it — no base class, just a type.
export type Post = InferRow<typeof posts>;
```

Columns come in five types: `text`, `integer`, `real`, `boolean`, and
`timestamp`.

## Query

`createDb(handle)` wraps a database handle in the typed `Db`. Inserts, selects,
ordering, counts, and conditions are all inferred from the table:

```ts
import { createDb, eq } from "@lesto/db";

const db = createDb(handle);

await db.insert(posts).values({ title, body, createdAt }).returning().get();

const all = await db.select().from(posts).orderBy(posts.id, "asc").all();
const one = await db.select().from(posts).where(eq(posts.id, 1)).get();
const total = await db.select().from(posts).count();
```

Conditions compose: `and`, `or`, `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`,
`inList`, `isNull`, `isNotNull`. Relational joins across tables are typed end to
end.

## Migrate

Schema changes are migrations, applied by the kernel on boot. Declare them with
`@lesto/migrate`'s `Schema` builder and hand them to your app config:

```ts
import { createApp } from "@lesto/kernel";

await createApp({ db: handle, app, migrations: [postsMigration] });
```

## See it run

[`examples/blog`](https://github.com/lesto-run/lesto/tree/main/examples/blog)
is a complete app built on `@lesto/db`: a typed schema, a migration, and a page
plus JSON API reading through the same handle.
