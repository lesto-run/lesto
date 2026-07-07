/**
 * Serve the signup form over LIVE HTTP.
 *
 *   bun run examples/forms/serve.ts
 *
 * Where run.ts drives the journey in-process with hand-built request bodies,
 * this boots the SAME app behind a real `node:http` server (`@lesto/runtime`'s
 * `serveWithGracefulShutdown`) so an ACTUAL browser can load `/signup`, submit
 * the rendered `<form>`, and see the re-render — the real
 * `application/x-www-form-urlencoded` POST a browser sends, not a decoded
 * object a test hands `app.handle` directly.
 *
 * `buildApp` returns a bare `@lesto/web` app AND is synchronous (there is no
 * database — a form is render + validate). `createApp` (`@lesto/kernel`) still
 * needs a `db` handle to wrap it into the kernel `App` a server requires, so
 * this opens a THROWAWAY in-memory SQLite handle purely to satisfy that
 * contract, and passes `durable: false` (no session/rate-limit tables to
 * install on a handle nothing else touches) and `secure: false` (this app has
 * no state-changing concern beyond the form itself, and the kernel's default
 * rate-limit baseline would otherwise wrap a demo server for no reason).
 *
 * Drive it:
 *   open http://localhost:3000/signup   # in a browser — submit it by hand
 *
 * or from the command line (curl's `-d` defaults to urlencoded, matching a
 * real browser form POST):
 *   curl localhost:3000/signup
 *   curl -X POST localhost:3000/signup -d 'plan=enterprise'                          # 422, errors
 *   curl -X POST localhost:3000/signup -d 'email=ada@example.com&plan=pro&terms=on'  # 201
 *   curl localhost:3000/signups
 */

import { createApp } from "@lesto/kernel";
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  // Throwaway — forms has no data to persist; this handle exists only to
  // satisfy `createApp`'s required `db`.
  const { db: handle, close } = await openSqlite();

  const booted = buildApp();
  const app = await createApp({ db: handle, app: booted.app, secure: false, durable: false });

  console.log("migrations applied:", app.migrationsApplied);

  const server = await serveWithGracefulShutdown(app, { port: PORT, onClosed: close });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}`);
  console.log(`  GET  ${url}/signup    (open this in a browser)`);
  console.log(`  POST ${url}/signup`);
  console.log(`  GET  ${url}/signups`);
}

await main();
