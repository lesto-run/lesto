/**
 * Serve the i18n shop over LIVE HTTP.
 *
 *   bun run examples/i18n/serve.ts
 *
 * Where run.ts drives the journey in-process with hand-built `Accept-Language`
 * headers, this boots the SAME app behind a real `node:http` server
 * (`@lesto/runtime`'s `serveWithGracefulShutdown`) so an ACTUAL browser can load
 * `/fr` and see the French page — and, crucially, so the browser's OWN
 * `Accept-Language` header drives `GET /`, negotiated for real rather than
 * simulated by a test.
 *
 * `buildApp` returns a bare `@lesto/web` app AND is synchronous (there is no
 * database — translation is catalog lookup + interpolation). `createApp`
 * (`@lesto/kernel`) still needs a `db` handle to wrap it into the kernel `App` a
 * server requires, so this opens a THROWAWAY in-memory SQLite handle purely to
 * satisfy that contract, and passes `durable: false` (no session/rate-limit
 * tables to install on a handle nothing else touches) and `secure: false` (this
 * app has no state-changing concern — it only renders GET pages).
 *
 * Drive it:
 *   open http://localhost:3000/            # in a browser — negotiated from its Accept-Language
 *   open http://localhost:3000/fr?name=Ada # in a browser — the French page
 *
 * or from the command line (curl sends its own weighted Accept-Language):
 *   curl localhost:3000/en?name=Ada
 *   curl localhost:3000/ru?name=Ada
 *   curl -H 'Accept-Language: fr-CA,fr;q=0.9' localhost:3000/
 */

import { createApp } from "@lesto/kernel";
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // Throwaway — i18n has no data to persist; this handle exists only to satisfy
  // `createApp`'s required `db`.
  const { db: handle, close } = await openSqlite();

  const booted = buildApp();
  const app = await createApp({ db: handle, app: booted.app, secure: false, durable: false });

  console.log("migrations applied:", app.migrationsApplied);

  const server = await serveWithGracefulShutdown(app, { port: PORT, onClosed: close });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  GET  ${url}/              (locale negotiated from Accept-Language)`);
  console.log(`  GET  ${url}/en?name=Ada`);
  console.log(`  GET  ${url}/fr?name=Ada`);
  console.log(`  GET  ${url}/ru?name=Ada`);
}

await main();
