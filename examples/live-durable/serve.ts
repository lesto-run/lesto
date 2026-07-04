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

import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

// Bind loopback by default (a local `bun run serve` should never be reachable off the box), but let a
// container override it: a Fly/Render/Railway machine only receives traffic if the process listens on
// the machine's interface, not `127.0.0.1` — so a Dockerfile would set `HOST=0.0.0.0`.
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const booted = await buildApp({ handle });

  // serveWithGracefulShutdown owns what this file used to hand-roll — SIGINT + SIGTERM, the
  // double-signal guard, the `.catch`(exit 1) — plus a force-exit backstop it previously lacked
  // (see @lesto/runtime). Stop the change engine BEFORE the drain (`onShutdown`), close the db
  // AFTER it (`onClosed`).
  const server = await serveWithGracefulShutdown(booted.app, {
    port: PORT,
    host: HOST,
    onShutdown: () => booted.engine.stop(),
    onClosed: close,
  });

  console.log(
    `Durable live() demo on http://${HOST}:${server.port} — build the client first with ` +
      `"bun run build" if you have not yet.`,
  );
}

void main();
