# @lesto/pubsub

> An in-process publish/subscribe hub — synchronous registration, awaited delivery.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/pubsub
```

```ts
import { PubSub } from "@lesto/pubsub";

const hub = new PubSub();
const off = hub.subscribe("orders", (message, channel) => {
  /* … */
});
await hub.publish("orders", { id: 1 });
off();
```

In-process only (one process). For cross-process fan-out, pair it with
`@lesto/realtime`.

**Maturity:** v0.

[Docs](https://docs.lesto.run) · [Example](../../examples/reactive)
