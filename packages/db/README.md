# @lesto/db

> Lesto's schema-and-query layer — a Drizzle-shaped, typed query DSL over the minimal SQL surface, with the schema as the single source of truth for both DDL and query types.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/db
```

```ts
import { createDb, defineTable, eq, integer, text } from "@lesto/db";

// The schema value is the single source of truth for both DDL and query types.
export const users = defineTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
});

const db = createDb(sqlAdapter);

// `users.email` is the typed column reference — `eq(users.email, 1)` is a type error.
const user = await db.select().from(users).where(eq(users.email, "ada@example.com")).get();
```

[Docs](https://docs.lesto.run/batteries/data) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
