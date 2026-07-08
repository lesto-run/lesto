# @lesto/flags

> First-class feature flags — gate a route or page; an off flag is a 404.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/flags
```

```ts
import { defineFlags } from "@lesto/flags";

const flags = defineFlags({
  defaults: { "new-listing-ui": false },
  resolve: (flag, c) => (c.query("preview") === "1" ? true : undefined),
});

app
  .use(flags.gate("beta"))                       // hides a whole subtree when off
  .get("/api/new", flags.gate("new-listing-ui"), handler);
```

Resolution is dynamic-then-static, and an off flag is a **404** — the feature
simply doesn't exist to a client. An unknown flag is off.

[Docs](https://docs.lesto.run) · [Example](../../examples/flags)
