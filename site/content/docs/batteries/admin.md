---
title: Admin
description: A typed CRUD backbone over your tables — list, get, create, update, destroy — with validation, field projection, and an audit hook.
section: Batteries
order: 4
---

# Admin

`@lesto/admin` is a CRUD service over your `@lesto/db` tables. You declare
resources; it gives you typed `list` / `get` / `create` / `update` / `destroy`
with validation, a field allow-list, and a mutation hook for auditing.

## Define resources

```ts
import { createAdmin } from "@lesto/admin";

const admin = createAdmin(
  db,
  [
    {
      name: "products",
      table: products,
      insertSchema: productInsertSchema,  // validated on create
      updateSchema: productUpdateSchema,  // validated on update
      fields: ["name", "price", "stock"], // projection allow-list
    },
  ],
  { onMutation: makeAuditHook(db) },       // fires on every create/update/destroy
);
```

## Use it in routes

The service is transport-agnostic — wire it into whatever routes you like:

```ts
app
  .get("/admin/products", async (c) =>
    c.json({ rows: await admin.list("products", { limit: 20, offset: 0 }) }),
  )
  .post("/admin/products", (c) =>
    c.json(await admin.create("products", c.req.body, { actor: "admin" }), 201),
  )
  .patch("/admin/products/:id", (c) =>
    c.json(await admin.update("products", Number(c.param("id")), c.req.body, { actor: "admin" })),
  );
```

Bad input raises a coded `ADMIN_VALIDATION_FAILED`; a missing row,
`ADMIN_RECORD_NOT_FOUND` — map them to status codes at the boundary. The
`onMutation` hook receives every change, so an audit log is a few lines. See the
runnable [`examples/admin`](https://github.com/lesto-run/lesto/tree/main/examples/admin).
