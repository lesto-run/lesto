# examples/workflows — resumable step memoization over HTTP

Wires **`@lesto/workflows`** behind real HTTP routes to show the guarantee that
makes the battery worth having: a multi-step workflow whose steps run **exactly
once**, replay on a re-post, and **resume after a mid-run failure without
repeating the irreversible ones**.

## What it shows

A checkout workflow with three side-effecting steps — charge the card, reserve
inventory, email the receipt — and a settlement `sleep` in the middle.

| Route                          | Behavior                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /checkout/:orderId`      | Runs the `checkout` workflow with `:orderId` as the runId. First call executes every step; a re-post **replays** the journal; a retry after a failure **resumes**. |
| `GET /checkout/:orderId/trace` | The `onStep` observability trace for that run — each step and whether it **executed or replayed**.                                                                 |

The three journeys:

1. **Execute** — the first `POST` runs charge → reserve → sleep → receipt and
   returns the receipt.
2. **Replay** — a second `POST` for the same order returns the _same_ receipt and
   runs **no** side effects (the card is not charged twice).
3. **Resume** — with the receipt mailer down, the first `POST` fails _after_
   charging and reserving (`502`, `resumable: true`); retrying the same order
   **replays** the charge + reservation and only re-runs the receipt step.

> Resume is **caller-driven** — this is step memoization, not a durable scheduler
> (see the `Engine` doc). Re-invoking `run()` with the same `runId` is what a
> retry queue would do; here the HTTP retry stands in for that driver.

Only `@lesto/workflows`' public API is used: `Engine`, `installWorkflowSchema`,
`WorkflowError`, and the `Sleep` / `SqlDatabase` / `StepEvent` types. The routes
are plain `@lesto/web`; the database is `@lesto/runtime`'s `openSqlite`.

## How to run

```bash
bun run examples/workflows/run.ts
```

Runs both scenarios (execute-then-replay, fail-then-resume) on in-memory
databases and prints the call counts + trace at each step so you can watch a
replay run zero side effects and a resume skip the already-charged card.

## How it's tested (the QA gate)

```bash
bun run --filter '@lesto/example-workflows' test
```

The journey test (`test/workflows.test.ts`) asserts, over HTTP:

- a first checkout runs each step exactly once and returns a receipt;
- a re-post returns the byte-identical receipt and runs no side effect again;
- a run that fails at the receipt step resumes on retry with the **charge
  replayed, not repeated** (`{ charges: 1 }` across both attempts);
- the settlement `sleep` is awaited through the injected sleep (no real timer);
- a malformed body is a clean `422`.

## How to deploy / run the hosted leg

```bash
bun run examples/workflows/serve.ts
```

`buildApp` returns a bare `@lesto/web` app — `serve.ts` wraps it with
`@lesto/kernel`'s `createApp` (installing the durable-store schema alongside the
step-journal schema `buildApp` already installs) and serves THAT behind a real
`node:http` server (`@lesto/runtime`'s `serveWithGracefulShutdown`). The receipt
mailer is configured to fail exactly **once** across the whole process, and
`sleep` is a real (short-capped) timer rather than the test's instant no-op, so
the settlement pause and the fail-then-resume path are both genuinely observable
over the wire:

```bash
# 1. First checkout hits the one-time mailer fault -> 502, resumable.
curl -X POST localhost:3000/checkout/order-1 \
  -H 'content-type: application/json' -d '{"card":"tok_ada","amountCents":4200}'

# 2. Retry the SAME order: charge + reserve REPLAY, only receipt re-runs -> 200.
curl -X POST localhost:3000/checkout/order-1 \
  -H 'content-type: application/json' -d '{"card":"tok_ada","amountCents":4200}'

# 3. Inspect which steps executed vs replayed.
curl localhost:3000/checkout/order-1/trace

# 4. A different order executes cleanly (the fault is already spent).
curl -X POST localhost:3000/checkout/order-2 \
  -H 'content-type: application/json' -d '{"card":"tok_grace","amountCents":9900}'
```

**Not run in this sandbox** — starting a server is blocked here. `serve.ts` is
typechecked and oxlint/oxfmt-clean, and its wiring (`buildApp` → `createApp` →
`serveWithGracefulShutdown`) mirrors the pattern every hosted `serve.ts` in the
gallery uses (see `examples/mailing-lists/serve.ts`); running the runbook above
is a manual follow-up.

## DX findings

Two ergonomic notes surfaced while wiring this, both routed to the owning plan:

1. **RESOLVED.** ~~The workflow body has no access to its own `runId`.~~
   `WorkflowContext` now carries `runId` and `workflow` (`@lesto/workflows`
   `packages/workflows/src/types.ts`, populated in `Engine#context`), so the
   identity a step needs (here the order id, used to reserve inventory and
   email the receipt) no longer has to be threaded in through `input` — the
   checkout workflow body below reads `ctx.runId` directly.
2. **There is no public read of the step journal.** Surfacing "which steps have
   completed for this run" over HTTP is only possible via the `onStep` sink
   (an in-memory trace here, lost on restart); a durable run/journal is
   explicitly deferred post-1.0, but a read-only `Engine.stepsOf(runId)` would
   let a resume driver introspect progress without re-running. → `@lesto/workflows`.
