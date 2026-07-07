/**
 * The whole resume story, in-process, in one run.
 *
 *   bun run examples/workflows/run.ts
 *
 * Two scenarios, each on its own in-memory SQLite database, driven through the
 * real HTTP routes:
 *
 *   1. Execute then replay — check out an order, then re-post the SAME order and
 *      watch every step replay (the card is not charged twice).
 *   2. Fail then resume — check out with the receipt mailer "down"; the run fails
 *      after charging + reserving, then a retry of the same order replays those
 *      completed steps and only re-runs the receipt — exactly-once for the charge.
 *
 * `sleep` is injected as a short real delay so the settlement pause is visible
 * without waiting a full second.
 */

import { openSqlite } from "@lesto/runtime";

import { buildApp, createCheckoutServices } from "./src/app";
import type { Sleep } from "@lesto/workflows";

const shortSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50)));

async function scenarioExecuteThenReplay(): Promise<void> {
  const { db: handle, close } = await openSqlite();
  const services = createCheckoutServices();
  const { app } = await buildApp({ handle, services, sleep: shortSleep });

  const body = { card: "tok_ada", amountCents: 4200 };

  console.log("── execute then replay ──");
  const first = await app.handle("POST", "/checkout/order-1", { body });
  console.log(`POST /checkout/order-1 -> ${first.status} ${first.body}`);
  console.log(`  calls: ${JSON.stringify(services.calls)}   (each ran once)\n`);

  const replay = await app.handle("POST", "/checkout/order-1", { body });
  console.log(`POST /checkout/order-1 (again) -> ${replay.status} ${replay.body}`);
  console.log(`  calls: ${JSON.stringify(services.calls)}   (unchanged — all replayed)`);

  const trace = await app.handle("GET", "/checkout/order-1/trace");
  console.log(`  trace: ${trace.body}\n`);

  close();
}

async function scenarioFailThenResume(): Promise<void> {
  const { db: handle, close } = await openSqlite();
  const services = createCheckoutServices({ failReceiptTimes: 1 });
  const { app } = await buildApp({ handle, services, sleep: shortSleep });

  const body = { card: "tok_grace", amountCents: 9900 };

  console.log("── fail then resume ──");
  const failed = await app.handle("POST", "/checkout/order-2", { body });
  console.log(`POST /checkout/order-2 -> ${failed.status} ${failed.body}`);
  console.log(
    `  calls: ${JSON.stringify(services.calls)}   (charged + reserved, receipt failed)\n`,
  );

  const resumed = await app.handle("POST", "/checkout/order-2", { body });
  console.log(`POST /checkout/order-2 (retry) -> ${resumed.status} ${resumed.body}`);
  console.log(`  calls: ${JSON.stringify(services.calls)}   (charge NOT repeated — resumed)`);

  const trace = await app.handle("GET", "/checkout/order-2/trace");
  console.log(`  trace: ${trace.body}\n`);

  close();
}

async function main(): Promise<void> {
  await scenarioExecuteThenReplay();
  await scenarioFailThenResume();
}

await main();
