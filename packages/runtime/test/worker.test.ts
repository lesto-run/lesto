import Database from "better-sqlite3";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installSchema, Queue, QueueError } from "@lesto/queue";

import type { SqlDatabase } from "@lesto/queue";

import { defaultWorkerErrorSink, runWorker } from "../src/index";

let database: Database.Database;
let queue: Queue;

beforeEach(async () => {
  database = new Database(":memory:");
  await installSchema(database as unknown as SqlDatabase);
  queue = new Queue({ db: database as unknown as SqlDatabase });
});

afterEach(() => {
  database.close();
});

/** Poll a real condition without starving the macrotask queue. */
async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();

  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("runWorker", () => {
  it("drains an enqueued job to completion, then stops gracefully", async () => {
    let ran = false;

    queue.define("greet", async () => {
      ran = true;
    });

    const id = await queue.enqueue("greet", { name: "ada" });

    const worker = runWorker(queue);

    await waitUntil(() => ran);

    await worker.stop();

    expect((await queue.find(id))?.status).toBe("done");
  });

  it("forwards the concurrency option to the queue worker", async () => {
    let ran = false;

    queue.define("greet", async () => {
      ran = true;
    });

    await queue.enqueue("greet");

    const worker = runWorker(queue, { concurrency: 2 });

    await waitUntil(() => ran);

    await worker.stop();

    expect(ran).toBe(true);
  });

  it("forwards a poll-loop fault to the injected onError sink", async () => {
    // A db that throws on its first `prepare` — the claim — provokes a poll-loop
    // fault outside any handler, which the queue surfaces through its onError seam.
    let thrown = false;

    const real = database as unknown as SqlDatabase;

    const flaky: SqlDatabase = {
      exec: (sql) => real.exec(sql),
      prepare: (sql) => {
        if (!thrown) {
          thrown = true;
          throw new Error("db unavailable");
        }

        return real.prepare(sql);
      },
      transaction: (fn) => real.transaction(fn),
    };

    const resilient = new Queue({ db: flaky });

    const reported: QueueError[] = [];

    // A 1ms poll so the first (throwing) claim happens promptly.
    const worker = runWorker(resilient, { onError: (error) => reported.push(error) });

    await waitUntil(() => reported.length >= 1);

    await worker.stop();

    // The fault reaches the sink as a coded QueueError — never silently dropped.
    expect(reported[0]?.code).toBe("QUEUE_WORKER_POLL_FAILED");
    expect(reported[0]?.details).toMatchObject({ cause: "db unavailable" });
  });

  it("routes poll faults to a structured stderr line by default (no sink injected)", async () => {
    let thrown = false;

    const real = database as unknown as SqlDatabase;

    const flaky: SqlDatabase = {
      exec: (sql) => real.exec(sql),
      prepare: (sql) => {
        if (!thrown) {
          thrown = true;
          throw new Error("db unavailable");
        }

        return real.prepare(sql);
      },
      transaction: (fn) => real.transaction(fn),
    };

    const resilient = new Queue({ db: flaky });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // No onError: the runner installs its default structured-stderr sink.
    const worker = runWorker(resilient);

    await waitUntil(() => errorSpy.mock.calls.length >= 1);

    await worker.stop();

    const line = JSON.parse(errorSpy.mock.calls[0]?.[0] as string);

    expect(line).toMatchObject({
      level: "error",
      event: "worker.poll_failed",
      code: "QUEUE_WORKER_POLL_FAILED",
    });
    expect(typeof line.message).toBe("string");

    errorSpy.mockRestore();
  });
});

describe("defaultWorkerErrorSink", () => {
  it("writes one structured JSON line carrying the error's code and message", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    defaultWorkerErrorSink(
      new QueueError("QUEUE_WORKER_POLL_FAILED", "the worker poll loop hit an error", {}),
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);

    expect(JSON.parse(errorSpy.mock.calls[0]?.[0] as string)).toEqual({
      level: "error",
      event: "worker.poll_failed",
      code: "QUEUE_WORKER_POLL_FAILED",
      message: "the worker poll loop hit an error",
    });

    errorSpy.mockRestore();
  });
});
