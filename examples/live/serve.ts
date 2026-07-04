/**
 * Serve the local-first `live()` demo over live HTTP.
 *
 *   bun run examples/live/serve.ts
 *
 * Then open http://127.0.0.1:3000. A real UI would call `@lesto/live`'s `live()` to hold the
 * `GET /__lesto/live-data` shape stream open; here two `curl` clients on the same shape show
 * the same thing: a `POST /todos` on one appears as a `change` frame on both. Try the `work`
 * list as `bob` vs `alice` to see the parameter-level authorization — bob's shape is refused
 * (403) at subscribe time, so it never opens.
 */

import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const booted = await buildApp({ handle });

  // serveWithGracefulShutdown owns the shutdown lifecycle (see @lesto/runtime): SIGINT + SIGTERM
  // (this demo previously handled only SIGINT), a double-signal guard, a `.catch`(exit 1), and a
  // force-exit backstop. Stop the change engine BEFORE the drain (`onShutdown`), close the db
  // AFTER it (`onClosed`).
  const server = await serveWithGracefulShutdown(booted.app, {
    port: PORT,
    host: "127.0.0.1",
    onShutdown: () => booted.engine.stop(),
    onClosed: close,
  });

  console.log(
    `Live demo on http://127.0.0.1:${server.port} — shapes stream at /__lesto/live-data.`,
  );
}

void main();
