/**
 * Serve the cache app over LIVE HTTP, on a FILE-backed SQLite database.
 *
 *   bun run examples/cache/serve.ts
 *
 * Where run.ts drives the read-through journey in-process on an in-memory
 * database, this boots the SAME app behind a real `node:http` server
 * (`@lesto/runtime`'s `serveWithGracefulShutdown`) — on a file, not `:memory:` —
 * so a warm key survives a restart of the PROCESS ITSELF, not just a second
 * `buildApp` call within one run (see the "persists a warm key across a
 * restart" test for the in-process proof; this is the same guarantee, but for
 * real: kill this process, start it again, and GET the same id inside the TTL).
 *
 * `buildApp` returns a bare `@lesto/web` app; `createApp` (`@lesto/kernel`) wraps
 * it into the kernel `App` a server needs — installing the durable-store schema
 * (sessions/rate-limits) alongside the cache schema `buildApp` already installs
 * on the same handle, and wrapping every request in the kernel's rate-limit
 * baseline (secure defaults left ON; this app has no session/CSRF concerns).
 *
 * Drive it:
 *   curl localhost:3000/reports/alpha                    # miss, then a hit on repeat
 *   curl -X POST localhost:3000/reports/alpha/invalidate
 *   curl -X POST localhost:3000/cache/sweep
 */

import { systemClock } from "@lesto/cache";
import { createApp } from "@lesto/kernel";
import { openSqlite, serveWithGracefulShutdown } from "@lesto/runtime";

import { buildApp } from "./src/app";

const PORT = Number(process.env.PORT ?? 3000);
const DB_PATH = process.env.DB_PATH ?? "./cache.db";
const TTL_MS = 60_000;

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite(DB_PATH);

  const booted = await buildApp({ handle, clock: systemClock, ttlMs: TTL_MS });
  const app = await createApp({ db: handle, app: booted.app });

  console.log("migrations applied:", app.migrationsApplied);

  const server = await serveWithGracefulShutdown(app, { port: PORT, onClosed: close });
  const url = `http://127.0.0.1:${server.port}`;

  console.log(`\nlistening on ${url}   (db: ${DB_PATH})`);
  console.log(`  GET  ${url}/reports/:id`);
  console.log(`  POST ${url}/reports/:id/invalidate`);
  console.log(`  POST ${url}/cache/sweep`);
  console.log(
    `\nrestart this process and GET the same :id again inside the ${TTL_MS}ms TTL — still a hit.`,
  );
}

await main();
