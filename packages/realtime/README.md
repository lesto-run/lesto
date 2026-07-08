# @lesto/realtime

> The cross-process topic bus + SSE fan-out behind @lesto/pubsub (ADR 0040).

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/realtime
```

```ts
import { createRealtimeBus, PostgresTransport, createRealtimeHttpHandlers } from "@lesto/realtime";

const bus = createRealtimeBus({ transport: new PostgresTransport(/* … */) });
const handlers = createRealtimeHttpHandlers(bus); // mounts GET /__lesto/live (SSE)
```

Carries invalidation **topics**, never row data (the ADR 0027 invariant). Ships
the pure cores — a resume-cursor replay ring and the transport seam (Postgres
`LISTEN/NOTIFY`) — behind the in-process `@lesto/pubsub` hub.

**Maturity:** v0, evolving alongside ADR 0027's live `useQuery`.

[Docs](https://docs.lesto.run) · [Example](../../examples/reactive)
