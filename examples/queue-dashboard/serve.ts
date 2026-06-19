/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PREVIEW — UNAUTHENTICATED. DO NOT DEPLOY AS-IS.                          ║
 * ║                                                                          ║
 * ║  This boots the dashboard — including the destructive `POST …/retry` and ║
 * ║  `DELETE …/:id` verbs — over a REAL HTTP port with NO auth and NO CSRF.  ║
 * ║  It is a local dogfood (drive it with the `curl` lines below), not a     ║
 * ║  deployable surface: anyone who can reach the port can retry/discard any ║
 * ║  job. Gate the mutation routes with auth + `@lesto/csrf` (see the banner ║
 * ║  in `src/app.ts`) before exposing this anywhere real.                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Serve the queue dashboard over LIVE HTTP.
 *
 *   bun run examples/queue-dashboard/serve.ts
 *
 * Where `run.ts` dispatches the journey in-process and exits, this boots the same
 * app behind a real node:http server (`@lesto/runtime`'s `serve`), starts a
 * background WORKER that drains the queue (recording throughput), seeds a steady
 * trickle of jobs plus the batch-with-dependency demo, and stays up so you can
 * watch the dashboard at `/` and drive its routes by hand:
 *
 *   open   http://127.0.0.1:3000/                      the operator board
 *   curl   http://127.0.0.1:3000/__lesto/data/queue    the live snapshot JSON
 *   curl   http://127.0.0.1:3000/queue/jobs?status=failed
 *   curl -X POST   http://127.0.0.1:3000/queue/jobs/4/retry
 *   curl -X DELETE http://127.0.0.1:3000/queue/jobs/2
 *   curl   http://127.0.0.1:3000/queue/batches/1
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openSqlite, serve } from "@lesto/runtime";

import { buildApp, makeRunObserver } from "./src/app";
import { FLAKY, INGEST, NOTIFY, THUMBNAIL } from "./src/operator";

/**
 * Bundle the island hydration entry (`client.tsx`) to a single browser file so the
 * board's status tabs actually hydrate. The board island is `ssr:true`, so the
 * client must hydrate the React-emitted markup the node serve renders — i.e. REAL
 * React, no Preact alias. That needs no resolver plugin, so the plain `bun build`
 * CLI suffices; we SPAWN it (rather than the Bun-only `Bun.build` API) so this file
 * stays node-typed and could be imported under vitest. Returns the bundle source.
 */
function buildClient(): string {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const outfile = join(here, "out", "client.js");

  execFileSync(
    "bun",
    ["build", join(here, "client.tsx"), "--outfile", outfile, "--target", "browser", "--minify"],
    { cwd: here, stdio: "inherit" },
  );

  return readFileSync(outfile, "utf8");
}

const PORT = Number(process.env.PORT ?? 3000);

/**
 * Parse one `LESTO_*` env limit into a positive integer, or `undefined` to fall
 * through to `serve`'s secure default — the exact semantics `lesto serve`/`dev`
 * use (commit 70fed7d): unset, non-numeric, and any value `<= 0` all defer to the
 * default; only a clean positive integer overrides it. We never hand `serve` a
 * zero/negative limit, which would weaken a defense the default already set safely.
 */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  return Math.trunc(value);
}

/**
 * The operator-tunable DoS limits, built from the environment exactly as the
 * `lesto serve`/`dev` CLI does — so this hand-rolled example serves under the same
 * standardized knobs (`LESTO_MAX_BODY_BYTES`, `LESTO_HANDLER_TIMEOUT_MS`,
 * `LESTO_REQUEST_TIMEOUT_MS`, `LESTO_MAX_HEADER_BYTES`, `LESTO_DRAIN_TIMEOUT_MS`)
 * rather than silently dropping them. Only the keys an operator set to a valid
 * positive value are present, so `serve`'s secure default holds for every omitted
 * one (`exactOptionalPropertyTypes` forbids an explicit `undefined`).
 */
function serveLimitsFromEnv(env: NodeJS.ProcessEnv): {
  maxBodyBytes?: number;
  handlerTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxHeaderBytes?: number;
  drainTimeoutMs?: number;
} {
  const maxBodyBytes = parseLimit(env.LESTO_MAX_BODY_BYTES);
  const handlerTimeoutMs = parseLimit(env.LESTO_HANDLER_TIMEOUT_MS);
  const requestTimeoutMs = parseLimit(env.LESTO_REQUEST_TIMEOUT_MS);
  const maxHeaderBytes = parseLimit(env.LESTO_MAX_HEADER_BYTES);
  const drainTimeoutMs = parseLimit(env.LESTO_DRAIN_TIMEOUT_MS);

  return {
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    ...(handlerTimeoutMs !== undefined ? { handlerTimeoutMs } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(maxHeaderBytes !== undefined ? { maxHeaderBytes } : {}),
    ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
  };
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  // Build the island client up front so `/client.js` is live the moment we listen.
  const clientJs = buildClient();

  const { app, db, queue } = await buildApp({ handle, clientJs });

  console.log("migrations applied:", app.migrationsApplied);

  // Seed some work to look at: a few successes, one DLQ failure, and a batch.
  await queue.enqueue(NOTIFY);
  await queue.enqueue(NOTIFY);
  await queue.enqueue(FLAKY, {}, { maxAttempts: 1 });
  await queue.enqueueBatch("import_photo", [{ name: INGEST }, { name: THUMBNAIL, dependsOn: [0] }]);

  // A background worker drains the queue and records throughput. It reclaims
  // stalled jobs on its own cadence and drains gracefully on stop().
  const worker = queue.work({ onJob: makeRunObserver(db) });

  const server = await serve(app, { port: PORT, ...serveLimitsFromEnv(process.env) });
  const url = `http://127.0.0.1:${server.port}`;

  console.warn(
    "\n⚠  PREVIEW — UNAUTHENTICATED: the retry/discard routes have no auth or CSRF.\n" +
      "   Do NOT expose this port to an untrusted network. See src/app.ts for how a\n" +
      "   real deploy gates the mutation routes with @lesto/csrf.",
  );

  console.log(`\nlistening on ${url}`);
  console.log(`  GET    ${url}/                              the operator board`);
  console.log(`  GET    ${url}/__lesto/data/queue            the live snapshot`);
  console.log(`  GET    ${url}/queue/jobs?status=&queue=&limit=&offset=`);
  console.log(`  GET    ${url}/queue/jobs/:id`);
  console.log(`  POST   ${url}/queue/jobs/:id/retry`);
  console.log(`  DELETE ${url}/queue/jobs/:id`);
  console.log(`  GET    ${url}/queue/batches/:id`);
  console.log(`  GET    ${url}/admin/runs?limit=&offset=`);

  const shutdown = async (): Promise<void> => {
    console.log("\nshutting down...");
    await worker.stop();
    await server.close();
    close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

await main();
