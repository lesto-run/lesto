/**
 * Serve the durable `live()` round-trip demo over live HTTP.
 *
 *   bun run build     # vite build — produces dist/
 *   bun run serve.ts  # boots the API + serves dist/
 *
 * Then open http://127.0.0.1:3000 in a real browser (OPFS needs one — see README.md for why
 * this and the build step are the two things this repo's sandbox cannot run for you). Add a
 * note, reload the page, and the note repaints instantly from the durable OPFS-SQLite store —
 * before the live stream reconnects.
 */

import { openSqlite, serve } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

// Bind loopback by default (a local `bun run serve` should never be reachable off the box), but let a
// container override it: a Fly/Render/Railway machine only receives traffic if the process listens on
// the machine's interface, not `127.0.0.1` — so a Dockerfile would set `HOST=0.0.0.0`.
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const booted = await buildApp({ handle });

  const server = await serve(booted.app, { port: PORT, host: HOST });

  console.log(
    `Durable live() demo on http://${HOST}:${server.port} — build the client first with ` +
      `"bun run build" if you have not yet.`,
  );

  // Guard against a double signal (SIGINT then SIGTERM) re-entering teardown, and `.catch` the chain
  // so a failing `close()` still exits (never a hang until SIGKILL, nor an unhandled rejection).
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;

    booted.engine.stop();

    void server
      .close()
      .then(close)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error("shutdown failed:", error);
        process.exit(1);
      });
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main();
