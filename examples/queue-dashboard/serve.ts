/**
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

import { openSqlite, serve } from "@lesto/runtime";

import { buildApp, makeRunObserver } from "./src/app";
import { FLAKY, INGEST, NOTIFY, THUMBNAIL } from "./src/operator";

const PORT = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app, db, queue } = await buildApp({ handle });

  console.log("migrations applied:", app.migrationsApplied);

  // Seed some work to look at: a few successes, one DLQ failure, and a batch.
  await queue.enqueue(NOTIFY);
  await queue.enqueue(NOTIFY);
  await queue.enqueue(FLAKY, {}, { maxAttempts: 1 });
  await queue.enqueueBatch("import_photo", [{ name: INGEST }, { name: THUMBNAIL, dependsOn: [0] }]);

  // A background worker drains the queue and records throughput. It reclaims
  // stalled jobs on its own cadence and drains gracefully on stop().
  const worker = queue.work({ onJob: makeRunObserver(db) });

  const server = await serve(app, { port: PORT });
  const url = `http://127.0.0.1:${server.port}`;

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
