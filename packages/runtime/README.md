# @lesto/runtime

> Lesto's transport tier — the node:http server that serves a Lesto app, plus a queue-worker runner.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/runtime
```

```ts
import { serve, runWorker } from "@lesto/runtime";

// Stand a real node:http server in front of an assembled app.
const server = await serve(app, { port: 0 });
// server.port is the bound port; await server.close() to stop.

// The other long-lived process: a queue-worker runner.
const worker = runWorker(queue, { concurrency: 4 });
// on SIGTERM: await worker.stop(); // graceful drain
```

[Docs](https://docs.lesto.run) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
