---
title: Authorization
description: Role-based authorization with permission grants, wildcards, and inheritance — guard routes or whole subtrees.
section: Batteries
order: 5
---

# Authorization

`@lesto/authz` is role-based access control: you declare which roles can do what,
then guard routes (or whole subtrees) with a permission.

## Define a policy

```ts
import { definePolicy, createGuard } from "@lesto/authz";

const policy = definePolicy({
  roles: ["guest", "member", "agent", "admin"],
  can: {
    "listing.read": ["guest", "member", "agent", "admin"],
    "listing.write": ["agent", "admin"],
    "admin.access": ["admin"],
  },
});

const { can, ensure } = createGuard(policy);
```

## Guard routes

`can(permission)` is middleware: it guards a single route or, used with `.use`,
an entire subtree.

```ts
app
  .use(can("admin.access"))                      // guards everything below
  .get("/api/listings/:id", can("listing.read"), show)
  .patch("/api/listings/:id", can("listing.write"), update);
```

## Wildcards & inheritance

Grants support resource wildcards and a global `*`, and roles can inherit from
one another:

```ts
const policy = definePolicy({
  roles: ["author", "editor", "admin"],
  can: {
    "posts:*": ["author"],          // any posts action
    "comments:moderate": ["editor"],
    "*": ["admin"],                 // everything
  },
  inherits: { editor: ["author"], admin: ["editor"] },
});

policy.allows(["editor"], "posts:read");   // true — inherited from author
policy.allows(["editor"], "billing:read"); // false
```

Pair this with **[Auth](/batteries/auth)** (who the user is) to enforce what they
may do.
