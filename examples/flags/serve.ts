/**
 * Serve the flags app over LIVE HTTP.
 *
 *   bun run examples/flags/serve.ts
 *
 * Where run.ts drives the journey in-process (`app.handle`), this boots the SAME
 * app behind a real `node:http` server (`@lesto/runtime`'s
 * `serveWithGracefulShutdown`) so an ACTUAL browser (or curl) can watch a gated
 * route wink in and out of existence as a `resolve` lever flips it — a real HTTP
 * round-trip, not a decoded object handed to `app.handle` directly.
 *
 * `buildApp()` returns a bare `@lesto/web` app AND is synchronous (there is no
 * database — a flag decision is pure computation). `createApp` (`@lesto/kernel`)
 * still needs a `db` handle to wrap it into the kernel `App` a server requires, so
 * this opens a THROWAWAY in-memory SQLite handle purely to satisfy that contract,
 * and passes `durable: false` (no session/rate-limit tables to install on a handle
 * nothing else touches) and `secure: false` (this app has no state-changing
 * concern — every route is a GET — so the kernel's rate-limit baseline would wrap a
 * demo server for no reason).
 *
 * Drive it:
 *   open http://localhost:3000/                            # a browsable index
 *   curl -i localhost:3000/dashboard                       # 404 — flag off
 *   curl -i 'localhost:3000/dashboard?preview=1'           # 200 — preview lever
 *   curl -i localhost:3000/dashboard -H 'x-user-tier: beta'# 200 — per-request targeting
 *   curl -i localhost:3000/changelog                       # 200 — on by default
 *   curl -i localhost:3000/changelog -H 'x-kill-changelog: 1' # 404 — kill switch
 *   curl -i localhost:3000/experiment                      # 404 — undeclared flag
 *   curl 'localhost:3000/flags?preview=1'                  # the resolution table
 */

import { createApp } from "@lesto/kernel";
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // Throwaway — flags has no data to persist; this handle exists only to satisfy
  // `createApp`'s required `db`.
  const { db: handle, close } = await openSqlite();

  const booted = buildApp();
  const app = await createApp({ db: handle, app: booted.app, secure: false, durable: false });

  console.log("migrations applied:", app.migrationsApplied);

  const server = await serveWithGracefulShutdown(app, { port: PORT, onClosed: close });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  GET  ${url}/               (open this in a browser)`);
  console.log(`  GET  ${url}/dashboard      (404 off; ?preview=1 or x-user-tier: beta ⇒ 200)`);
  console.log(`  GET  ${url}/changelog      (200 on; x-kill-changelog: 1 ⇒ 404)`);
  console.log(`  GET  ${url}/experiment     (undeclared flag ⇒ always 404)`);
  console.log(`  GET  ${url}/beta/labs      (subtree, 404 off; ?preview=1 ⇒ 200)`);
  console.log(`  GET  ${url}/flags          (the resolution table for the request)`);
}

await main();
