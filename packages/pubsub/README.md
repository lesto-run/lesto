# @lesto/pubsub

> Lesto's pub/sub + transport-neutral WebSocket fan-out core: an in-process hub, the
> `fanout()` send policy (with backpressure), a bounded replay-ring eviction helper, and
> signed per-channel capability tokens.

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

`publish` resolves only once every listener — sync and async — has settled,
with a `PublishResult`: `{ delivered, failed }`. `delivered` is the count of
listeners that ran without throwing; `failed` collects the errors from the
ones that threw or rejected, in delivery order, so one dead listener never
aborts delivery to the rest (the same isolation `fanout()` guarantees for
sockets).

> **Breaking change (0.2.0):** `publish()` used to resolve directly to a
> `number` (the delivered count). It now resolves to a `PublishResult`.
> Migrate:
>
> ```diff
> - const notified = await hub.publish("orders", { id: 1 });
> + const { delivered } = await hub.publish("orders", { id: 1 });
> ```

**Maturity:** v0.

[Docs](https://docs.lesto.run) · [Example](../../examples/reactive)
