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
 * Drive it:
 *   # terminal 1 — subscribe (any WebSocket client; wscat shown):
 *   wscat -c "ws://127.0.0.1:3000/subscribe?channel=news"
 *   # terminal 2 — publish; the subscriber above receives it:
 *   curl -X POST 127.0.0.1:3000/publish -H 'content-type: application/json' \
 *     -d '{"channel":"news","message":"hello"}'
 */

import { buildFanoutServer } from "./src/app";

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

const app = buildFanoutServer();

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
