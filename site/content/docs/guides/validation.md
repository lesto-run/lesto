---
title: Validation
description: Validate input at the boundary with Zod — request bodies, params, and per-resource schemas — so the model layer never sees bad data.
section: Guides
order: 1
---

# Validation

Lesto validates at the **boundary** with [Zod](https://zod.dev) (ADR 0005): the
HTTP body, the params, the admin surface. The model layer never validates —
anything past the edge is already well-formed.

## Request bodies

`validateBody` parses a request body against a schema, raising a coded
`WEB_VALIDATION_FAILED` (with the Zod issues) on a mismatch:

```ts
import { validateBody } from "@lesto/web";
import { z } from "zod";

const newPost = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

app.post("/api/posts", async (c) => {
  const input = validateBody(newPost, c.req); // throws WEB_VALIDATION_FAILED on bad input
  return c.json(await createPost(db, input), 201);
});
```

## Per-resource schemas

The admin layer owns its own validation: each resource declares an `insertSchema`
and `updateSchema`, and `create` / `update` validate against them before touching
the database (raising `ADMIN_VALIDATION_FAILED`):

```ts
const productInsert = z.object({
  name: z.string().min(1, "Name is required."),
  price: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
});
```

See **[Admin](/batteries/admin)** for where these schemas plug in.

## Why the boundary

Validation lives with the package that owns the edge — `@lesto/web` for HTTP,
`@lesto/admin` for the admin surface — so a value is checked exactly once, where
it enters, and every layer downstream can trust its types.
