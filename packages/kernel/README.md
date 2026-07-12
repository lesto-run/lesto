# @lesto/kernel

> Lesto's application kernel — assembles the database, migrations, router, and controllers into one bootable app.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/kernel
```

```ts
import { createTableSql, defineTable, integer, text } from "@lesto/db";
import { lesto } from "@lesto/web";
import { createApp } from "@lesto/kernel";

const posts = defineTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
});

// Assemble db + migrations + routes into one bootable app.
const app = await createApp({
  db,
  app: lesto().get("/posts", (c) => c.json({ posts: [] })),
  migrations: [
    {
      version: "001_create_posts",
      migration: { up: (s) => s.execute(createTableSql(posts, s.dialect)) },
    },
  ],
});

await app.handle("GET", "/posts"); // migrations applied, routes live
```

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
