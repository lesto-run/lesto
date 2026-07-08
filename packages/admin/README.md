# @lesto/admin

> An admin operations layer over @lesto/db tables — the CRUD backbone for a generic admin UI.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/admin
```

```ts
import { createAdmin } from "@lesto/admin";

const admin = createAdmin(
  db,
  [
    {
      name: "posts",
      table: posts,
      insertSchema: z.object({ title: z.string().min(1), body: z.string() }),
      fields: ["title", "body"],
      permissions: { read: "posts:read", create: "posts:write" },
    },
  ],
  { policy },
);

admin.list("posts", undefined, principal);                         // checks "posts:read"
admin.create("posts", { title: "Hello", body: "..." }, principal); // checks "posts:write"
```

CRUD goes through `@lesto/db`; input is Zod-validated (ADR 0005); projection
honors the per-resource `fields` allow-list; and every verb is gated by an
injected `@lesto/authz` policy.

[Docs](https://docs.lesto.run) · [Example](../../examples/admin)
