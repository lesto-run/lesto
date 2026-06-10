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

// ---------------------------------------------------------------------------
// Test rig
//
// The SQL surface is async + positional (ADR 0006): the synchronous
// better-sqlite3 engine is adapted so each terminal resolves a Promise (zero
// latency) and binds an ordered `unknown[]`; `prepare()` stays sync.
// `transaction()` brackets BEGIN/COMMIT (ROLLBACK on reject) over the single
// in-memory connection.
// ---------------------------------------------------------------------------

function adapt(database: Database.Database): SqlDatabase {
  const adapted: SqlDatabase = {
    exec: async (statement) => {
      database.exec(statement);
    },
    prepare: (statement) => {
      const stmt = database.prepare(statement);

      return {
        run: async (params = []) => stmt.run(...(params as never[])),
        get: async (params = []) => stmt.get(...(params as never[])),
        all: async (params = []) => stmt.all(...(params as never[])),
      };
    },
    transaction: async (fn) => {
      database.exec("BEGIN");

      try {
        const out = await fn(adapted);
        database.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

let database: Database.Database;
let db: SqlDatabase;
let queue: Queue;

beforeEach(async () => {
  now = new Date("2026-06-08T12:00:00.000Z");
  database = new Database(":memory:");
  db = adapt(database);
  await installSchema(db);
  queue = new Queue({ db, clock, baseBackoffMs: 1000, maxBackoffMs: 3000 });
});

afterEach(() => {
  database.close();
});

// A macrotask-yielding sleep: an instantly-resolved promise would starve the
// test's own timers inside a tight poll loop.
const yieldingSleep = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 1));
};

// Poll a real condition (used only for the live-worker tests).
const waitUntil = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const start = Date.now();

  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

describe("enqueue", () => {
  it("returns the real id sourced from RETURNING id", async () => {
    const first = await queue.enqueue("x");
    const second = await queue.enqueue("x");

    // RETURNING id (not lastInsertRowid): real, monotonic, and Postgres-portable.
    expect(first).toBe(1);
    expect(second).toBe(2);
    expect((await queue.find(first))?.id).toBe(first);
  });

  it("schedules immediately, after a delay, or at an absolute time", async () => {
    const immediate = await queue.enqueue("x");
    expect((await queue.find(immediate))?.runAt).toBe(now.toISOString());

    const delayed = await queue.enqueue("x", {}, { delayMs: 5000 });
    expect((await queue.find(delayed))?.runAt).toBe(new Date(now.getTime() + 5000).toISOString());

    const future = new Date(now.getTime() + 99_000);
    const scheduled = await queue.enqueue("x", {}, { runAt: future });
    expect((await queue.find(scheduled))?.runAt).toBe(future.toISOString());
  });

  it("routes to named queues", async () => {
    queue.define("e", () => {});
    await queue.enqueue("e", {}, { queue: "emails" });

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

    const id = await queue.enqueue("greet", { name: "Ada" });
    const result = await queue.runOnce();

    expect(result?.outcome).toBe("done");
    expect(seen).toEqual(["Ada"]);
    expect((await queue.find(id))?.status).toBe("done");
    expect((await queue.find(id))?.finishedAt).not.toBeNull();
  });

  it("fails a job with no registered handler", async () => {
    const id = await queue.enqueue("ghost", {}, { maxAttempts: 1 });
    const result = await queue.runOnce();

    expect(result?.outcome).toBe("failed");
    expect((await queue.find(id))?.status).toBe("failed");
    expect((await queue.find(id))?.lastError).toContain("No handler");
  });

  it("retries on throw, then fails after maxAttempts", async () => {
    queue.define("boom", () => {
      throw new Error("nope");
    });
    const id = await queue.enqueue("boom", {}, { maxAttempts: 2 });

    expect((await queue.runOnce())?.outcome).toBe("retry");
    expect((await queue.find(id))?.status).toBe("ready");
    expect((await queue.find(id))?.lastError).toContain("nope");

    advance(1000);
    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(id))?.status).toBe("failed");
  });

  it("stringifies a non-Error throw", async () => {
    queue.define("weird", () => {
      throw "stringy"; // eslint-disable-line -- exercising the non-Error branch
    });
    const id = await queue.enqueue("weird", {}, { maxAttempts: 1 });
    await queue.runOnce();

    expect((await queue.find(id))?.lastError).toBe("stringy");
  });

  it("applies exponential backoff, capped at maxBackoffMs", async () => {
    queue.define("flaky", () => {
      throw new Error("boom");
    });
    const id = await queue.enqueue("flaky", {}, { maxAttempts: 10 });

    await queue.runOnce(); // attempt 1 → 1000 * 2^0 = 1000
    expect((await queue.find(id))?.runAt).toBe(new Date(now.getTime() + 1000).toISOString());

    advance(1000);
    await queue.runOnce(); // attempt 2 → 2000
    expect((await queue.find(id))?.runAt).toBe(new Date(now.getTime() + 2000).toISOString());

    advance(2000);
    await queue.runOnce(); // attempt 3 → 4000, capped to 3000
    expect((await queue.find(id))?.runAt).toBe(new Date(now.getTime() + 3000).toISOString());
  });
});

describe("claim & reclaim", () => {
  it("claims by priority, then by age", async () => {
    await queue.enqueue("x", { tag: "low" }, { priority: 0 });
    await queue.enqueue("x", { tag: "high" }, { priority: 10 });

    expect((await queue.claim())?.payload).toMatchObject({ tag: "high" });
  });

  it("does not claim a delayed job early", async () => {
    queue.define("later", () => {});
    await queue.enqueue("later", {}, { delayMs: 60_000 });

    expect(await queue.runOnce()).toBeNull();

    advance(60_000);
    expect((await queue.runOnce())?.outcome).toBe("done");
  });

  it("reclaims a job stranded past its visibility deadline", async () => {
    queue.define("slow", () => {});
    const id = await queue.enqueue("slow");

    expect((await queue.claim("default", 2000))?.id).toBe(id);
    expect((await queue.find(id))?.status).toBe("running");
    expect(await queue.reclaim()).toBe(0); // not yet stale

    advance(2001);
    expect(await queue.reclaim()).toBe(1); // now stale → reclaimed
    expect((await queue.find(id))?.status).toBe("ready");
  });
});

describe("stats & find", () => {
  it("counts by status and returns null for a missing id", async () => {
    queue.define("s", () => {});
    await queue.enqueue("s");
    await queue.enqueue("s");
    await queue.runOnce();

    expect(await queue.stats()).toMatchObject({ done: 1, ready: 1 });
    expect(await queue.find(99_999)).toBeNull();
  });
});

describe("work", () => {
  it("drains the queue with the default sleep and stops gracefully", async () => {
    const done: string[] = [];
    queue.define<{ tag: string }>("t", (payload) => {
      done.push(payload.tag);
    });
    await queue.enqueue("t", { tag: "a" });
    await queue.enqueue("t", { tag: "b" });

    const worker = queue.work(); // all defaults — covers the default poll interval
    await waitUntil(() => done.length === 2);
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

  // Wrap the real db so the FIRST prepare() throws a transient fault, then every
  // call after delegates normally. This models a DB blip on a single poll.
  const dbThatFailsOnce = (transient: Error): { db: SqlDatabase; failed: () => boolean } => {
    let thrown = false;

    const wrapped: SqlDatabase = {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        if (!thrown) {
          thrown = true;
          throw transient;
        }

        return db.prepare(sql);
      },
      transaction: (fn) => db.transaction(fn),
    };

    return { db: wrapped, failed: () => thrown };
  };

  it("survives a transient poll error: reports it and keeps processing", async () => {
    const transient = new Error("db unavailable");
    const { db: flaky, failed } = dbThatFailsOnce(transient);

    const reported: QueueError[] = [];
    const resilient = new Queue({ db: flaky, clock });
    const done: string[] = [];
    resilient.define<{ tag: string }>("t", (payload) => {
      done.push(payload.tag);
    });

    const worker = resilient.work({
      pollMs: 1,
      sleep: yieldingSleep,
      onError: (error) => reported.push(error),
    });

    // The very first poll throws; the loop must survive it. Once the db heals we
    // enqueue a job and it must be processed — proof the loop did not die.
    await waitUntil(() => failed());
    await resilient.enqueue("t", { tag: "after-failure" });

    await waitUntil(() => done.length === 1);
    await worker.stop();

    expect(done).toEqual(["after-failure"]);

    // The fault was surfaced through the seam as a coded, frozen QueueError that
    // carries the original cause — never swallowed.
    expect(reported.length).toBeGreaterThanOrEqual(1);
    const first = reported[0] as QueueError;
    expect(first.code).toBe("QUEUE_WORKER_POLL_FAILED");
    expect(first.details).toMatchObject({ cause: "db unavailable" });
    expect(Object.isFrozen(first.details)).toBe(true);
  });

  it("passes an already-coded QueueError through the seam unchanged", async () => {
    const coded = new QueueError("QUEUE_WORKER_POLL_FAILED", "already coded", { origin: "claim" });
    const { db: flaky } = dbThatFailsOnce(coded);

    const reported: QueueError[] = [];
    const resilient = new Queue({ db: flaky, clock });
    const worker = resilient.work({
      pollMs: 1,
      sleep: yieldingSleep,
      onError: (error) => reported.push(error),
    });

    await waitUntil(() => reported.length >= 1);
    await worker.stop();

    // Not re-wrapped: the original coded error reaches the seam verbatim.
    expect(reported[0]).toBe(coded);
  });

  it("stringifies a non-Error poll fault for the seam", async () => {
    let thrown = false;
    const flaky: SqlDatabase = {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        if (!thrown) {
          thrown = true;
          throw "stringy fault"; // eslint-disable-line -- exercising the non-Error branch
        }

        return db.prepare(sql);
      },
      transaction: (fn) => db.transaction(fn),
    };

    const reported: QueueError[] = [];
    const resilient = new Queue({ db: flaky, clock });
    const worker = resilient.work({
      pollMs: 1,
      sleep: yieldingSleep,
      onError: (error) => reported.push(error),
    });

    await waitUntil(() => reported.length >= 1);
    await worker.stop();

    expect((reported[0] as QueueError).details).toMatchObject({ cause: "stringy fault" });
  });

  it("survives a poll error with no onError seam, and a throwing reporter", async () => {
    const { db: flaky } = dbThatFailsOnce(new Error("blip"));

    const resilient = new Queue({ db: flaky, clock });
    const done: string[] = [];
    resilient.define<{ tag: string }>("t", (payload) => {
      done.push(payload.tag);
    });

    // No onError seam at all (covers the early return), AND we exercise the
    // throwing-reporter guard on a second worker below.
    const silent = resilient.work({ pollMs: 1, sleep: yieldingSleep });
    await resilient.enqueue("t", { tag: "no-seam" });

    await waitUntil(() => done.includes("no-seam"));
    await silent.stop();

    // A reporter that itself throws must not kill the loop.
    const { db: flaky2 } = dbThatFailsOnce(new Error("blip"));
    const q2 = new Queue({ db: flaky2, clock });
    q2.define<{ tag: string }>("t", (payload) => {
      done.push(payload.tag);
    });

    const loud = q2.work({
      pollMs: 1,
      sleep: yieldingSleep,
      onError: () => {
        throw new Error("reporter exploded");
      },
    });
    await q2.enqueue("t", { tag: "throwing-reporter" });

    await waitUntil(() => done.includes("throwing-reporter"));
    await loud.stop();

    expect(done).toContain("no-seam");
    expect(done).toContain("throwing-reporter");
  });
});

describe("transaction (claim atomicity seam)", () => {
  // The async seam exposes a first-class transaction() so a pooled Postgres
  // driver can pin one connection for a multi-statement span. The in-memory
  // adapter brackets BEGIN/COMMIT, ROLLBACK on reject — exercise both.
  it("commits when fn resolves and rolls back when it rejects", async () => {
    const id = await queue.enqueue("x");

    const out = await db.transaction(async (tx) => {
      await tx.prepare("UPDATE keel_jobs SET name = ? WHERE id = ?").run(["committed", id]);

      return "ok";
    });
    expect(out).toBe("ok");
    expect((await queue.find(id))?.name).toBe("committed");

    await expect(
      db.transaction(async (tx) => {
        await tx.prepare("UPDATE keel_jobs SET name = ? WHERE id = ?").run(["doomed", id]);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    // Rolled back: the doomed write never landed.
    expect((await queue.find(id))?.name).toBe("committed");
  });
});

describe("defaults", () => {
  it("falls back to the system clock and default tuning", async () => {
    const q2 = new Queue({ db, defaultQueue: "background" });
    q2.define("now", () => {});
    await q2.enqueue("now");

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
  it("ticks crons (deduped per minute) and intervals", async () => {
    const at = new Date(2026, 5, 8, 9, 30, 0);
    const schedule = new Scheduler({ queue, clock: () => at });
    schedule.cron("30 9 * * *", "digest");
    schedule.cron("31 9 * * *", "never");
    schedule.every(1000, "ping");

    expect(await schedule.tick(at)).toBe(2); // digest + first ping
    expect(await schedule.tick(at)).toBe(0); // cron deduped, ping not yet due

    expect(await schedule.tick(new Date(at.getTime() + 1000))).toBe(1); // ping due again
  });

  it("validates cron expressions at registration", () => {
    const schedule = new Scheduler({ queue });
    expect(() => schedule.cron("not-a-cron", "x")).toThrowError(QueueError);
  });

  it("start() ticks via injected timers and clears on stop", async () => {
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
    // The timer callback fires `tick()` fire-and-forget; the enqueue lands on a
    // microtask, so poll the durable count rather than asserting synchronously.
    const start = Date.now();
    while (((await queue.stats()).ready ?? 0) !== 1) {
      if (Date.now() - start > 1000) throw new Error("tick enqueue timed out");
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect((await queue.stats()).ready).toBe(1);

    handle.stop();
    expect(clearedHandle).toBe(7);
  });

  it("start() swallows a tick fault so the cadence survives", async () => {
    // A queue whose enqueue always rejects: the fire-and-forget tick must catch
    // it (no unhandled rejection) and the cadence keeps running.
    const failing: SqlDatabase = {
      exec: async () => {},
      prepare: () => ({
        run: async () => {
          throw new Error("enqueue down");
        },
        get: async () => {
          throw new Error("enqueue down");
        },
        all: async () => [],
      }),
      transaction: async (fn) => fn(failing),
    };
    const q3 = new Queue({ db: failing, clock: () => new Date(2026, 5, 8, 9, 30, 0) });
    const schedule = new Scheduler({ queue: q3, clock: () => new Date(2026, 5, 8, 9, 30, 0) });
    schedule.cron("30 9 * * *", "digest");

    let captured: (() => void) | undefined;
    const handle = schedule.start({
      setInterval: (callback) => {
        captured = callback;

        return 1;
      },
      clearInterval: () => {},
    });

    expect(() => (captured as () => void)()).not.toThrow();
    // Let the rejected tick settle through its .catch — no unhandled rejection.
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle.stop();
  });

  it("start() uses real timers by default", () => {
    const schedule = new Scheduler({ queue });
    schedule.start({ intervalMs: 10_000 }).stop(); // real setInterval/clearInterval
    schedule.start({ setInterval: () => 1, clearInterval: () => {} }).stop(); // default intervalMs
  });

  it("start() does not overlap ticks: a fire while one is in flight is skipped", async () => {
    const schedule = new Scheduler({ queue, clock: () => new Date(2026, 5, 8, 9, 30, 0) });
    schedule.cron("30 9 * * *", "digest");

    // Spy on tick to (a) hold each tick open until released and (b) record the
    // peak concurrency. With the no-overlap guard, two timer fires must yield a
    // peak of 1; without it, the second fire would start a concurrent tick (2).
    let inFlight = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realTick = schedule.tick.bind(schedule);
    schedule.tick = async (when?: Date) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await held;
      const fired = await realTick(when);
      inFlight -= 1;

      return fired;
    };

    let captured: (() => void) | undefined;
    const handle = schedule.start({
      setInterval: (callback) => {
        captured = callback;

        return 1;
      },
      clearInterval: () => {},
    });

    (captured as () => void)(); // tick 1 starts, holds open (ticking = true)
    await new Promise((resolve) => setTimeout(resolve, 5));
    (captured as () => void)(); // fires while tick 1 in flight → must be skipped
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(peak).toBe(1);

    release?.(); // let tick 1 finish
    await new Promise((resolve) => setTimeout(resolve, 5));
    handle.stop();
  });
});
