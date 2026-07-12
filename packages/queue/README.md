# @lesto/queue

> Lesto's in-house durable job queue — at-least-once delivery on the SQL database, no Redis.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/queue
```

```ts
import { Queue, Scheduler } from "@lesto/queue";

// A durable, at-least-once job queue on your SQL database — inject the db, no Redis.
const queue = new Queue({ db });

queue.define("send_email", async ({ to }: { to: string }) => sendEmail(to));
await queue.enqueue("send_email", { to: "ada@example.com" });

const worker = queue.work(); // drains forever; worker.stop() drains gracefully

// Recurring work is a Scheduler over the same queue.
const schedule = new Scheduler({ queue });
schedule.cron("0 9 * * *", "daily_digest");
schedule.start();
```

At-least-once means a handler can run twice (a crashed worker's job is reclaimed),
so keep them idempotent. `packages/queue` is Lesto's reference implementation.

[Docs](https://docs.lesto.run/batteries/queue) · [Agent-readable docs](https://docs.lesto.run/llms.txt)
