---
title: Authorization
description: Role-based authorization with permission grants, wildcards, and inheritance — guard routes or whole subtrees.
section: Batteries
order: 5
---

# Authorization

`@lesto/authz` answers one question — *may this subject do this thing?* — from one
declaration. You name the roles your app knows, map each permission to the roles
that hold it, and then guard routes (or whole subtrees) with a permission. There
is no `if (user.isAdmin)` scattered across handlers: the authorization surface
lives in a single policy you can read, review, and audit at a glance.

Authorization is about *what a subject may do*. It pairs with
**[Auth](/batteries/auth)**, which establishes *who the subject is* — the auth
layer identifies the user; this layer decides what that user is allowed to do.

## Define a policy

A policy is a closed vocabulary of `roles` plus a `can` map from each permission
to the roles that grant it:

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

`definePolicy` validates at declaration time. If a grant names a role that is not
in the `roles` vocabulary, it throws an `AuthzError` with code
`AUTHZ_UNKNOWN_ROLE` — a misspelled grantee that would otherwise silently grant
nothing fails loudly instead, at startup rather than in production.

`createGuard(policy)` binds the policy to a way of reading the current subject's
roles and returns `{ can, ensure }`. By default the guard reads the subject's
roles from the `"roles"` context variable that an upstream auth middleware sets —
so this package never couples to a specific user model. Your app maps its user to
a role list however it likes and stashes it with `c.set("roles", […])`. (Need a
different source? Pass `rolesOf` in `GuardOptions`.)

## Guard routes

`can(permission)` is Lesto middleware. Drop it on a single route to guard that
endpoint, or pass it to `.use` to guard everything below it:

```ts
app
  .use(can("admin.access"))                      // guards the whole subtree below
  .get("/api/listings/:id", can("listing.read"), show)
  .patch("/api/listings/:id", can("listing.write"), update);
```

When the subject holds the permission, the guard calls `next()` and the request
proceeds. When it does not, the guard short-circuits and answers **`403
Forbidden`** (a `text/plain` body of `"Forbidden"`) — the handler never runs. It
is a 403, not a 404: the request was understood and refused, not lost.

Two seams let you adjust that refusal without rewriting the guard, via the
optional second argument to `createGuard`:

```ts
const { can } = createGuard(policy, {
  // Replace the response — e.g. redirect a browser to a login page.
  onDeny: (c, permission) => ({ status: 302, headers: { location: "/login" }, body: "" }),
  // Observe every refusal (logging, metrics, OTLP) without changing the response.
  onDenied: (kind, req) => log.warn({ kind, path: req.url }),
});
```

`onDeny` *builds* the response; `onDenied` only *watches* — the refusal is
identical whether or not it is wired.

## ensure(): the imperative check

Route middleware guards by permission alone. For a row-level decision inside a
handler — *can this user edit **this** listing?* — use `ensure`, which has the
signature `ensure(c, permission)` and returns a **`boolean`**:

```ts
async function update(c) {
  if (!ensure(c, "listing.write")) {
    return { status: 403, body: "Forbidden" };
  }

  const listing = await listings.find(c.params.id);

  // Combine the permission check with a record-level rule.
  if (listing.ownerId !== c.get("userId") && !ensure(c, "admin.access")) {
    return { status: 403, body: "Forbidden" };
  }

  return saveListing(listing, await c.body());
}
```

`ensure` does not throw and does not send a response — it returns `true` or
`false` and leaves the decision to you. It reads the subject's roles the same way
`can` does (the same `rolesOf`), so it stays consistent with your route guards.

## Wildcards & inheritance

Grants do not have to be exact. A `can` grant may name a **resource wildcard**
(`"posts:*"`, covering every action that shares the `"posts:"` prefix) or the
**global wildcard** (`"*"`, covering everything). And a role may `inherits` other
roles, so a subject holding a child role holds everything its parents grant,
resolved transitively. (The requested permission is always concrete — only the
*grant* may widen.)

```ts
const policy = definePolicy({
  roles: ["author", "editor", "admin"],
  can: {
    "posts:*": ["author"],          // any action in the posts resource
    "comments:moderate": ["editor"],
    "*": ["admin"],                 // everything
  },
  inherits: { editor: ["author"], admin: ["editor"] },
});

policy.allows(["editor"], "posts:read");       // true  — posts:* via inherited author
policy.allows(["editor"], "comments:moderate"); // true  — editor's own grant
policy.allows(["editor"], "billing:read");     // false — no grant covers it
policy.allows(["admin"], "billing:read");      // true  — the global * grant
policy.allows([], "posts:read");               // false — no roles, no grants
```

`policy.allows(subjectRoles, permission)` is the oracle the guard consults; it is
public, so you can call it directly when you have roles in hand without a request
context. Inheritance is cycle-safe — an `admin → staff → admin` loop terminates
rather than recursing — and each role's resolved grant set is computed once and
memoized, so a check is a membership walk, not a fresh traversal per request.

## Notes & gotchas

- **Deny by default.** A subject with no roles (or `undefined` roles) is refused,
  and so is any permission that no role was granted. Access is something you
  declare, never something you forget to deny.
- **Stale role data fails closed.** Unknown role names in a subject's roles
  contribute nothing — they are skipped, never an error — so a check against
  outdated roles denies rather than crashes.
- **Typos fail fast.** A grant or `inherits` edge naming an undeclared role
  throws `AUTHZ_UNKNOWN_ROLE` at `definePolicy` time, not at request time.
- **The guard does not authenticate.** It only reads roles from context. Put an
  auth middleware *upstream* that sets `c.set("roles", …)`; see
  **[Auth](/batteries/auth)** for establishing who the subject is.
