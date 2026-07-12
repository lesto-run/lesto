# @lesto/web

> Lesto's MVC request-handling core — a Rails-style controller layer that weds @lesto/router and @lesto/ui.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/web
```

```ts
import { lesto } from "@lesto/web";

// Code-first routing + page rendering over one typed app object.
const app = lesto()
  .get("/posts/:id", (c) => c.json({ id: c.param("id") }))
  .page("/posts/:id", { load, component: PostScene });

// Pure request handling — no socket required (the transport tier is @lesto/runtime).
await app.handle("GET", "/posts/3"); // { status: 200, body: '{"id":"3"}', ... }
```

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
