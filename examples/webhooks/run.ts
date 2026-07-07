/**
 * The whole webhook exchange, in-process, in one run.
 *
 *   bun run examples/webhooks/run.ts
 *
 * It boots the app on an in-memory SQLite database, then drives both directions
 * through the real HTTP routes:
 *
 *   1. Place an order whose subscriber is the (public) demo endpoint → drain the
 *      queue → the signed webhook is delivered and the receiver verifies it.
 *   2. Place an order whose subscriber is the cloud-metadata address → drain → the
 *      SSRF guard refuses delivery (a permanent failure) and nothing is received.
 *
 * Delivery is dispatched in-process, so there is no port to open and the raw
 * signed body survives for verification.
 */

import { openSqlite } from "@lesto/runtime";

import { buildApp, RECEIVER_URL } from "./src/app";

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();
  const { app, queue } = await buildApp({ handle });

  const drain = async (): Promise<string[]> => {
    const outcomes: string[] = [];
    let result = await queue.runOnce();
    while (result !== null) {
      outcomes.push(result.outcome);
      result = await queue.runOnce();
    }

    return outcomes;
  };

  const received = async (): Promise<string> =>
    (await app.handle("GET", "/received")).body as string;

  // 1. Deliver to the registered public endpoint.
  console.log("── deliver + verify ──");
  const paid = await app.handle("POST", "/orders", {
    body: { orderId: "ord_1", amountCents: 2500, subscriberUrl: RECEIVER_URL },
  });
  console.log(`POST /orders -> ${paid.status} ${paid.body}`);
  console.log(`  queue outcomes after drain: ${JSON.stringify(await drain())}`);
  console.log(`  GET /received -> ${await received()}\n`);

  // 2. Deliver to a private/metadata address — refused by the SSRF guard.
  console.log("── SSRF guard ──");
  const blocked = await app.handle("POST", "/orders", {
    body: { orderId: "ord_2", amountCents: 100, subscriberUrl: "http://169.254.169.254/hook" },
  });
  console.log(`POST /orders (metadata URL) -> ${blocked.status} ${blocked.body}`);
  console.log(
    `  queue outcomes after drain: ${JSON.stringify(await drain())}   (refused, not retried)`,
  );
  console.log(`  GET /received -> ${await received()}   (unchanged)`);

  close();
}

await main();
