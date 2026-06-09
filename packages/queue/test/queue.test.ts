import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cronMatches, installSchema, Queue, QueueError, Scheduler } from "../src/index";

import type { SqlDatabase } from "../src/index";

// A clock we can stop, so every time-dependent path is deterministic.
let now: Date;
const clock = (): Date => now;
const advance = (ms: number): void => {
  now = new Date(now.getTime() + ms);
};

let database: Database.Database;
let db: SqlDatabase;
let queue: Queue;

beforeEach(() => {
  now = new Date("2026-06-08T12:00:00.000Z");
  database = new Database(":memory:");
  db = database as unknown as SqlDatabase;
  installSchema(db);
  queue = new Queue({ db, clock, baseBackoffMs: 1000, maxBackoffMs: 3000 });
});

afterEach(() => {
  database.close();
});

// Poll a real condition (used only for the live-worker tests).
const waitUntil = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();

  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

describe("enqueue", () => {
  it("schedules immediately, after a delay, or at an absolute time", () => {
    const immediate = queue.enqueue("x");
    expect(queue.find(immediate)?.runAt).toBe(now.toISOString());

    const delayed = queue.enqueue("x", {}, { delayMs: 5000 });
    expect(queue.find(delayed)?.runAt).toBe(new Date(now.getTime() + 5000).toISOString());

    const future = new Date(now.getTime() + 99_000);
    const scheduled = queue.enqueue("x", {}, { runAt: future });
    expect(queue.find(scheduled)?.runAt).toBe(future.toISOString());
  });

  it("routes to named queues", async () => {
    queue.define("e", () => {});
    queue.enqueue("e", {}, { queue: "emails" });

    expect(await queue.runOnce()).toBeNull(); // default queue is empty
    expect((await queue.runOnce({ queue: "emails", visibilityMs: 5000 }))?.outcome).toBe("done");
  });
});

describe("define", () => {
  it("rejects a non-function handler with a coded, frozen error", () => {
    try {
      queue.define("bad", 123 as unknown as () => void);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueueError);
      expect((error as QueueError).code).toBe("QUEUE_HANDLER_NOT_A_FUNCTION");
      expect((error as QueueError).details).toEqual({ name: "bad" });
      expect(Object.isFrozen((error as QueueError).details)).toBe(true);
    }
  });
});

describe("runOnce", () => {
  it("returns null when idle", async () => {
    expect(await queue.runOnce()).toBeNull();
  });

  it("runs a job to completion", async () => {
    const seen: string[] = [];
    queue.define<{ name: string }>("greet", (payload) => {
      seen.push(payload.name);
    });

    const id = queue.enqueue("greet", { name: "Ada" });
    const result = await queue.runOnce();

    expect(result?.outcome).toBe("done");
    expect(seen).toEqual(["Ada"]);
    expect(queue.find(id)?.status).toBe("done");
    expect(queue.find(id)?.finishedAt).not.toBeNull();
  });

  it("fails a job with no registered handler", async () => {
    const id = queue.enqueue("ghost", {}, { maxAttempts: 1 });
    const result = await queue.runOnce();

    expect(result?.outcome).toBe("failed");
    expect(queue.find(id)?.status).toBe("failed");
    expect(queue.find(id)?.lastError).toContain("No handler");
  });

  it("retries on throw, then fails after maxAttempts", async () => {
    queue.define("boom", () => {
      throw new Error("nope");
    });
    const id = queue.enqueue("boom", {}, { maxAttempts: 2 });

    expect((await queue.runOnce())?.outcome).toBe("retry");
    expect(queue.find(id)?.status).toBe("ready");
    expect(queue.find(id)?.lastError).toContain("nope");

    advance(1000);
    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect(queue.find(id)?.status).toBe("failed");
  });

  it("stringifies a non-Error throw", async () => {
    queue.define("weird", () => {
      throw "stringy"; // eslint-disable-line -- exercising the non-Error branch
    });
    const id = queue.enqueue("weird", {}, { maxAttempts: 1 });
    await queue.runOnce();

    expect(queue.find(id)?.lastError).toBe("stringy");
  });

  it("applies exponential backoff, capped at maxBackoffMs", async () => {
    queue.define("flaky", () => {
      throw new Error("boom");
    });
    const id = queue.enqueue("flaky", {}, { maxAttempts: 10 });

    await queue.runOnce(); // attempt 1 → 1000 * 2^0 = 1000
    expect(queue.find(id)?.runAt).toBe(new Date(now.getTime() + 1000).toISOString());

    advance(1000);
    await queue.runOnce(); // attempt 2 → 2000
    expect(queue.find(id)?.runAt).toBe(new Date(now.getTime() + 2000).toISOString());

    advance(2000);
    await queue.runOnce(); // attempt 3 → 4000, capped to 3000
    expect(queue.find(id)?.runAt).toBe(new Date(now.getTime() + 3000).toISOString());
  });
});

describe("claim & reclaim", () => {
  it("claims by priority, then by age", () => {
    queue.enqueue("x", { tag: "low" }, { priority: 0 });
    queue.enqueue("x", { tag: "high" }, { priority: 10 });

    expect(queue.claim()?.payload).toMatchObject({ tag: "high" });
  });

  it("does not claim a delayed job early", async () => {
    queue.define("later", () => {});
    queue.enqueue("later", {}, { delayMs: 60_000 });

    expect(await queue.runOnce()).toBeNull();

    advance(60_000);
    expect((await queue.runOnce())?.outcome).toBe("done");
  });

  it("reclaims a job stranded past its visibility deadline", () => {
    queue.define("slow", () => {});
    const id = queue.enqueue("slow");

    expect(queue.claim("default", 2000)?.id).toBe(id);
    expect(queue.find(id)?.status).toBe("running");
    expect(queue.reclaim()).toBe(0); // not yet stale

    advance(2001);
    expect(queue.reclaim()).toBe(1); // now stale → reclaimed
    expect(queue.find(id)?.status).toBe("ready");
  });
});

describe("stats & find", () => {
  it("counts by status and returns null for a missing id", async () => {
    queue.define("s", () => {});
    queue.enqueue("s");
    queue.enqueue("s");
    await queue.runOnce();

    expect(queue.stats()).toMatchObject({ done: 1, ready: 1 });
    expect(queue.find(99_999)).toBeNull();
  });
});

describe("work", () => {
  it("drains the queue with the default sleep and stops gracefully", async () => {
    const done: string[] = [];
    queue.define<{ tag: string }>("t", (payload) => {
      done.push(payload.tag);
    });
    queue.enqueue("t", { tag: "a" });
    queue.enqueue("t", { tag: "b" });

    const worker = queue.work(); // all defaults — covers the default poll interval
    await waitUntil(() => (queue.stats().done ?? 0) === 2);
    await worker.stop();

    expect(done.toSorted()).toEqual(["a", "b"]);
  });

  it("uses an injected sleep when idle", async () => {
    let slept = 0;
    const worker = queue.work({
      queue: "default",
      concurrency: 1,
      visibilityMs: 10_000,
      pollMs: 5,
      sleep: async () => {
        slept += 1;

        // Yield a *macrotask*: an instantly-resolved sleep would starve the
        // macrotask queue (and the test's own timers) in this tight poll loop.
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });

    await waitUntil(() => slept >= 2);
    await worker.stop();

    expect(slept).toBeGreaterThanOrEqual(2);
  });
});

describe("defaults", () => {
  it("falls back to the system clock and default tuning", async () => {
    const q2 = new Queue({ db, defaultQueue: "background" });
    q2.define("now", () => {});
    q2.enqueue("now");

    expect((await q2.runOnce())?.outcome).toBe("done");

    const schedule = new Scheduler({ queue: q2 });
    schedule.cron("* * * * *", "x"); // uses the default (system) clock to validate
  });
});

describe("cronMatches", () => {
  const date = new Date(2026, 5, 8, 9, 30, 0); // local: 09:30, day 8, month 6

  it("matches wildcard, step, range, list, and exact", () => {
    expect(cronMatches("* * * * *", date)).toBe(true);
    expect(cronMatches("30 9 * * *", date)).toBe(true);
    expect(cronMatches("31 9 * * *", date)).toBe(false);
    expect(cronMatches("*/15 * * * *", date)).toBe(true);
    expect(cronMatches("*/7 * * * *", date)).toBe(false);
    expect(cronMatches("0-45 * * * *", date)).toBe(true);
    expect(cronMatches("0,15,30 * * * *", date)).toBe(true);
    expect(cronMatches("0,15,45 * * * *", date)).toBe(false);
  });

  it("rejects a malformed expression", () => {
    expect(() => cronMatches("* * *", date)).toThrowError(QueueError);
  });
});

describe("Scheduler", () => {
  it("ticks crons (deduped per minute) and intervals", () => {
    const at = new Date(2026, 5, 8, 9, 30, 0);
    const schedule = new Scheduler({ queue, clock: () => at });
    schedule.cron("30 9 * * *", "digest");
    schedule.cron("31 9 * * *", "never");
    schedule.every(1000, "ping");

    expect(schedule.tick(at)).toBe(2); // digest + first ping
    expect(schedule.tick(at)).toBe(0); // cron deduped, ping not yet due

    expect(schedule.tick(new Date(at.getTime() + 1000))).toBe(1); // ping due again
  });

  it("validates cron expressions at registration", () => {
    const schedule = new Scheduler({ queue });
    expect(() => schedule.cron("not-a-cron", "x")).toThrowError(QueueError);
  });

  it("start() ticks via injected timers and clears on stop", () => {
    const at = new Date(2026, 5, 8, 9, 30, 0);
    const schedule = new Scheduler({ queue, clock: () => at });
    schedule.cron("30 9 * * *", "digest");

    let captured: (() => void) | undefined;
    let clearedHandle: unknown;
    const handle = schedule.start({
      intervalMs: 50,
      setInterval: (callback) => {
        captured = callback;

        return 7;
      },
      clearInterval: (h) => {
        clearedHandle = h;
      },
    });

    expect(captured).toBeTypeOf("function");
    (captured as () => void)();
    expect(queue.stats().ready).toBe(1);

    handle.stop();
    expect(clearedHandle).toBe(7);
  });

  it("start() uses real timers by default", () => {
    const schedule = new Scheduler({ queue });
    schedule.start({ intervalMs: 10_000 }).stop(); // real setInterval/clearInterval
    schedule.start({ setInterval: () => 1, clearInterval: () => {} }).stop(); // default intervalMs
  });
});
