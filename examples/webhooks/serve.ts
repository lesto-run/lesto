/**
 * Serve the webhooks app over LIVE HTTP — the hosted leg the `rawBody` seam
 * unblocked (see the README's DX finding #1, now RESOLVED).
 *
 *   bun run examples/webhooks/serve.ts
 *
 * run.ts and the tests drive both directions in-process; this exposes the SAME
 * app behind a real `node:http` server (`@lesto/runtime`'s
 * `serveWithGracefulShutdown`) so you can curl it directly. The outbound leg
 * (`POST /orders` → the queue → the injected in-process `dispatchFetch`) is
 * unchanged from run.ts — delivery still hands the signed bytes straight to this
 * app's own `/incoming` route with no real network hop. What's NEW here is that
 * `/incoming` now runs behind an ACTUAL socket: a real client connects, this
 * server reads the bytes off the wire, and `c.req.rawBody` still carries the
 * EXACT bytes `verifyRequest` hashes — because `@lesto/runtime`'s node dispatch
 * populates `rawBody` the same way the in-process `handle` and the edge decode
 * do (see `test/hosted.test.ts` for the edge-specific proof).
 *
 * A queue worker drains outbound deliveries continuously, mirroring
 * `examples/mailing-lists/serve.ts`.
 *
 * `buildApp` returns a bare `@lesto/web` app; `createApp` (`@lesto/kernel`)
 * wraps it into the kernel `App` a server needs, installing the durable-store
 * schema alongside the queue schema `buildApp` already installs. Secure
 * defaults are left ON (the kernel's rate-limit baseline).
 *
 * Drive the outbound leg:
 *   curl -X POST localhost:3000/orders -H 'content-type: application/json' \
 *     -d '{"orderId":"ord_1","amountCents":2500,"subscriberUrl":"https://hooks.example.com/incoming"}'
 *   curl localhost:3000/received
 *
 * Or hand-craft a genuinely-signed request straight at the receiver (bash):
 *   BODY='{"event":"order.paid","data":{"orderId":"ord_x"}}'
 *   SECRET='whsec_demo_ada'
 *   TS=$(node -e 'process.stdout.write(String(Date.now()))')
 *   SIG=$(node -e "
 *     const c=require('node:crypto');
 *     process.stdout.write(c.createHmac('sha256',process.argv[2]).update(process.argv[1]).digest('hex'));
 *   " "$TS.$BODY" "$SECRET")
 *   curl -X POST localhost:3000/incoming -H 'content-type: application/json' \
 *     -H "x-lesto-signature: $SIG" -H "x-lesto-timestamp: $TS" -d "$BODY"
 *
 * NOTE: an INVALID-JSON `application/json` body 400s in `@lesto/runtime`'s
 * `parseBody` before `/incoming` (or any handler) ever runs — see the README.
 * That's fine for real webhook senders, which always send valid JSON; it only
 * matters if you're hand-crafting a deliberately malformed request.
 */

import { createApp } from "@lesto/kernel";
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const booted = await buildApp({ handle });
  const app = await createApp({ db: handle, app: booted.app });

  console.log("migrations applied:", app.migrationsApplied);

  // Drains outbound deliveries continuously — the production shape, not run.ts's
  // one-shot drain loop.
  const worker = booted.queue.work();

  const server = await serveWithGracefulShutdown(app, {
    port: PORT,
    onShutdown: async () => {
      console.log("\nshutting down...");
      await worker.stop();
    },
    onClosed: close,
  });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  POST ${url}/orders     {"orderId":"…","amountCents":…,"subscriberUrl":"…"}`);
  console.log(`  POST ${url}/incoming   (a signed webhook — verified over the raw request body)`);
  console.log(`  GET  ${url}/received`);
}

await main();
