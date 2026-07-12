# @lesto/router

> Lesto's RESTful router — declare routes and named paths, resolve method+path to a controller#action.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/router
```

```ts
import { pathFor, RouteTable } from "@lesto/router";

const routes = new RouteTable<() => string>();
routes.add("GET", "/posts/:id", () => "show");

routes.match("GET", "/posts/3"); // { value, params: { id: "3" } }

// pathFor is the typed inverse — params encoded back into a path that round-trips.
pathFor("/posts/:id", { id: "3" }); // "/posts/3"
```

Captured params are URL-decoded at match time, so `%2F` never smuggles a path
separator, and a malformed `%` refuses with a coded `RouterError`.

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
