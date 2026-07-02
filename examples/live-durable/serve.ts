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

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const booted = await buildApp({ handle });

  const server = await serve(booted.app, { port: PORT, host: "127.0.0.1" });

  console.log(
    `Durable live() demo on http://127.0.0.1:${server.port} — build the client first with ` +
      `"bun run build" if you have not yet.`,
  );

  process.on("SIGINT", () => {
    booted.engine.stop();

    void server
      .close()
      .then(close)
      .then(() => process.exit(0));
  });
}

void main();
