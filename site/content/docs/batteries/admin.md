---
title: Admin
description: A typed CRUD backbone over your tables — list, get, create, update, destroy — policy-gated per verb, with validation, field projection, and an audit hook.
section: Batteries
order: 4
---

# Admin

`@lesto/admin` is a typed CRUD backbone over your [`@lesto/db`](/batteries/data)
tables. You declare resources — a name, a table, two Zod schemas, a field
allow-list, and the permissions each verb requires — and it hands you `list` /
`get` / `create` / `update` / `destroy` with authorization, validation,
projection, pagination, and a mutation hook for auditing.

It is the generic CRUD layer a WordPress-style admin UI sits on, but it is _not_
an HTTP surface. The service is transport-agnostic: it returns plain objects and
throws coded errors, and you decide how to expose it. Reads and writes go through
`@lesto/db`; every verb is gated by a [`@lesto/authz`](/batteries/authz) policy;
input validation goes through each resource's schemas (the same boundary
discipline as [Validation](/guides/validation)); projection honors a
per-resource `fields` allow-list, so an undeclared column never leaks out of a
row.

## Define resources

A resource binds a table to its validation, projection, and permission contract.
Pass them to `createAdmin(db, resources, options)`. The `policy` option is
**required**: hand it a `@lesto/authz` policy to govern every verb, or the
explicit `{ ungoverned: true }` to opt out loudly. There is no "absent policy
means open" path — anything else throws `ADMIN_INVALID_POLICY` at construction,
so an admin is never _silently_ fail-open.

```ts
import { createAdmin } from "@lesto/admin";
import { definePolicy } from "@lesto/authz";
import { z } from "zod";

import { products } from "./schema";

const policy = definePolicy({
  roles: ["viewer", "editor"],
  can: {
    "products:read": ["viewer", "editor"],
    "products:write": ["editor"],
  },
});

const productInsertSchema = z.object({
  name: z.string().min(1, "Name is required."),
  price: z.number().int().nonnegative(),
  stock: z.number().int().nonnegative(),
  cost: z.number().int().nonnegative(), // writable, but never projected back
});

// The update schema is the insert schema with every field optional — a patch.
const productUpdateSchema = productInsertSchema.partial();

const admin = createAdmin(
  db,
  [
    {
      name: "products", // the name routes + the API address this resource by
      table: products, // the @lesto/db table it reads and writes
      insertSchema: productInsertSchema, // validated before create
      updateSchema: productUpdateSchema, // validated before update
      fields: ["name", "price", "stock"], // projection allow-list (+ the PK)
      permissions: {
        read: "products:read", // gates list + get
        create: "products:write",
        update: "products:write",
        destroy: "products:write",
      },
    },
  ],
  {
    policy, // required: a @lesto/authz Policy, or { ungoverned: true }
    onMutation: makeAuditHook(db), // fires after every committed write
  },
);
```

`cost` is a real, writable column left out of `fields` on purpose: `create` and
`update` accept it, but `list` and `get` project each row down to
`{ id, ...fields }`, so it never leaves. Projection is an allow-list, not
cosmetics. The primary key is resolved once at construction — a table with no
primary key fails _then_, not on the first request.

Governance is per-verb and fail-closed: `list` and `get` share the `read`
permission, each write names its own. A verb the resource declares no permission
for is **denied** under a governed policy — never open-by-omission.

## Use it in routes

Every verb takes an optional trailing context — the resolved principal
`{ actor, actorRoles }`. Put `@lesto/authz`'s `createPrincipalResolver` upstream
and read the principal off the request with `getPrincipal(c)`; the admin checks
`actorRoles` against the resource's permission and attributes the write to
`actor`. The admin _attributes and gates_ — it never authenticates — and the
principal resolver is the sole actor source: a governed write with no resolved
actor is refused before it commits.

```ts
import { createPrincipalResolver, getPrincipal } from "@lesto/authz";
import { lesto } from "@lesto/web";

// Resolve who is calling, once, at the edge of the chain. You supply the two
// seams: read your session, map a user id to roles.
const principalResolver = createPrincipalResolver({
  verifySession: (c) => readSession(c), // -> { userId } | undefined
  rolesOf: (userId) => rolesFor(userId), // -> Iterable<string>
});

const app = lesto()
  .use(principalResolver)
  .get("/admin/products", (c) =>
    respond(c, () => admin.list("products", { limit: 20, offset: 0 }, getPrincipal(c))),
  )
  .get("/admin/products/:id", (c) =>
    respond(c, () => admin.get("products", Number(c.param("id")), getPrincipal(c))),
  )
  .post("/admin/products", (c) =>
    // The raw body goes straight to the admin; it validates against insertSchema.
    respond(c, () => admin.create("products", c.req.body, getPrincipal(c)), 201),
  )
  .patch("/admin/products/:id", (c) => {
    const id = Number(c.param("id"));
    return respond(c, () => admin.update("products", id, c.req.body, getPrincipal(c)));
  })
  .delete("/admin/products/:id", (c) => {
    const id = Number(c.param("id"));
    return respond(c, async () => {
      await admin.destroy("products", id, getPrincipal(c));
      return { deleted: id };
    });
  });
```

Hand the admin the _raw_ body — don't re-validate at the edge. The resource owns
one validation authority and one error vocabulary; duplicating the schema at the
route just drifts.

The authorization check runs _before_ validation or any database touch, so an
unauthorized caller learns nothing about the input or whether the row exists.

## Methods

`createAdmin` returns an `Admin` — an object of async functions.

| Method | Signature | Returns |
| --- | --- | --- |
| `resources` | `resources(): ResourceSummary[]` | `{ name, fields }` for every resource (schemas + tables stay server-side) |
| `describe` | `describe(name): ResourceSummary` | The `{ name, fields }` summary for one resource |
| `list` | `list(name, options?: ListOptions, context?): Promise<Record[]>` | Projected rows `{ id, ...fields }`, ordered by PK, paginated |
| `get` | `get(name, id, context?): Promise<Record>` | One projected row, or throws `ADMIN_RECORD_NOT_FOUND` |
| `create` | `create(name, attributes, context?): Promise<Record>` | The created row, projected; fires `onMutation` |
| `update` | `update(name, id, attributes, context?): Promise<Record>` | The merged row, re-read and projected; fires `onMutation` |
| `destroy` | `destroy(name, id, context?): Promise<void>` | Nothing; fires `onMutation` |

`ListOptions` is `{ limit?, offset? }` — `limit` defaults to a page size of `50`,
`offset` to `0`. `context` is a `MutationContext` — `{ actor?, actorRoles? }`,
the principal from `getPrincipal(c)`: `actorRoles` feeds the policy check,
`actor` is passed onto the audit event. `update` re-reads the row after writing,
so the returned object reflects merged state, not just the patch you sent.

## Errors

Every refusal is an `AdminError` carrying a stable `code` — branch on the code,
never the message. The three you handle most often are `ADMIN_FORBIDDEN` (the
policy denied the verb, or a governed write arrived with no resolved actor),
`ADMIN_VALIDATION_FAILED` (a bad body, with the flattened Zod issues in
`details`), and `ADMIN_RECORD_NOT_FOUND` (no row for that id). Map them to
status at the boundary:

```ts
import { AdminError } from "@lesto/admin";

function statusForAdminError(error: AdminError): number {
  switch (error.code) {
    case "ADMIN_FORBIDDEN":
      return 403;
    case "ADMIN_UNKNOWN_RESOURCE":
    case "ADMIN_RECORD_NOT_FOUND":
      return 404;
    case "ADMIN_VALIDATION_FAILED":
    case "ADMIN_EMPTY_UPDATE":
      return 422;
    default:
      return 500; // construction-time codes: ADMIN_NO_PRIMARY_KEY, ADMIN_INVALID_POLICY
  }
}

const respond = async (c, op, okStatus = 200) => {
  try {
    return c.json(await op(), okStatus);
  } catch (error) {
    if (error instanceof AdminError) {
      return c.json(
        { error: error.code, message: error.message, details: error.details },
        statusForAdminError(error),
      );
    }
    throw error;
  }
};
```

`update` adds `ADMIN_EMPTY_UPDATE` when a validated patch sets no known column —
the admin re-codes `@lesto/db`'s `DB_EMPTY_UPDATE` into its own vocabulary so
callers never see a leaked underlying code.

## Auditing

If you injected an `onMutation` hook, it fires once _after_ each committed write
with an `AuditEvent`: `{ action, actor, resource, id, patch }`. `action` is
`"create" | "update" | "destroy"`; `actor` is the resolver-sourced actor the
caller threaded in through the context (under a governed policy an unattributed
write is refused upstream, so it never reaches the hook un-actored); `patch` is
the validated attributes for create/update and `undefined` for destroy. The admin doesn't own
a sink — it hands you the event and lets you decide where it lands. A queryable
trail is a few lines:

```ts
import type { AuditEvent } from "@lesto/admin";

function makeAuditHook(db: Db): (event: AuditEvent) => void {
  return (event) => {
    void db
      .insert(auditLog)
      .values({
        action: event.action,
        resource: event.resource,
        recordId: String(event.id), // a PK may be an int or a slug
        actor: String(event.actor), // an actor is opaque to the admin
        at: new Date().toISOString(), // the admin reports the change, not the clock
      })
      .run()
      .catch((error) => console.error("[audit] persist failed:", error));
  };
}
```

The hook signature is synchronous (`(event) => void`), and a throw would
propagate to the caller _after_ the write already committed — so keep it cheap
and total, or swallow failures inside it, as above. The write succeeded; a broken
audit sink shouldn't fail the request. Attribution is trustworthy-at-source, not
tamper-evident: the actor is real, but a durable, append-only audit store is
yours to provide.

See the runnable
[`examples/admin`](https://github.com/lesto-run/lesto/tree/main/examples/admin)
for the full wiring — routes, the audit table, and the `GET /admin/audit` trail
those writes produce.

## Where to go next

- [Authorization](/batteries/authz) — define the policy and principal resolver
  the admin is governed by.
- [Data](/batteries/data) — the tables the admin reads and writes.
- [Validation](/guides/validation) — where the Zod boundary discipline comes from.
