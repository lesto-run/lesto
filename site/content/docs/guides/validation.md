---
title: Validation
description: Validate input at the boundary with Zod — request bodies, params, and per-resource schemas — so the model layer never sees bad data.
section: Guides
order: 1
---

# Validation

Lesto validates at the **boundary** with [Zod](https://zod.dev) (ADR 0005): the
HTTP body, the query string, the admin surface. The model layer never validates —
once a value is past the edge, its shape is already proven, so every helper
downstream can trust its types. A handler that writes `c.req.body as { title:
string }` has a cast, not a check: a supplied `{ title: 1234 }` would crash the
handler rather than return a 4xx. The job of this guide is to close that gap in
the three places untrusted input enters.

## Request bodies

`validateBody(schema, request)` runs a Zod schema against the decoded body and
either returns the parsed, typed value — everything past this point is trusted —
or throws a coded `WEB_VALIDATION_FAILED`, which the shared error boundary maps
to **422 Unprocessable Entity** on both the node and edge runtimes:

```ts
import { lesto, validateBody } from "@lesto/web";
import { z } from "zod";

const NewPost = z.object({
  title: z.string().trim().min(1, "Title is required."),
  body: z.string().trim().min(1, "Body is required."),
});

export const app = lesto().post("/api/posts", async (c) => {
  // Typed `{ title: string; body: string }` — or a thrown WEB_VALIDATION_FAILED.
  const input = validateBody(NewPost, c.req);
  const post = await createPost(db, input); // a typed helper; it never re-checks
  return c.json({ post }, 201);
});
```

`insertPost` / `createPost` stay plain typed helpers — they need no internal
validation, because the boundary already proved the shape.

### Mapping the error to a 422

The thrown `WebError` carries the Zod issues on `details.issues`, so a caller
that wants field-level reporting can branch on the **code**, not the message:

```ts
import { statusForError, WebError } from "@lesto/web";

try {
  const input = validateBody(NewPost, c.req);
  // ...
} catch (error) {
  if (error instanceof WebError && error.code === "WEB_VALIDATION_FAILED") {
    // `details.issues` is the array of Zod issues — render them per field.
    return c.json({ error: error.code, issues: error.details?.issues }, 422);
  }
  throw error;
}
```

You rarely need this in practice: leave the error unhandled and the app's error
boundary calls `statusForError` for you, answering a generic **422** with no
internals leaked. Catch it only when you want to shape the field-level body
yourself. (If you prefer the explicit form, skip the helper and `safeParse`
directly, returning `parsed.error.flatten()` — see ADR 0005.)

## Params and query strings

A page validates its query string by declaring a `params` Zod schema on its
`PageDef`. The renderer parses `c.req.query` against it **before any work runs**;
a malformed query is answered with a **400** before `load` is ever called, and the
parsed value is stashed for the loader to read with `c.get("params")`:

```ts
import { lesto } from "@lesto/web";
import { z } from "zod";

const ListParams = z.object({
  page: z.coerce.number().int().min(1).default(1),
  tag: z.string().optional(),
});

export const app = lesto().page("/posts", {
  params: ListParams,
  load: (c) => {
    // Already validated + coerced: `page` is a number, never the raw string.
    const { page, tag } = c.get<z.infer<typeof ListParams>>("params");
    return { posts: listPosts(db, { page, tag }) };
  },
  component: PostsScene,
});
```

Path params arrive as strings from the router, so coerce them at the seam the
same way — `z.coerce.number()` turns `:id` into a number, and a non-numeric
segment fails the schema rather than reaching your query as `NaN`. See
**[Routing & pages](/guides/routing)** for how `params` fits the page contract.

## Per-resource schemas (admin)

The admin layer owns its own validation: each resource declares an
`insertSchema` and an `updateSchema`, passed once to `createAdmin`. From then on,
`admin.create` / `admin.update` parse the body against them before any write,
raising the coded `ADMIN_VALIDATION_FAILED` on a miss — so the routes hand the
**raw** request body straight to the admin and never re-validate at the edge:

```ts
// schema.ts — the resource's validation contract
export const productInsertSchema = z.object({
  name: z.string().min(1, "Name is required."),
  price: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
  cost: z.number().int().nonnegative(),
});

// the update schema — every field optional, the usual "patch" shape
export const productUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  price: z.number().int().nonnegative().optional(),
  stock: z.number().int().nonnegative().optional(),
  cost: z.number().int().nonnegative().optional(),
});

const admin = createAdmin(db, [
  {
    name: "products",
    table: products,
    insertSchema: productInsertSchema,
    updateSchema: productUpdateSchema,
    fields: ["name", "price", "stock"],
  },
]);
```

The host maps the one `ADMIN_VALIDATION_FAILED` code to a 422 and passes the body
through untouched — one validation authority, one error vocabulary:

```ts
.post("/admin/products", (c) =>
  // The admin validates `c.req.body` against `productInsertSchema` itself.
  respond(c, () => admin.create("products", c.req.body, { actor }), 201),
);
```

See **[Admin](/batteries/admin)** for the full panel, and the runnable
[`examples/admin`](https://github.com/lesto-run/lesto/tree/main/examples/admin)
for these schemas wired end to end.

## Notes

- **Validate at the boundary, once.** Validation is the *first* thing untrusted
  input meets and the *only* place it meets it. The model layer — `@lesto/db`
  rows, `insertPost(db, input)` helpers — never validates, because the edge
  already proved the shape. Tables describe storage shape (`NOT NULL`,
  `UNIQUE`); semantic rules (length, format, business logic) are the input
  schema's job. Two values, two concerns, deliberately uncoupled.

- **Branch on the code, not the message.** Each surface raises a stable coded
  error — `WEB_VALIDATION_FAILED` (mapped to 422), a page's `params` failure
  (400), `ADMIN_VALIDATION_FAILED` (422). Match on `error.code`, never on the
  human-readable message, which is free to change. The Zod issues ride on the
  error's `details` for callers that want field-level reporting.

- **Schemas live with their consumer.** Each schema is colocated with the
  surface that owns it — `@lesto/web` for HTTP, `@lesto/admin` for the admin
  resource — so swapping a rule (or, someday, Zod itself) is a per-package change
  with no thread running through the data layer.
</content>
