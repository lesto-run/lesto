/**
 * Serve the pubsub fan-out app over LIVE HTTP + WebSockets, on Bun.
 *
 *   bun run examples/pubsub/serve.ts
 *
 * Bun's `serve` carries a native WebSocket server (the same primitive
 * `packages/cli/src/bin.ts` uses for dev live-reload), so this needs no `ws`
 * dependency — and no `node:http`/`serveWithGracefulShutdown`, which cannot
 * terminate WebSockets. One process means one `FanoutRoom` for every connection,
 * so this single node IS the coordination point the edge needs a Durable Object
 * for (`room.ts`).
 *
 * Both routes require a signed capability token (mint one with `mint.ts`). Drive it:
 *   # mint tokens for the `news` channel (dev key needs PUBSUB_ALLOW_INSECURE=1):
 *   SUB=$(PUBSUB_ALLOW_INSECURE=1 bun mint.ts news subscribe)
 *   PUB=$(PUBSUB_ALLOW_INSECURE=1 bun mint.ts news publish)
 *   # terminal 1 — subscribe (any WebSocket client; wscat shown):
 *   wscat -c "ws://127.0.0.1:3000/subscribe?channel=news&token=$SUB"
 *   # terminal 2 — publish; the subscriber above receives it:
 *   curl -X POST 127.0.0.1:3000/publish -H 'content-type: application/json' \
 *     -H "authorization: Bearer $PUB" -d '{"channel":"news","message":"hello"}'
 */

import { buildFanoutServer } from "./src/app";
import { resolveSecret } from "./secret";

const PORT = Number(process.env.PORT ?? 3000);

interface BunServer {
  port: number;
  stop(): void;
}

interface BunLike {
  serve(options: unknown): BunServer;
}

const bun = (globalThis as { Bun?: BunLike }).Bun;

if (bun === undefined) {
  throw new Error("serve.ts must run under Bun — use `bun run serve.ts`");
}

// Capability tokens are signed + verified with this secret; in production it is a
// real secret shared with the app's token issuer. `resolveSecret` fails CLOSED — an
// unset secret throws unless `PUBSUB_ALLOW_INSECURE=1` explicitly opts into the dev
// key — so this server never silently authenticates with a publicly-known secret.
const app = buildFanoutServer({ secret: resolveSecret() });

const server = bun.serve({
  port: PORT,
  // Match the app server's loopback bind (the URL printed below is 127.0.0.1).
  hostname: "127.0.0.1",
  fetch: app.fetch,
  websocket: app.websocket,
});

const url = `http://127.0.0.1:${server.port}`;

console.log(`\nlistening on ${url}`);
console.log(`  WS   ${url}/subscribe?channel=<name>`);
console.log(`  POST ${url}/publish   {"channel":"<name>","message":<any>}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.stop();
    process.exit(0);
  });
}
