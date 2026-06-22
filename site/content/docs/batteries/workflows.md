---
title: "Workflows"
description: "Resumable step memoization on the SQL database — completed steps replay instead of re-running when you re-invoke a run with the same id."
section: Batteries
order: 23
---

# Workflows

`@lesto/workflows` is **resumable step memoization** on the SQL database. You
define a workflow as a sequence of named steps; each step's result is journaled
to the database the first time it runs, and re-invoking the run with the same
`runId` **replays the completed steps from the journal** instead of executing
them again. It's how you make a multi-step process — a checkout, an onboarding
drip, a multi-call integration — safe to retry without repeating the parts that
already succeeded.

> [!WARNING]
> **Read this boundary first.** This is *memoization*, **not** crash-safe durable
> execution. Resume is **caller-driven**: nothing re-invokes an interrupted run
> for you — your app must call `run()` again with the same `runId` to continue.
> There is no run journal scanner and no scheduler. A durable journal + automatic
> resume driver (and durable `sleep` / `waitForEvent`) is **deferred post-1.0**.
> Use this for "make a retried run skip the steps that already finished," not for
> "guarantee this run completes even if the process dies."

## Define a workflow

Install the schema once (it adds the step-journal table), then build an `Engine`
over a database handle and `define` each workflow by name. A workflow body
receives the run input and a `ctx`; wrap each unit of work in `ctx.step(name, fn)`:

```ts
import { Engine, installWorkflowSchema } from "@lesto/workflows";

await installWorkflowSchema(db);

const engine = new Engine({ db });

engine.define("checkout", async (input, ctx) => {
  const charge = await ctx.step("charge", () => chargeCard(input.card));
  await ctx.sleep(1000);
  const receipt = await ctx.step("receipt", () => emailReceipt(charge));
  return receipt;
});
```

`ctx.step(name, fn)` runs `fn` the first time and journals its result under
`name`; on a later run with the same `runId` it returns the journaled value
without calling `fn` again. `ctx.sleep(ms)` pauses between steps (driven by the
injected `Sleep`, `systemSleep` by default — swap it in a test for a fake clock).
Step names must be unique within a workflow: the name *is* the journal key.

## Run, and resume by replaying

`run(name, runId, input)` executes the workflow. The `runId` is yours to choose
and is the identity of this particular run — re-invoking with the same `runId` is
what triggers replay:

```ts
// First call: every step executes, each result journaled under this runId.
await engine.run("checkout", "order-42", { card: "tok_abc" });

// Re-invoking the SAME runId: `charge` and `receipt` replay from the journal —
// the card is NOT charged again — and only steps that never completed run.
await engine.run("checkout", "order-42", { card: "tok_abc" });
```

So if a run stops partway (a thrown error, a deploy that ends the process), the
steps that *did* complete are durably journaled; calling `run()` again with that
`runId` picks up from the first unfinished step. The replay is what makes a step
safe to retry — but, per the boundary above, **you** decide when to re-invoke
(after catching the error, from a retried job, from an operator action).

## Observe step execution

Pass a `StepObserver` to see which steps executed versus replayed — useful for
logs, metrics, or asserting replay in a test. Each `StepEvent` carries the step
name and a `replayed` flag (executed `fn` vs. returned a memoized result):

```ts
const engine = new Engine({ db, onStep: (e) => log(`${e.name} ${e.replayed ? "replayed" : "ran"}`) });
```

## Notes and gotchas

- **It is memoization, not durability.** Nothing resumes an interrupted run on
  its own — re-invoking with the same `runId` is required. If you need a process
  crash to be *automatically* recovered, that driver is post-1.0; today, pair the
  engine with [`@lesto/queue`](/batteries/queue) yourself (enqueue a job that
  re-invokes `run()`), or trigger the retry from an operator path.
- **Steps must be idempotent at the boundary.** A step that completed is replayed
  from its journaled result and never re-runs — but a step that *failed* mid-side-effect
  (charged the card, then threw before journaling) will run again on the next
  invocation. Make each step's effect safe to attempt more than once, the same
  at-least-once discipline the [queue](/batteries/queue) documents.
- **The `runId` is the identity.** Two runs with the same `name` but different
  `runId`s are independent; the same `runId` is the same run and shares one
  journal. Choose a `runId` that maps to the thing the workflow is about (an order
  id, a user id) so a natural retry reuses it.
- **`sleep` is in-process, not durable.** `ctx.sleep(ms)` waits within the running
  call; it does not survive the process exiting and resume later. A durable,
  cross-process `sleep`/`waitForEvent` is part of the deferred post-1.0 work.
- **Branch on `code`, never the message.** Failures are a `WorkflowError` carrying
  a stable `WorkflowErrorCode`.

For the at-least-once primitive workflows are often paired with, see
[Queue](/batteries/queue); for the schema the journal lives on, see
[Data](/batteries/data).
