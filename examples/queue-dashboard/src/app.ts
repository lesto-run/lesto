/**
 * Assemble the queue-dashboard app from its parts.
 *
 * One composable `lesto()` app exposes the operator dashboard over the live
 * `@lesto/queue` state:
 *
 *   GET    /                      the dashboard page (SSR'd board island)
 *   GET    /__lesto/data/queue    the board's snapshot as JSON (poll/refresh tier)
 *   GET    /queue/jobs            list jobs (?status=&queue=&limit=&offset=)
 *   GET    /queue/jobs/:id        inspect one job (DLQ / poison detail)
 *   POST   /queue/jobs/:id/retry  re-queue a failed job
 *   DELETE /queue/jobs/:id        discard a non-running job
 *   GET    /queue/batches/:id     a batch's rollup (total, counts, state)
 *   GET    /admin/runs            the throughput ledger (paginated + projected, via @lesto/admin)
 *
 * The queue-specific verbs (`list` / `retry` / `discard` / `batch`) go STRAIGHT to
 * `@lesto/queue`'s operator surface — they are queue operations, not generic CRUD.
 * The run-ledger read goes through `@lesto/admin` (CRUD over the `job_runs` Table),
 * dogfooding its pagination + projection for the throughput panel. Two surfaces,
 * each used for what it is good at.
 *
 * `buildDashboardApp` is the pure routes-over-services factory (the unit the test
 * drives); `buildApp` is the boot wiring that stands up the db, the queue (with
 * its handlers + throughput observer), the admin service, and runs migrations +
 * the queue's own `installSchema`.
 */

import { createAdmin, AdminError } from "@lesto/admin";
import type { Admin } from "@lesto/admin";
import { createDb } from "@lesto/db";
import type { Db } from "@lesto/db";
import { createApp, type App, type KernelDatabase } from "@lesto/kernel";
import { installSchema, QueueError } from "@lesto/queue";
import type { JobStatus, Queue } from "@lesto/queue";
import { lesto } from "@lesto/web";
import type { Context, Lesto, LestoResponse } from "@lesto/web";

import { DashboardPage } from "./dashboard";
import { dashboardSource } from "./dashboard-source";
import { buildQueue, makeRunObserver } from "./operator";
import { buildSnapshot } from "./snapshot";
import { jobRuns, jobRunInsertSchema, jobRunUpdateSchema, migrations } from "./schema";

/** A non-negative integer from a query/path string, or `undefined` when absent or malformed. */
function toInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);

  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Map an `AdminError` code to the HTTP status the dashboard branches on. */
function statusForAdminError(code: string): number {
  switch (code) {
    case "ADMIN_UNKNOWN_RESOURCE":
    case "ADMIN_RECORD_NOT_FOUND":
      return 404;
    case "ADMIN_VALIDATION_FAILED":
    case "ADMIN_EMPTY_UPDATE":
      return 422;
    default:
      return 500;
  }
}

/** The HTTP-facing routes, closing over the queue + admin services they front. */
export function buildDashboardApp(deps: { queue: Queue; admin: Admin; db: Db }): Lesto {
  const { queue, admin, db } = deps;

  return (
    lesto()
      .client("/client.js")

      // The board island's data: the live snapshot, resolved at render (inlined
      // into the ssr island) and auto-exposed at /__lesto/data/queue for polling.
      .data(dashboardSource, () => buildSnapshot(queue, db))

      // The dashboard page — the SSR'd operator board.
      .page("/", {
        component: DashboardPage,
        metadata: () => ({ title: "Queue operator dashboard" }),
      })

      // ---- the queue operator surface (queue verbs, straight to @lesto/queue) ----

      .get("/queue/jobs", async (c) => {
        // Build the list options from only the filters that are present —
        // `exactOptionalPropertyTypes` rejects an explicit `undefined`.
        const status = c.query("status");
        const queueName = c.query("queue");
        const limit = toInt(c.query("limit"));
        const offset = toInt(c.query("offset"));

        // Assemble a MUTABLE options bag, then hand it to `list` (whose
        // `ListJobsOptions` is read-only); only set a key when present, so
        // `exactOptionalPropertyTypes` never sees an explicit `undefined`.
        const options: {
          status?: JobStatus;
          queue?: string;
          limit?: number;
          offset?: number;
        } = {};
        if (status !== undefined) options.status = status as JobStatus;
        if (queueName !== undefined) options.queue = queueName;
        if (limit !== undefined) options.limit = limit;
        if (offset !== undefined) options.offset = offset;

        return c.json({ jobs: await queue.list(options) });
      })

      .get("/queue/jobs/:id", async (c) => {
        const id = toInt(c.param("id"));
        if (id === undefined) return c.json({ error: "QUEUE_JOB_NOT_FOUND" }, 404);

        const job = await queue.find(id);

        return job === null ? c.json({ error: "QUEUE_JOB_NOT_FOUND" }, 404) : c.json({ job });
      })

      .post("/queue/jobs/:id/retry", async (c) => {
        const id = toInt(c.param("id"));
        if (id === undefined) return c.json({ error: "QUEUE_JOB_NOT_FOUND" }, 404);

        const requeued = await queue.retry(id);

        // `false` means the job was not in a retryable (`failed`) state — a stale
        // view or a double-click. 409 Conflict says "not in a state I can retry."
        return requeued ? c.json({ retried: id }) : c.json({ error: "QUEUE_NOT_RETRYABLE" }, 409);
      })

      .delete("/queue/jobs/:id", async (c) => {
        const id = toInt(c.param("id"));
        if (id === undefined) return c.json({ error: "QUEUE_JOB_NOT_FOUND" }, 404);

        const discarded = await queue.discard(id);

        // `false` means unknown or running — a running job is held by a worker.
        return discarded
          ? c.json({ discarded: id })
          : c.json({ error: "QUEUE_NOT_DISCARDABLE" }, 409);
      })

      .get("/queue/batches/:id", (c) => {
        const id = toInt(c.param("id"));
        if (id === undefined) return c.json({ error: "QUEUE_BATCH_NOT_FOUND" }, 404);

        return respondQueue(c, async () => ({ batch: await queue.batch(id) }));
      })

      // ---- the inspect surface (run ledger, through @lesto/admin) ----

      .get("/admin/runs", async (c) => {
        const limit = toInt(c.query("limit"));
        const offset = toInt(c.query("offset"));

        const options: { limit?: number; offset?: number } = {};
        if (limit !== undefined) options.limit = limit;
        if (offset !== undefined) options.offset = offset;

        return respondAdmin(c, async () => ({ runs: await admin.list("runs", options) }));
      })
  );
}

/** Run a queue op; map a `QUEUE_BATCH_NOT_FOUND` to 404, anything else re-raises. */
async function respondQueue(c: Context, op: () => Promise<unknown>): Promise<LestoResponse> {
  try {
    return c.json(await op());
  } catch (error) {
    if (error instanceof QueueError && error.code === "QUEUE_BATCH_NOT_FOUND") {
      return c.json({ error: error.code, message: error.message }, 404);
    }

    throw error;
  }
}

/** Run an admin op; on an `AdminError`, answer with its mapped status. */
async function respondAdmin(c: Context, op: () => Promise<unknown>): Promise<LestoResponse> {
  try {
    return c.json(await op());
  } catch (error) {
    if (error instanceof AdminError) {
      return c.json({ error: error.code, message: error.message }, statusForAdminError(error.code));
    }

    throw error;
  }
}

/** What `buildApp` returns: the booted app plus the handles run/serve/tests need. */
export interface Booted {
  app: App;
  db: Db;
  queue: Queue;
  admin: Admin;
}

export interface BuildOptions {
  /** The kernel database handle (from `@lesto/runtime`'s `openSqlite`). */
  handle: KernelDatabase;
}

/**
 * Boot the whole thing: wrap the handle as a typed `Db`, build the queue (with
 * its handlers + the throughput observer), build the `@lesto/admin` service over
 * the run ledger, and run the kernel — which installs the queue's own schema (via
 * `schemas: [installSchema]`) and the `job_runs` migration before dispatch.
 */
export async function buildApp(options: BuildOptions): Promise<Booted> {
  const { handle } = options;
  const db = createDb(handle);

  const queue = buildQueue(handle);

  // The admin manages ONLY the run ledger (a generic CRUD table). The queue's
  // own tables are managed by the queue's operator verbs, not the admin.
  const admin = createAdmin(db, [
    {
      name: "runs",
      table: jobRuns,
      insertSchema: jobRunInsertSchema,
      updateSchema: jobRunUpdateSchema,
      fields: ["jobId", "name", "outcome", "attempt", "durationMs", "at"],
    },
  ]);

  const app = await createApp({
    db: handle,
    app: buildDashboardApp({ queue, admin, db }),
    migrations,
    // The queue owns its tables; declare the dependency so the kernel installs
    // `lesto_jobs` + the batch/dep tables on boot (idempotent, IF NOT EXISTS).
    schemas: [installSchema],
  });

  return { app, db, queue, admin };
}

/** The throughput observer, exposed so run/serve/tests can attach it to a worker. */
export { makeRunObserver };
