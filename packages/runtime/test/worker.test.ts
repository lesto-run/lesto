import Database from "better-sqlite3";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installSchema, Queue } from "@keel/queue";

import type { SqlDatabase } from "@keel/queue";

import { runWorker } from "../src/index";

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
});
