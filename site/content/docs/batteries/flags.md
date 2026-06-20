---
title: Feature flags
description: Define feature flags with safe defaults and dynamic resolution; gate a route or a whole subtree behind one.
section: Batteries
order: 6
---

# Feature flags

`@lesto/flags` is a small, typed feature-flag layer. You declare defaults and an
optional resolver; an off flag gates its route to a 404.

## Define flags

```ts
import { defineFlags } from "@lesto/flags";

const flags = defineFlags({
  defaults: { "new-listing-ui": false },
  // Dynamic override per request; fall back to the default by returning undefined.
  resolve: (flag, c) => (c.query("preview") === "1" ? true : undefined),
});
```

Resolution is dynamic-then-static: the resolver wins when it returns a value,
otherwise the default applies. Unknown flags are off.

## Gate routes

`flags.gate(name)` is middleware. Use it on one route, or with `.use` to hide a
whole subtree when the flag is off:

```ts
app
  .use(flags.gate("beta"))                              // hides everything below when off
  .get("/api/new", flags.gate("new-listing-ui"), handler);
```

An off flag returns a 404 by default, so a half-built feature is simply not there
until you turn it on.
