# @lesto/workflows

> Resumable step memoization on your SQL database.

Part of **[Lesto](https://lesto.run)**, the batteries-included, agent-native fullstack framework.

```bash
bun add @lesto/workflows
```

```ts
import { Engine, installWorkflowSchema } from "@lesto/workflows";

installWorkflowSchema(db);
const engine = new Engine({ db });

engine.define("checkout", async (input, ctx) => {
  const charge = await ctx.step("charge", () => chargeCard(input.card));
  const receipt = await ctx.step("receipt", () => emailReceipt(charge));
  return receipt;
});

// Re-invoking with the same runId REPLAYS completed steps instead of re-charging.
await engine.run("checkout", "order-42", { card: "tok_abc" });
```

**Boundary:** this is step memoization, **not** crash-safe durable execution.
Resume is caller-driven — your app re-invokes `run()` with the same `runId` to
continue an interrupted run; there is no run journal or scheduler (deferred
post-1.0).

[Docs](https://docs.lesto.run) · [Example](../../examples/workflows)
