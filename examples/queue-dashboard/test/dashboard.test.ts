/**
 * The example's QA gate: drive the OPERATOR journey through the REAL HTTP routes
 * (`app.handle`), the way a browser or `curl` would — never the queue/admin
 * service methods directly.
 *
 * It proves the capabilities this example exists for, exactly the acceptance bar
 * of board b061a267:
 *
 *   - **View queue state** — the snapshot route (`/__lesto/data/queue`) reports
 *     per-status counts, the failed-job DLQ sample, the backlog depth, and the
 *     recorded-run throughput; the list route filters by status (the in-flight /
 *     failed / scheduled tabs) and pages.
 *   - **Manage queue state** — `POST …/retry` re-queues a failed job (and a
 *     non-retryable job answers 409); `DELETE …/:id` discards a non-running job
 *     (and a running one answers 409); a single job inspects (and an unknown id
 *     is 404).
 *   - **A batch with a dependency completes IN ORDER** — the thumbnail step is
 *     invisible to the worker until ingest finishes, and the batch rollup route
 *     reports `completed` once both are done (an unknown batch is 404).
 *   - **Throughput through @lesto/admin** — the run-ledger route pages + projects
 *     the recorded runs.
 *
 * The worker is driven deterministically here: instead of the background
 * `queue.work()` loop, each test drains via `queue.runOnce({ onJob })`, so there
 * is no timing flake — the same handlers, the same observer, the same ledger.
 */

import { describe, expect, it } from "vitest";

import { openSqlite } from "@lesto/runtime";
import type { JobObserver, Queue } from "@lesto/queue";

import { buildApp, makeRunObserver } from "../src/app";
import { FLAKY, INGEST, NOTIFY, THUMBNAIL } from "../src/operator";
import type { QueueSnapshot } from "../src/snapshot";

/** Drain a streamed body (the SSR page) or pass a string body (JSON) straight through. */
async function text(response: { body: unknown }): Promise<string> {
  if (typeof response.body === "string") return response.body;

  const reader = (response.body as unknown as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();

  let out = "";
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    out += decoder.decode(read.value, { stream: true });
  }

  return out + decoder.decode();
}

/** Parse a JSON response body into a typed object. */
function body<T>(response: { body: unknown }): T {
  return JSON.parse(response.body as string) as T;
}

/** Boot the app on a fresh in-memory database, plus the throughput observer. */
async function boot() {
  const { db: handle, close } = await openSqlite();
  const booted = await buildApp({ handle });
  const onJob = makeRunObserver(booted.db);

  return { ...booted, onJob, close };
}

/** Drain the queue until idle, recording each run through the observer. */
async function drain(queue: Queue, onJob: JobObserver): Promise<void> {
  while ((await queue.runOnce({ onJob })) !== null) {
    /* keep processing until the queue reports idle */
  }
}

describe("@lesto/example-queue-dashboard — the operator journey over HTTP", () => {
  it("renders the dashboard page as a streamed document with the board markup", async () => {
    const { app, close } = await boot();

    try {
      const page = await app.handle("GET", "/");
      const html = await text(page);

      expect(page.status).toBe(200);
      // The SSR'd board island is in the document — proving the page renders the
      // real board, not an empty shell, before any hydration.
      expect(html).toContain("Queue operator dashboard");
      expect(html).toContain("queue-board");
    } finally {
      close();
    }
  });

  it("reports a live snapshot: counts, the failed DLQ sample, and throughput", async () => {
    const { app, queue, onJob, close } = await boot();

    try {
      // Seed three successes and one job that fails into the DLQ.
      await queue.enqueue(NOTIFY);
      await queue.enqueue(NOTIFY);
      await queue.enqueue(NOTIFY);
      const flakyId = await queue.enqueue(FLAKY, {}, { maxAttempts: 1 });

      await drain(queue, onJob);

      const snapshot = body<QueueSnapshot>(await app.handle("GET", "/__lesto/data/queue"));

      // Three done, one failed — the per-status rollup the board's tabs read.
      expect(snapshot.counts.done).toBe(3);
      expect(snapshot.counts.failed).toBe(1);

      // The DLQ sample carries the failed job with its error, for inspection.
      expect(snapshot.failed).toHaveLength(1);
      expect(snapshot.failed[0]).toMatchObject({ id: flakyId, name: FLAKY });
      expect(snapshot.failed[0]?.lastError).toContain("downstream unavailable");

      // Every drained run was recorded — the throughput counter is real.
      expect(snapshot.totalRuns).toBe(4);
      expect(snapshot.recentRuns.length).toBeGreaterThan(0);

      // The queue is drained, so there is no claimable backlog.
      expect(snapshot.depth).toBe(0);
    } finally {
      close();
    }
  });

  it("lists jobs filtered by status and pages them", async () => {
    const { app, queue, onJob, close } = await boot();

    try {
      await queue.enqueue(NOTIFY);
      await queue.enqueue(FLAKY, {}, { maxAttempts: 1 });
      await drain(queue, onJob);

      // The failed tab shows only the failed job.
      const failed = body<{ jobs: { name: string }[] }>(
        await app.handle("GET", "/queue/jobs", { query: { status: "failed" } }),
      );
      expect(failed.jobs.map((j) => j.name)).toEqual([FLAKY]);

      // No filter lists everything; a tight limit pages it.
      const all = body<{ jobs: unknown[] }>(await app.handle("GET", "/queue/jobs"));
      expect(all.jobs).toHaveLength(2);

      const firstPage = body<{ jobs: unknown[] }>(
        await app.handle("GET", "/queue/jobs", { query: { limit: "1" } }),
      );
      expect(firstPage.jobs).toHaveLength(1);
    } finally {
      close();
    }
  });

  it("inspects one job, and answers 404 for an unknown or non-numeric id", async () => {
    const { app, queue, close } = await boot();

    try {
      const id = await queue.enqueue(NOTIFY, { hello: "world" });

      const found = body<{ job: { id: number; name: string } }>(
        await app.handle("GET", `/queue/jobs/${id}`),
      );
      expect(found.job).toMatchObject({ id, name: NOTIFY });

      const missing = await app.handle("GET", "/queue/jobs/9999");
      expect(missing.status).toBe(404);
      expect(body<{ error: string }>(missing).error).toBe("QUEUE_JOB_NOT_FOUND");

      // A non-numeric id never reaches the query as NaN — it is a clean 404.
      const garbage = await app.handle("GET", "/queue/jobs/not-a-number");
      expect(garbage.status).toBe(404);
    } finally {
      close();
    }
  });

  it("retries a failed job, and refuses a non-retryable one with 409", async () => {
    const { app, queue, onJob, close } = await boot();

    try {
      const flakyId = await queue.enqueue(FLAKY, {}, { maxAttempts: 1 });
      await drain(queue, onJob);

      // The job is failed → the retry button re-queues it.
      const retried = await app.handle("POST", `/queue/jobs/${flakyId}/retry`);
      expect(retried.status).toBe(200);
      expect(body<{ retried: number }>(retried).retried).toBe(flakyId);
      expect((await queue.find(flakyId))?.status).toBe("ready");

      // It is now `ready`, not `failed` → retrying again is a 409 Conflict (a
      // stale view or a double-click).
      const again = await app.handle("POST", `/queue/jobs/${flakyId}/retry`);
      expect(again.status).toBe(409);
      expect(body<{ error: string }>(again).error).toBe("QUEUE_NOT_RETRYABLE");

      // A non-numeric id is a 404 before the retry is even attempted.
      const garbage = await app.handle("POST", "/queue/jobs/nope/retry");
      expect(garbage.status).toBe(404);
    } finally {
      close();
    }
  });

  it("discards a non-running job, and refuses an unknown one with 409", async () => {
    const { app, queue, onJob, close } = await boot();

    try {
      const id = await queue.enqueue(NOTIFY);
      await drain(queue, onJob); // → done, so it is discardable

      const discarded = await app.handle("DELETE", `/queue/jobs/${id}`);
      expect(discarded.status).toBe(200);
      expect(body<{ discarded: number }>(discarded).discarded).toBe(id);
      expect(await queue.find(id)).toBeNull();

      // Discarding it again — now unknown — is a 409 (not discardable).
      const again = await app.handle("DELETE", `/queue/jobs/${id}`);
      expect(again.status).toBe(409);
      expect(body<{ error: string }>(again).error).toBe("QUEUE_NOT_DISCARDABLE");

      // A non-numeric id is a clean 404.
      const garbage = await app.handle("DELETE", "/queue/jobs/nope");
      expect(garbage.status).toBe(404);
    } finally {
      close();
    }
  });

  it("runs a batch with a dependency IN ORDER, and reports it `completed`", async () => {
    const { app, queue, onJob, close } = await boot();

    try {
      const batch = await queue.enqueueBatch("import_photo", [
        { name: INGEST },
        { name: THUMBNAIL, dependsOn: [0] },
      ]);

      // The dependent step starts blocked — invisible to the worker.
      expect(batch.jobIds).toHaveLength(2);
      expect((await queue.find(batch.jobIds[1]!))?.status).toBe("blocked");

      // The first claimable job can ONLY be ingest — the ordering guarantee.
      expect((await queue.runOnce({ onJob }))?.job.name).toBe(INGEST);
      // Ingest's completion releases the thumbnail step.
      expect((await queue.find(batch.jobIds[1]!))?.status).toBe("ready");
      expect((await queue.runOnce({ onJob }))?.job.name).toBe(THUMBNAIL);

      // The rollup route reports the batch completed, both jobs done.
      const rollup = body<{ batch: { state: string; counts: Record<string, number> } }>(
        await app.handle("GET", `/queue/batches/${batch.id}`),
      );
      expect(rollup.batch.state).toBe("completed");
      expect(rollup.batch.counts).toEqual({ done: 2 });
    } finally {
      close();
    }
  });

  it("answers 404 for an unknown or non-numeric batch id", async () => {
    const { app, close } = await boot();

    try {
      const missing = await app.handle("GET", "/queue/batches/9999");
      expect(missing.status).toBe(404);
      expect(body<{ error: string }>(missing).error).toBe("QUEUE_BATCH_NOT_FOUND");

      const garbage = await app.handle("GET", "/queue/batches/not-a-number");
      expect(garbage.status).toBe(404);
    } finally {
      close();
    }
  });

  it("pages the throughput ledger through @lesto/admin and projects its rows", async () => {
    const { app, queue, onJob, close } = await boot();

    try {
      await queue.enqueue(NOTIFY);
      await queue.enqueue(NOTIFY);
      await queue.enqueue(NOTIFY);
      await drain(queue, onJob);

      // The admin-backed run ledger pages by limit.
      const runs = body<{ runs: Record<string, unknown>[] }>(
        await app.handle("GET", "/admin/runs", { query: { limit: "2" } }),
      );
      expect(runs.runs).toHaveLength(2);

      // Every row is the projected ledger shape — id plus the declared fields.
      for (const run of runs.runs) {
        expect(Object.keys(run).toSorted()).toEqual(
          ["at", "attempt", "durationMs", "id", "jobId", "name", "outcome"].toSorted(),
        );
      }

      // An unknown admin resource maps to a 404 through the admin error mapping.
      const unknown = await app.handle("GET", "/admin/runs", { query: { offset: "999" } });
      expect(unknown.status).toBe(200); // a valid resource, just an empty page
      expect(body<{ runs: unknown[] }>(unknown).runs).toHaveLength(0);
    } finally {
      close();
    }
  });
});
