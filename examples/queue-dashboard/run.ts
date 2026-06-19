/**
 * The whole operator journey, in-process, in one run.
 *
 *   bun run examples/queue-dashboard/run.ts
 *
 * It boots the dashboard on an in-memory SQLite database, seeds the queue with a
 * mix of jobs (some that succeed, one that fails into the DLQ), runs a worker to
 * drain them — recording throughput as it goes — then enqueues a BATCH with a
 * dependency edge and drains it IN ORDER. Finally it dispatches the dashboard's
 * own routes over the real kernel (`app.handle`) and prints what an operator sees:
 * the snapshot, the failed-job DLQ, a retry, a discard, and the batch rollup.
 *
 * Every line you see is a response that came back over `app.handle`, the same
 * path a browser would drive against `serve.ts`.
 */

import { openSqlite } from "@lesto/runtime";
import type { JobObserver, Queue } from "@lesto/queue";

import { buildApp, makeRunObserver } from "./src/app";
import { FLAKY, INGEST, NOTIFY, THUMBNAIL } from "./src/operator";

/** Parse a JSON response body into a typed object. */
function body<T>(response: { body: unknown }): T {
  return JSON.parse(response.body as string) as T;
}

/** Drain the queue until idle, recording each processed run through the observer. */
async function drain(queue: Queue, onJob: JobObserver): Promise<void> {
  while ((await queue.runOnce({ onJob })) !== null) {
    /* keep processing until the queue reports idle */
  }
}

async function main(): Promise<void> {
  const { db: handle, close } = await openSqlite();

  const { app, db, queue } = await buildApp({ handle });
  const onJob = makeRunObserver(db);

  console.log("migrations applied:", app.migrationsApplied);

  // 1. Seed a mix of jobs: three that succeed, one that fails into the DLQ.
  await queue.enqueue(NOTIFY);
  await queue.enqueue(NOTIFY);
  await queue.enqueue(NOTIFY);
  const flakyId = await queue.enqueue(FLAKY, {}, { maxAttempts: 1 });

  // 2. A BATCH with a dependency: thumbnail waits for ingest (completes in order).
  const batch = await queue.enqueueBatch("import_photo", [
    { name: INGEST },
    { name: THUMBNAIL, dependsOn: [0] },
  ]);
  console.log(`enqueued batch ${batch.id}:`, batch.jobIds);

  // 3. Drain. The worker records every run; the batch's thumbnail is invisible
  //    to the claim until ingest completes, so it can only run second.
  await drain(queue, onJob);

  // 4. The dashboard snapshot — the JSON the board island renders.
  const snapshot = body<{ counts: Record<string, number>; failed: unknown[]; totalRuns: number }>(
    await app.handle("GET", "/__lesto/data/queue"),
  );
  console.log("\nsnapshot counts:", snapshot.counts);
  console.log("failed jobs (DLQ):", snapshot.failed);
  console.log("total runs processed:", snapshot.totalRuns);

  // 5. The batch rollup — completed, in order.
  const rollup = body<{ batch: { state: string; counts: Record<string, number> } }>(
    await app.handle("GET", `/queue/batches/${batch.id}`),
  );
  console.log(`\nbatch ${batch.id}:`, rollup.batch.state, rollup.batch.counts);

  // 6. Retry the failed job, then drain again — it succeeds the second time only
  //    if its handler can; the FLAKY handler always throws, so this re-fails, but
  //    the retry route + re-queue is what the dashboard button drives.
  const retried = await app.handle("POST", `/queue/jobs/${flakyId}/retry`);
  console.log(`\nPOST /queue/jobs/${flakyId}/retry -> ${retried.status}`, body(retried));

  // 7. Discard a job outright (the second NOTIFY, now done) — the DLQ cleanup verb.
  const discarded = await app.handle("DELETE", `/queue/jobs/2`);
  console.log(`DELETE /queue/jobs/2 -> ${discarded.status}`, body(discarded));

  // 8. The throughput ledger through @lesto/admin (paginated + projected).
  const runs = body<{ runs: Record<string, unknown>[] }>(
    await app.handle("GET", "/admin/runs", { query: { limit: "3" } }),
  );
  console.log("\nGET /admin/runs?limit=3:");
  for (const run of runs.runs) {
    console.log(`  #${String(run["jobId"])} ${String(run["name"])} → ${String(run["outcome"])}`);
  }

  close();
}

await main();
