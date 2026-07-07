/**
 * Serve the checkout workflow app over LIVE HTTP.
 *
 *   bun run examples/workflows/serve.ts
 *
 * Where run.ts drives both scenarios in one process, in-process, this boots the
 * SAME app behind a real `node:http` server (`@lesto/runtime`'s
 * `serveWithGracefulShutdown`) so you can drive execute → replay → resume by
 * hand, with curl, against a process that actually persists the step journal
 * across requests (the whole point of `@lesto/workflows`).
 *
 * `buildApp` returns a bare `@lesto/web` app; `createApp` (`@lesto/kernel`) wraps
 * it into the kernel `App` a server needs, installing the durable-store schema
 * alongside the workflow step-journal schema `buildApp` already installs on the
 * same handle. Secure defaults are left ON (the kernel's rate-limit baseline).
 *
 * The receipt mailer is configured to fail EXACTLY ONCE across the whole process
 * (`failReceiptTimes: 1`) — whichever order first reaches the receipt step hits
 * it — so the very first checkout you run demonstrates fail-then-resume, and
 * every checkout after that succeeds outright. `sleep` is a REAL timer (capped
 * short, not the test's instant no-op), so the settlement pause is visibly felt.
 *
 * Runbook — execute → replay → resume:
 *
 *   # 1. First checkout: charge + reserve succeed, the mailer is "down" for the
 *   #    very first receipt attempt across the process -> 502, resumable.
 *   curl -X POST localhost:3000/checkout/order-1 \
 *     -H 'content-type: application/json' -d '{"card":"tok_ada","amountCents":4200}'
 *
 *   # 2. Retry the SAME order: charge + reserve REPLAY (no double charge), only
 *   #    the receipt step re-runs (the mailer is back up) -> 200, a receipt.
 *   curl -X POST localhost:3000/checkout/order-1 \
 *     -H 'content-type: application/json' -d '{"card":"tok_ada","amountCents":4200}'
 *
 *   # 3. See which steps executed vs replayed on that run.
 *   curl localhost:3000/checkout/order-1/trace
 *
 *   # 4. A different order: the mailer fault is already spent, so this executes
 *   #    cleanly in one pass.
 *   curl -X POST localhost:3000/checkout/order-2 \
 *     -H 'content-type: application/json' -d '{"card":"tok_grace","amountCents":9900}'
 *
 *   # 5. Re-post order-2: byte-identical receipt, every step replays.
 *   curl -X POST localhost:3000/checkout/order-2 \
 *     -H 'content-type: application/json' -d '{"card":"tok_grace","amountCents":9900}'
 */

import { createApp } from "@lesto/kernel";
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";
import type { Sleep } from "@lesto/workflows";

import { buildApp, createCheckoutServices } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

/** A capped REAL sleep — an actual timer, not an instant no-op, but bounded. */
const REAL_SLEEP_CAP_MS = 2_000;
const sleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, Math.min(ms, REAL_SLEEP_CAP_MS)));

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const services = createCheckoutServices({ failReceiptTimes: 1 });
  const booted = await buildApp({ handle, services, sleep });
  const app = await createApp({ db: handle, app: booted.app });

  console.log("migrations applied:", app.migrationsApplied);

  const server = await serveWithGracefulShutdown(app, { port: PORT, onClosed: close });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  POST ${url}/checkout/:orderId       {"card":"…","amountCents":…}`);
  console.log(`  GET  ${url}/checkout/:orderId/trace`);
  console.log(`\nthe receipt mailer fails exactly ONCE across this process — the first`);
  console.log(`checkout you run will 502 (resumable), and a retry of the SAME order`);
  console.log(`resumes: charge + reserve replay, only the receipt step re-runs.`);
}

await main();
