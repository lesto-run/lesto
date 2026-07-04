/**
 * Serve the reactive live-queries demo over live HTTP.
 *
 *   bun run examples/reactive/serve.ts
 *
 * Then open http://127.0.0.1:3000 in TWO browser tabs, post in one, and watch it appear
 * live in the other — no reload, no app WebSocket code. Try `alice` vs `bob` on the
 * `secret` room to see the per-subscription authorization: bob is not a member, so bob's
 * tab never receives the update (not even its timing).
 */

import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app } = await buildApp({ handle });

  // serveWithGracefulShutdown owns the shutdown lifecycle (see @lesto/runtime): SIGINT + SIGTERM
  // (this demo previously handled only SIGINT), a double-signal guard, a `.catch`(exit 1), and a
  // force-exit backstop. `onClosed` closes the db once in-flight requests have drained.
  const server = await serveWithGracefulShutdown(app, {
    port: PORT,
    host: "127.0.0.1",
    onClosed: close,
  });

  console.log(`Reactive demo on http://127.0.0.1:${server.port} — open it in two tabs.`);
}

void main();
