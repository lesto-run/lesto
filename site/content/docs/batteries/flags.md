---
title: Feature flags
description: Define feature flags with safe defaults and dynamic resolution; gate a route or a whole subtree behind one.
section: Batteries
order: 6
---

# Feature flags

`@lesto/flags` is a small, typed feature-flag layer. You declare a set of flags
with safe static defaults and an optional dynamic resolver, then gate routes
behind them. The design leans on one idea: an off flag means the feature simply
isn't there. By default a gated-off route answers `404`, so a half-built feature
doesn't advertise its own existence — it reads exactly like a path you never
wrote.

## Define flags

`defineFlags` takes a `defaults` map and an optional `resolve` function, and
returns a `Flags` object you reuse across the app:

```ts
import { defineFlags } from "@lesto/flags";

const flags = defineFlags({
  // Static on/off, the safe baseline.
  defaults: { "new-listing-ui": false, beta: false },
  // Dynamic override per request; return undefined to defer to the default.
  resolve: (flag, c) => (c.query("preview") === "1" ? true : undefined),
});
```

`resolve(flag, c)` runs first on every check. It receives the flag name and the
request [`Context`](/guides/routing), so it can read a query string, a session,
a tenant — anywhere a per-user or per-tenant rollout lives. Return `true` or
`false` to decide, or `undefined` to fall through to the static default. The
resolver is where dynamic behaviour belongs; `defaults` is the floor it lands on.

Resolution is therefore **dynamic-then-static**: a defined resolver result wins,
otherwise the `defaults` entry applies, otherwise the flag is off. An unknown
flag — one with no default and no resolver decision — is off. That includes
names that collide with built-in object members (`"toString"`, `"constructor"`,
`"__proto__"`); the lookup is own-property only, so off-by-default holds.

## Gate routes

`flags.gate(name)` is plain middleware. Drop it on a single route, or mount it
with `.use` to hide an entire subtree when the flag is off:

```ts
app
  .use(flags.gate("beta")) // hides everything below when "beta" is off
  .get("/api/new", flags.gate("new-listing-ui"), handler);
```

Because it's ordinary middleware, it composes like any other guard — chain it
with auth, validation, or your own handlers in the same route definition. When
the flag is on, the gate calls `next()` and the request proceeds untouched. When
it's off, the gate short-circuits and returns the disabled response without ever
reaching your handler.

`gate` is variadic: pass several flags and **every** one must be on for the route
to pass, so any single off flag closes it:

```ts
app.get("/api/preview", flags.gate("beta", "new-listing-ui"), handler);
```

### What an off flag returns

By default a gated-off route returns a bare `404` (`Not Found`, `text/plain`) —
indistinguishable from an unrouted path. If you'd rather steer the request
somewhere, supply `onDisabled`:

```ts
const flags = defineFlags({
  defaults: { go: false },
  onDisabled: (c, flag) => c.redirect("/waitlist", 303),
});
```

`onDisabled(c, flag)` receives the context and the name of the off flag, and
returns the response to send instead of the `404`. Use it for a waitlist
redirect or a "coming soon" page; leave it off and the feature stays invisible.

## Reading a flag in a handler

Gating is the common path, but sometimes you want to branch on a flag rather than
hide a route — render one layout vs. another, include an extra field, skip a slow
code path. Use `flags.enabled(name, c)`, which returns a plain boolean using the
same dynamic-then-static resolution as the gate:

```ts
app.get("/listings", (c) => {
  if (flags.enabled("new-listing-ui", c)) {
    return c.render(<NewListings />);
  }
  return c.render(<Listings />);
});
```

`enabled` never throws and never short-circuits the request — it's just a
question you ask. `gate(name)` is built on top of it: the gate is `enabled(name,
c)` plus "and if not, return the disabled response."

## Notes and gotchas

- **Dynamic beats static.** `resolve` is consulted before `defaults`. To let a
  flag fall through to its default for a given request, return `undefined` from
  the resolver — returning `false` actively turns it off.
- **An off flag isn't there.** The default gate response is a `404`, not a `403`.
  This is deliberate: a `403` confirms the feature exists; a `404` doesn't. Reach
  for `onDisabled` only when you genuinely want a visible "not yet" state.
- **All flags must pass.** `gate("a", "b")` requires both. There's no "any-of"
  built in — compose two routes, or branch with `enabled`, if you need it.
- **Unknown is off.** A flag with no default and no resolver decision reads as
  off, so a typo in a flag name fails closed rather than silently opening a route.

For how `.use`, route mounting, and the request `Context` work, see
[Routing & pages](/guides/routing).
