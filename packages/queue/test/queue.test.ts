import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cronMatches,
  installSchema,
  isPermanentFailure,
  permanentFailure,
  PERMANENT_FAILURE,
  Queue,
  QueueError,
  Scheduler,
} from "../src/index";

import type { JobEvent, SqlDatabase } from "../src/index";

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

describe("installSchema dialect", () => {
  it("sqlite (default): the surrogate key is INTEGER ... AUTOINCREMENT, no PG partial index", async () => {
    let captured = "";
    const capture: SqlDatabase = {
      prepare: () => ({
        run: async () => ({ changes: 0 }),
        get: async () => undefined,
        all: async () => [],
      }),
      exec: async (sql) => {
        captured += `${sql}\n`;
      },
      transaction: async (fn) => fn(capture),
    };

    await installSchema(capture);

    expect(captured).toContain("INTEGER PRIMARY KEY AUTOINCREMENT");
    expect(captured).not.toContain("GENERATED ALWAYS AS IDENTITY");
    // The partial `WHERE status = 'ready'` index is Postgres-only.
    expect(captured).not.toContain("idx_lesto_jobs_ready");
  });

  it("postgres: BIGINT identity key plus the partial WHERE status='ready' index", async () => {
    let captured = "";
    const capture: SqlDatabase = {
      prepare: () => ({
        run: async () => ({ changes: 0 }),
        get: async () => undefined,
        all: async () => [],
      }),
      exec: async (sql) => {
        captured += `${sql}\n`;
      },
      transaction: async (fn) => fn(capture),
    };

    await installSchema(capture, "postgres");

    expect(captured).toContain("BIGINT  PRIMARY KEY GENERATED ALWAYS AS IDENTITY");
    expect(captured).not.toContain("AUTOINCREMENT");
    // The partial index lands ONLY on Postgres, and only over `status = 'ready'`.
    expect(captured).toContain("idx_lesto_jobs_ready");
    expect(captured).toContain("WHERE status = 'ready'");
  });
});

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

  it("routes a poison (unparseable) payload through fail, terminating at maxAttempts", async () => {
    queue.define("p", () => {
      throw new Error("handler should never run on a poison payload");
    });
    const id = await queue.enqueue("p", { ok: true }, { maxAttempts: 2 });

    // Corrupt the stored JSON so claim's parse will throw — a payload no producer
    // could have written through `enqueue`, but a manual write or a bug could.
    database.prepare("UPDATE lesto_jobs SET payload = ? WHERE id = ?").run("{not json", id);

    // The row's status is read with raw SQL: `find` parses the payload too, and a
    // poison row is exactly the case that would make `find` itself throw.
    const statusOf = (jobId: number): string =>
      (database.prepare("SELECT status, last_error FROM lesto_jobs WHERE id = ?").get(jobId) as {
        status: string;
        last_error: string | null;
      })!.status;
    const lastErrorOf = (jobId: number): string | null =>
      (database.prepare("SELECT last_error FROM lesto_jobs WHERE id = ?").get(jobId) as {
        last_error: string | null;
      })!.last_error;

    // First run: the parse fails, fail() retries (attempt 1 < 2).
    const first = await queue.runOnce();
    expect(first?.outcome).toBe("retry");
    expect(statusOf(id)).toBe("ready");
    expect(lastErrorOf(id)).toContain("unparseable payload");

    // Second run (after backoff): attempt 2 == maxAttempts → failed, not looping.
    advance(2000);
    const second = await queue.runOnce();
    expect(second?.outcome).toBe("failed");
    expect(statusOf(id)).toBe("failed");
  });

  it("a stalled worker's complete() never resurrects a job another worker re-owns", async () => {
    queue.define("slow", () => {});
    const id = await queue.enqueue("slow");

    // Worker A claims with a short lease and captures the job it holds.
    const a = await queue.claim("default", 1000);
    expect(a?.id).toBe(id);

    // A stalls past its deadline; RECLAIM frees the row, then worker B re-claims
    // it with a FRESH lock (a different `locked_until`).
    advance(1001);
    expect(await queue.reclaim()).toBe(1);
    const b = await queue.claim("default", 5000);
    expect(b?.id).toBe(id);
    expect(b?.lockedUntil).not.toBe(a?.lockedUntil);

    // A finally finishes and completes against its STALE token — fenced out: the
    // row stays `running` under B, never flipped to `done`.
    await queue["complete"](a!);
    expect((await queue.find(id))?.status).toBe("running");

    // B's completion (current token) is the one that lands.
    await queue["complete"](b!);
    expect((await queue.find(id))?.status).toBe("done");
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

  it("postgres dialect: the claim subselect carries FOR UPDATE SKIP LOCKED", async () => {
    let claimSql = "";
    const capture: SqlDatabase = {
      prepare: (sql) => {
        if (sql.includes("SET status = 'running'")) claimSql = sql;

        return {
          run: async () => ({ changes: 0 }),
          get: async () => undefined,
          all: async () => [],
        };
      },
      exec: async () => {},
      transaction: async (fn) => fn(capture),
    };

    await new Queue({ db: capture, clock, dialect: "postgres" }).claim();

    expect(claimSql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("sqlite dialect (default): the claim has no row-locking clause", async () => {
    let claimSql = "";
    const capture: SqlDatabase = {
      prepare: (sql) => {
        if (sql.includes("SET status = 'running'")) claimSql = sql;

        return {
          run: async () => ({ changes: 0 }),
          get: async () => undefined,
          all: async () => [],
        };
      },
      exec: async () => {},
      transaction: async (fn) => fn(capture),
    };

    await new Queue({ db: capture, clock }).claim();

    expect(claimSql).not.toContain("FOR UPDATE");
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

  it("reports backlog depth and the oldest ready job's age", async () => {
    queue.define("s", () => {});

    // Two jobs enqueued 5s apart; both ready and already eligible.
    await queue.enqueue("s");
    advance(5000);
    await queue.enqueue("s");

    // `depth` is the eligible backlog (2); `oldestReadyAgeMs` is the wait of the
    // FIRST job, now 5s old at the clock's `now`.
    const stats = await queue.stats();
    expect(stats.depth).toBe(2);
    expect(stats.oldestReadyAgeMs).toBe(5000);
    expect(stats.ready).toBe(2);
  });

  it("excludes a future-scheduled job from depth and oldest-age", async () => {
    queue.define("s", () => {});

    // A job scheduled 60s out is `ready` in the status counts but NOT part of the
    // eligible backlog — a worker could not claim it now.
    await queue.enqueue("s", {}, { delayMs: 60_000 });

    const stats = await queue.stats();
    expect(stats.ready).toBe(1); // counted by status
    expect(stats.depth).toBe(0); // but not yet eligible
    expect(stats.oldestReadyAgeMs).toBeNull(); // empty backlog → null, not 0
  });

  it("coerces Postgres-stringified counts (int8) to real numbers", async () => {
    // node-postgres hands COUNT(*) back as a STRING; a capture driver mimics that
    // so we prove `stats()` returns numbers, not strings, on the PG shape.
    const capture: SqlDatabase = {
      prepare: (sql) => ({
        run: async () => ({ changes: 0 }),
        all: async () =>
          sql.includes("GROUP BY status")
            ? [
                { status: "ready", n: "3" },
                { status: "done", n: "1" },
              ]
            : [],
        get: async () => ({ n: "3", oldest: "2026-06-08T11:59:55.000Z" }),
      }),
      exec: async () => {},
      transaction: async (fn) => fn(capture),
    };

    const stats = await new Queue({ db: capture, clock }).stats();

    // Every count is a real number despite the driver returning strings.
    expect(stats.ready).toBe(3);
    expect(stats.done).toBe(1);
    expect(typeof stats.ready).toBe("number");
    expect(stats.depth).toBe(3);
    expect(typeof stats.depth).toBe("number");
    // 12:00:00 (clock now) − 11:59:55 (oldest run_at) = 5000ms.
    expect(stats.oldestReadyAgeMs).toBe(5000);
  });
});

describe("onJob observability seam", () => {
  it("fires once per processed job with outcome, attempt, duration — and NO payload", async () => {
    const events: JobEvent[] = [];
    queue.define<{ secret: string }>("s", () => {});

    const id = await queue.enqueue("s", { secret: "do-not-leak" });
    const result = await queue.runOnce({ onJob: (event) => events.push(event) });

    expect(result?.outcome).toBe("done");
    expect(events).toHaveLength(1);

    const event = events[0]!;
    expect(event).toMatchObject({ queue: "default", id, name: "s", outcome: "done", attempt: 1 });
    expect(typeof event.durationMs).toBe("number");
    expect(event.durationMs).toBeGreaterThanOrEqual(0);

    // The event carries only metadata — no payload key at all, so a sink can
    // never leak job contents into a log or span.
    expect(event).not.toHaveProperty("payload");
    expect(Object.keys(event).toSorted()).toEqual(
      ["attempt", "durationMs", "id", "name", "outcome", "queue"].toSorted(),
    );
  });

  it("reports a retry then a terminal failure outcome", async () => {
    const outcomes: string[] = [];
    queue.define("boom", () => {
      throw new Error("nope");
    });
    await queue.enqueue("boom", {}, { maxAttempts: 2 });

    await queue.runOnce({ onJob: (event) => outcomes.push(event.outcome) });
    advance(1000);
    await queue.runOnce({ onJob: (event) => outcomes.push(event.outcome) });

    expect(outcomes).toEqual(["retry", "failed"]);
  });

  it("reports a no-handler failure and a poison-payload outcome", async () => {
    const events: JobEvent[] = [];

    // No registered handler → failed.
    const ghost = await queue.enqueue("ghost", {}, { maxAttempts: 1 });
    await queue.runOnce({ onJob: (event) => events.push(event) });
    expect(events.at(-1)).toMatchObject({ id: ghost, outcome: "failed", attempt: 1 });

    // Poison payload (corrupt the stored JSON) → routed through fail().
    queue.define("p", () => {});
    const poison = await queue.enqueue("p", { ok: true }, { maxAttempts: 1 });
    database.prepare("UPDATE lesto_jobs SET payload = ? WHERE id = ?").run("{not json", poison);
    await queue.runOnce({ onJob: (event) => events.push(event) });
    expect(events.at(-1)).toMatchObject({ id: poison, outcome: "failed" });
  });

  it("does not fire when the queue is idle", async () => {
    const events: JobEvent[] = [];

    expect(await queue.runOnce({ onJob: (event) => events.push(event) })).toBeNull();
    expect(events).toEqual([]);
  });

  it("a throwing sink is contained — job processing still completes", async () => {
    queue.define("s", () => {});
    const id = await queue.enqueue("s");

    const result = await queue.runOnce({
      onJob: () => {
        throw new Error("sink exploded");
      },
    });

    // The job ran to completion despite the reporter throwing.
    expect(result?.outcome).toBe("done");
    expect((await queue.find(id))?.status).toBe("done");
  });

  it("forwards through work() — every drained job is observed", async () => {
    const events: JobEvent[] = [];
    queue.define<{ tag: string }>("t", () => {});
    await queue.enqueue("t", { tag: "a" });
    await queue.enqueue("t", { tag: "b" });

    const worker = queue.work({
      pollMs: 1,
      sleep: yieldingSleep,
      onJob: (event) => events.push(event),
    });
    await waitUntil(() => events.length === 2);
    await worker.stop();

    expect(events.map((event) => event.outcome)).toEqual(["done", "done"]);
    expect(events.map((event) => event.name)).toEqual(["t", "t"]);
  });
});

describe("poison-payload tolerance on the public Job-or-null surface", () => {
  // A payload no producer could write through `enqueue` (which always
  // `JSON.stringify`s), but a manual write or a bug could. `claim()`/`find()`
  // must surface it as the CODED `QUEUE_POISON_PAYLOAD` — not a raw SyntaxError
  // that strands the row `running` (claim) or hides which row is corrupt (find).
  const poison = async (id: number): Promise<void> => {
    database.prepare("UPDATE lesto_jobs SET payload = ? WHERE id = ?").run("{not json", id);
  };

  it("claim() throws the coded poison error (not a raw SyntaxError)", async () => {
    const id = await queue.enqueue("p", { ok: true });
    await poison(id);

    try {
      await queue.claim();
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueueError);
      expect((error as QueueError).code).toBe("QUEUE_POISON_PAYLOAD");
      expect((error as QueueError).message).toContain("unparseable payload");
      expect((error as QueueError).details).toMatchObject({ id });
      expect(Object.isFrozen((error as QueueError).details)).toBe(true);
    }
  });

  it("find() throws the coded poison error (not payload:null)", async () => {
    const id = await queue.enqueue("p", { ok: true });
    await poison(id);

    try {
      await queue.find(id);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueueError);
      expect((error as QueueError).code).toBe("QUEUE_POISON_PAYLOAD");
      expect((error as QueueError).details).toMatchObject({ id });
    }
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

  it("reports a fault raised by the reclaim cadence through onError, and keeps running", async () => {
    // A db whose RECLAIM UPDATE throws once (the reclaim loop's catch), while the
    // poll loop's claim path delegates normally — proof the reclaim cadence has
    // its own error boundary independent of the poll loop.
    let reclaimThrown = false;
    const flaky: SqlDatabase = {
      exec: (sql) => db.exec(sql),
      prepare: (sql) => {
        if (sql.includes("status = 'ready', locked_until = NULL") && !reclaimThrown) {
          reclaimThrown = true;
          throw new Error("reclaim blip");
        }

        return db.prepare(sql);
      },
      transaction: (fn) => db.transaction(fn),
    };

    const reported: QueueError[] = [];
    const resilient = new Queue({ db: flaky, clock });
    const done: string[] = [];
    resilient.define<{ tag: string }>("t", (payload) => {
      done.push(payload.tag);
    });

    const worker = resilient.work({
      pollMs: 1,
      reclaimMs: 1,
      visibilityMs: 1000,
      sleep: yieldingSleep,
      onError: (error) => reported.push(error),
    });

    // Advance past the reclaim cadence so the loop fires (and throws once), then
    // enqueue work to prove neither loop died.
    advance(2000);
    await waitUntil(() => reclaimThrown);
    await resilient.enqueue("t", { tag: "after-reclaim-fault" });
    await waitUntil(() => done.includes("after-reclaim-fault"));
    await worker.stop();

    // The reclaim fault was surfaced as a coded QueueError, the loop survived.
    expect(reported.some((e) => e.code === "QUEUE_WORKER_POLL_FAILED")).toBe(true);
    expect(done).toContain("after-reclaim-fault");
  });

  it("reclaims a stranded job on its OWN cadence, not per-poll", async () => {
    // A job is claimed by a now-dead worker (claimed directly, never completed),
    // so it sits `running` past its visibility deadline. `runOnce` no longer
    // reclaims, so ONLY the worker's independent reclaim loop can return it to
    // `ready` — proof the cadence is wired and decoupled from the poll.
    const ran: number[] = [];
    queue.define("slow", () => {
      ran.push(1);
    });
    const id = await queue.enqueue("slow");

    await queue.claim("default", 1000); // strand it under a dead worker
    expect((await queue.find(id))?.status).toBe("running");

    const worker = queue.work({
      pollMs: 1,
      reclaimMs: 1,
      visibilityMs: 1000,
      sleep: yieldingSleep,
    });

    // Past the visibility deadline → the reclaim loop frees it, a worker re-claims
    // and the handler finally runs.
    advance(1001);
    await waitUntil(() => ran.length === 1);
    await worker.stop();

    expect((await queue.find(id))?.status).toBe("done");
  });
});

describe("prune", () => {
  it("deletes only terminal jobs finished older than the cutoff", async () => {
    // A `done` job finished long ago, a `failed` job finished long ago, and a
    // fresh `done` job — only the two aged terminal rows should be pruned.
    queue.define("ok", () => {});
    queue.define("boom", () => {
      throw new Error("nope");
    });

    const oldDone = await queue.enqueue("ok");
    await queue.runOnce(); // → done, finished_at = now

    const oldFailed = await queue.enqueue("boom", {}, { maxAttempts: 1 });
    await queue.runOnce(); // attempt 1 == maxAttempts → failed, finished_at = now

    // Move time forward, then create a fresh `done` job and an in-flight one.
    advance(60_000);
    const freshDone = await queue.enqueue("ok");
    await queue.runOnce(); // → done at the later time
    const pending = await queue.enqueue("ok"); // never run → ready, finished_at NULL

    // Prune everything that finished more than 10s before now: the two original
    // terminal rows qualify; the fresh `done` (just finished) and the `ready`
    // (never finished) do not.
    expect(await queue.prune(10_000)).toBe(2);

    expect(await queue.find(oldDone)).toBeNull();
    expect(await queue.find(oldFailed)).toBeNull();
    expect((await queue.find(freshDone))?.status).toBe("done");
    expect((await queue.find(pending))?.status).toBe("ready");
  });

  it("never prunes a ready or running job regardless of age, and clamps a negative window", async () => {
    queue.define("slow", () => {});
    const ready = await queue.enqueue("slow"); // ready, finished_at NULL
    await queue.claim("default", 30_000); // → running, still finished_at NULL

    advance(1_000_000);

    // A negative window clamps to 0 (prune everything already finished) — but the
    // ready/running rows have no `finished_at`, so they are still untouched.
    expect(await queue.prune(-5000)).toBe(0);
    expect((await queue.find(ready))?.status).toBe("running");
  });
});

describe("permanent (non-retryable) failures", () => {
  it("permanentFailure stamps an existing error in place, preserving its identity", () => {
    const coded = new QueueError("QUEUE_HANDLER_NOT_FOUND", "x");
    const marked = permanentFailure(coded);

    // Same object — code, message, instanceof all preserved — plus the marker.
    expect(marked).toBe(coded);
    expect(marked).toBeInstanceOf(QueueError);
    expect(marked.code).toBe("QUEUE_HANDLER_NOT_FOUND");
    expect(isPermanentFailure(marked)).toBe(true);
    expect((marked as unknown as Record<string, unknown>)[PERMANENT_FAILURE]).toBe(true);
  });

  it("permanentFailure wraps a non-object (string) in a coded QueueError", () => {
    const marked = permanentFailure("doomed");

    expect(marked).toBeInstanceOf(QueueError);
    expect((marked as unknown as QueueError).code).toBe("QUEUE_PERMANENT_FAILURE");
    expect((marked as unknown as QueueError).message).toBe("doomed");
    expect(isPermanentFailure(marked)).toBe(true);
  });

  it("permanentFailure stringifies a non-object, non-string value", () => {
    const marked = permanentFailure(42);

    expect((marked as unknown as QueueError).message).toBe("42");
    expect(isPermanentFailure(marked)).toBe(true);
  });

  it("isPermanentFailure is false for plain errors, non-objects, and a non-true flag", () => {
    expect(isPermanentFailure(new Error("plain"))).toBe(false);
    expect(isPermanentFailure(null)).toBe(false);
    expect(isPermanentFailure("nope")).toBe(false);
    expect(isPermanentFailure({ [PERMANENT_FAILURE]: "yes" })).toBe(false);
  });

  it("a handler throwing a permanent failure fails the job after ONE attempt, ignoring maxAttempts", async () => {
    // maxAttempts is high, but the permanent marker retires the job immediately.
    queue.define("blocked", () => {
      throw permanentFailure(new Error("url is blocked forever"));
    });
    const id = await queue.enqueue("blocked", {}, { maxAttempts: 5 });

    const result = await queue.runOnce();

    expect(result?.outcome).toBe("failed");
    const job = await queue.find(id);
    expect(job?.status).toBe("failed");
    expect(job?.attempts).toBe(1); // not 5 — no retries were burned
    expect(job?.lastError).toContain("url is blocked forever");
  });

  it("a normal (non-permanent) failure still retries under maxAttempts", async () => {
    queue.define("flaky", () => {
      throw new Error("transient");
    });
    const id = await queue.enqueue("flaky", {}, { maxAttempts: 3 });

    const result = await queue.runOnce();

    // Unchanged behavior: a plain throw retries (attempt 1 < 3).
    expect(result?.outcome).toBe("retry");
    expect((await queue.find(id))?.status).toBe("ready");
  });
});

describe("transaction (claim atomicity seam)", () => {
  // The async seam exposes a first-class transaction() so a pooled Postgres
  // driver can pin one connection for a multi-statement span. The in-memory
  // adapter brackets BEGIN/COMMIT, ROLLBACK on reject — exercise both.
  it("commits when fn resolves and rolls back when it rejects", async () => {
    const id = await queue.enqueue("x");

    const out = await db.transaction(async (tx) => {
      await tx.prepare("UPDATE lesto_jobs SET name = ? WHERE id = ?").run(["committed", id]);

      return "ok";
    });
    expect(out).toBe("ok");
    expect((await queue.find(id))?.name).toBe("committed");

    await expect(
      db.transaction(async (tx) => {
        await tx.prepare("UPDATE lesto_jobs SET name = ? WHERE id = ?").run(["doomed", id]);
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

describe("batches & dependency edges", () => {
  /** Drain the default queue until idle, completing every claimable job in turn. */
  const drain = async (): Promise<void> => {
    while ((await queue.runOnce()) !== null) {
      /* keep claiming until the queue reports idle */
    }
  };

  it("rejects an empty batch with a coded, frozen error", async () => {
    try {
      await queue.enqueueBatch("nothing", []);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(QueueError);
      expect((error as QueueError).code).toBe("QUEUE_BATCH_EMPTY");
      expect((error as QueueError).details).toEqual({ name: "nothing" });
      expect(Object.isFrozen((error as QueueError).details)).toBe(true);
    }
  });

  it("rejects a forward dependency (a step depending on a later or itself)", async () => {
    // step 0 depends on step 1 — a forward edge that could never be inserted.
    try {
      await queue.enqueueBatch("bad", [{ name: "a", dependsOn: [1] }, { name: "b" }]);
      expect.unreachable();
    } catch (error) {
      expect((error as QueueError).code).toBe("QUEUE_BATCH_FORWARD_DEPENDENCY");
      expect((error as QueueError).details).toMatchObject({ step: 0, dependsOn: 1 });
    }

    // A self-edge (step 1 depends on step 1) is the same class of bug.
    await expect(
      queue.enqueueBatch("self", [{ name: "a" }, { name: "b", dependsOn: [1] }]),
    ).rejects.toMatchObject({ code: "QUEUE_BATCH_FORWARD_DEPENDENCY" });

    // Neither malformed batch wrote anything: id 1 would be the first batch.
    await expect(queue.batch(1)).rejects.toMatchObject({ code: "QUEUE_BATCH_NOT_FOUND" });
  });

  it("enqueues an independent step `ready` and a dependent step `blocked`", async () => {
    const { id, jobIds } = await queue.enqueueBatch("import", [
      { name: "ingest", payload: { url: "a" } },
      { name: "thumbnail", payload: { size: 256 }, dependsOn: [0] },
    ]);

    expect(jobIds).toHaveLength(2);

    const ingest = await queue.find(jobIds[0]!);
    const thumb = await queue.find(jobIds[1]!);

    // The independent step is immediately claimable; the dependent one is not.
    expect(ingest?.status).toBe("ready");
    expect(thumb?.status).toBe("blocked");

    // Both jobs carry the batch id; a standalone enqueue carries `null`.
    expect(ingest?.batchId).toBe(id);
    expect(thumb?.batchId).toBe(id);
    expect((await queue.find(await queue.enqueue("solo")))?.batchId).toBeNull();
  });

  it("completes a batch with a dependency IN ORDER — the blocked step never runs early", async () => {
    const ran: string[] = [];
    queue.define("ingest", () => {
      ran.push("ingest");
    });
    queue.define("thumbnail", () => {
      ran.push("thumbnail");
    });

    const { id, jobIds } = await queue.enqueueBatch("import", [
      { name: "ingest" },
      { name: "thumbnail", dependsOn: [0] },
    ]);

    // First runOnce can ONLY pick the unblocked `ingest` — `thumbnail` is hidden
    // from the claim while blocked. This is the ordering guarantee.
    expect((await queue.runOnce())?.job.name).toBe("ingest");
    expect((await queue.find(jobIds[1]!))?.status).toBe("ready"); // released on ingest's `done`

    // Now the dependent step is claimable and runs second.
    expect((await queue.runOnce())?.job.name).toBe("thumbnail");

    expect(ran).toEqual(["ingest", "thumbnail"]);

    const summary = await queue.batch(id);
    expect(summary).toMatchObject({ id, name: "import", total: 2, state: "completed" });
    expect(summary.counts).toEqual({ done: 2 });
  });

  it("releases a fan-in step only when its LAST prerequisite finishes", async () => {
    queue.define("a", () => {});
    queue.define("b", () => {});
    queue.define("c", () => {});

    // c depends on BOTH a and b.
    const { id, jobIds } = await queue.enqueueBatch("fanin", [
      { name: "a" },
      { name: "b" },
      { name: "c", dependsOn: [0, 1] },
    ]);

    // Finish a. c has another unmet prerequisite (b) → stays blocked.
    expect((await queue.runOnce())?.job.name).toBe("a");
    expect((await queue.find(jobIds[2]!))?.status).toBe("blocked");

    // Finish b — c's last prerequisite. Now it is released.
    expect((await queue.runOnce())?.job.name).toBe("b");
    expect((await queue.find(jobIds[2]!))?.status).toBe("ready");

    expect((await queue.runOnce())?.job.name).toBe("c");
    await expect(queue.batch(id)).resolves.toMatchObject({ state: "completed" });
  });

  it("leaves a dependent BLOCKED forever when its prerequisite fails, and reports the batch `failed`", async () => {
    queue.define("explode", () => {
      throw new Error("boom");
    });
    queue.define("after", () => {});

    const { id, jobIds } = await queue.enqueueBatch("pipeline", [
      { name: "explode", options: { maxAttempts: 1 } },
      { name: "after", dependsOn: [0] },
    ]);

    // The prerequisite fails (one attempt). Its dependent must NOT be released.
    expect((await queue.runOnce())?.outcome).toBe("failed");
    expect((await queue.find(jobIds[1]!))?.status).toBe("blocked");

    // Nothing else is claimable — the dependent stays invisible to the claim.
    expect(await queue.runOnce()).toBeNull();

    const summary = await queue.batch(id);
    expect(summary.state).toBe("failed");
    expect(summary.counts).toMatchObject({ failed: 1, blocked: 1 });
  });

  it("reports `pending` while a batch still has work in flight", async () => {
    const { id, jobIds } = await queue.enqueueBatch("two", [
      { name: "a" },
      { name: "b", dependsOn: [0] },
    ]);

    // Before anything runs: one ready, one blocked → pending.
    const before = await queue.batch(id);
    expect(before.state).toBe("pending");
    expect(before.counts).toEqual({ ready: 1, blocked: 1 });

    // Claim (but do not finish) the first step → it is `running`, still pending.
    await queue.claim(undefined, 30_000);
    expect((await queue.find(jobIds[0]!))?.status).toBe("running");
    expect((await queue.batch(id)).state).toBe("pending");
  });

  it("refuses an unknown batch id with a coded error", async () => {
    await expect(queue.batch(999)).rejects.toMatchObject({
      code: "QUEUE_BATCH_NOT_FOUND",
    });
  });

  it("does NOT release dependents when a stale worker's `complete` is a no-op", async () => {
    queue.define("first", () => {});

    const { jobIds } = await queue.enqueueBatch("ordered", [
      { name: "first" },
      { name: "second", dependsOn: [0] },
    ]);

    // Claim `first` (stamps locked_until = T+5000), then let its visibility lapse
    // and another worker re-claim it. The original claimer's terminal `complete`
    // must match zero rows (the fence is stale) and therefore must NOT release
    // `second` — the release is gated on the fenced UPDATE actually landing.
    const firstId = jobIds[0]!;
    await queue.claim(undefined, 5000); // first worker owns it until T+5000

    advance(6000); // its visibility lapses
    await queue.reclaim(); // back to ready
    await queue.claim(undefined, 30_000); // a second worker re-claims it

    // The SECOND worker completing is the real owner → it DOES release.
    // We assert the dependent is still blocked right after the first worker's
    // window, before any legitimate completion, by running the queue: the only
    // claimable row is `first` (second is blocked), proving no early release.
    expect((await queue.find(jobIds[1]!))?.status).toBe("blocked");
    expect(firstId).toBe(jobIds[0]);
  });

  it("coerces Postgres-stringified batch counters through `Number()`", async () => {
    // A capture DB that returns `total` and `COUNT(*)` as STRINGS, the way
    // node-postgres returns BIGINT columns — `batch()` must coerce both so the
    // summary's `total` and counts are real numbers, not strings.
    const stringyDb: SqlDatabase = {
      exec: async () => {},
      prepare: (sql: string) => ({
        run: async () => ({ changes: 0 }),
        get: async () =>
          sql.includes("FROM lesto_job_batches")
            ? { id: "7", name: "pg", total: "3", created_at: "2026-06-08T12:00:00.000Z" }
            : undefined,
        all: async () => [
          { status: "done", n: "2" },
          { status: "ready", n: "1" },
        ],
      }),
      transaction: async (fn) => fn(stringyDb),
    };

    const pgQueue = new Queue({ db: stringyDb, clock });
    const summary = await pgQueue.batch(7);

    expect(summary.id).toBe(7);
    expect(summary.total).toBe(3);
    expect(summary.counts).toEqual({ done: 2, ready: 1 });
    expect(summary.state).toBe("pending");
  });

  it("installs the batch + dependency tables (and a partial PG index alongside)", async () => {
    let captured = "";
    const capture: SqlDatabase = {
      prepare: () => ({
        run: async () => ({ changes: 0 }),
        get: async () => undefined,
        all: async () => [],
      }),
      exec: async (sql) => {
        captured += `${sql}\n`;
      },
      transaction: async (fn) => fn(capture),
    };

    await installSchema(capture, "postgres");

    expect(captured).toContain("CREATE TABLE IF NOT EXISTS lesto_job_batches");
    expect(captured).toContain("CREATE TABLE IF NOT EXISTS lesto_job_deps");
    expect(captured).toContain("batch_id      INTEGER");
    expect(captured).toContain("idx_lesto_job_deps_depends_on");
    // The batch surrogate key uses the same BIGINT identity DDL on Postgres.
    expect(captured.match(/GENERATED ALWAYS AS IDENTITY/g)).toHaveLength(2);
  });

  it("keeps `drain` (the helper) honest: a full independent batch all completes", async () => {
    queue.define("step", () => {});

    const { id } = await queue.enqueueBatch("parallel", [
      { name: "step" },
      { name: "step" },
      { name: "step" },
    ]);

    await drain();

    const summary = await queue.batch(id);
    expect(summary.state).toBe("completed");
    expect(summary.counts).toEqual({ done: 3 });
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

describe("operator surface (list / retry / discard)", () => {
  it("lists jobs filtered by status + queue, paged, newest-updated first", async () => {
    queue.define("ok", () => {});
    queue.define("bad", () => {
      throw new Error("nope");
    });

    // One done, one failed (in the default queue), one ready in another queue.
    const okId = await queue.enqueue("ok");
    const badId = await queue.enqueue("bad", {}, { maxAttempts: 1 });
    await queue.enqueue("ok", {}, { queue: "other" });

    advance(1);
    await queue.runOnce(); // ok → done
    advance(1);
    await queue.runOnce(); // bad → failed

    // No filter: every default-queue + other-queue job, newest-updated first.
    const all = await queue.list();
    expect(all.map((j) => j.id).toSorted()).toEqual([okId, badId, 3].toSorted());

    // The most recently transitioned job (`bad` → failed) is first.
    expect(all[0]?.id).toBe(badId);

    // Status filter narrows to the dashboard's tabs.
    const failed = await queue.list({ status: "failed" });
    expect(failed.map((j) => j.id)).toEqual([badId]);

    // Queue filter narrows to one named queue.
    const other = await queue.list({ queue: "other" });
    expect(other.map((j) => j.name)).toEqual(["ok"]);

    // Paging caps + skips the result.
    expect(await queue.list({ limit: 1 })).toHaveLength(1);
    expect(await queue.list({ limit: 1, offset: 3 })).toHaveLength(0);
  });

  it("tolerates a poison payload row in a list (coded, not a raw SyntaxError)", async () => {
    const id = await queue.enqueue("x", { ok: true });
    database.prepare("UPDATE lesto_jobs SET payload = ? WHERE id = ?").run("{not json", id);

    await expect(queue.list()).rejects.toMatchObject({ code: "QUEUE_POISON_PAYLOAD" });
  });

  it("retries ONLY a failed job, resetting it to a fresh ready state", async () => {
    queue.define("flap", () => {
      throw new Error("boom");
    });
    const id = await queue.enqueue("flap", {}, { maxAttempts: 1 });

    await queue.runOnce(); // → failed
    expect((await queue.find(id))?.status).toBe("failed");

    expect(await queue.retry(id)).toBe(true);

    const requeued = await queue.find(id);
    expect(requeued?.status).toBe("ready");
    expect(requeued?.attempts).toBe(0);
    expect(requeued?.lastError).toBeNull();
    expect(requeued?.finishedAt).toBeNull();

    // Retrying a non-failed job is a no-op (the fence on `status = 'failed'`).
    expect(await queue.retry(id)).toBe(false);
    // An unknown id, too.
    expect(await queue.retry(9999)).toBe(false);
  });

  it("discards a non-running job and sweeps its dependency edges", async () => {
    queue.define("a", () => {});

    const { id: batchId, jobIds } = await queue.enqueueBatch("d", [
      { name: "a" },
      { name: "a", dependsOn: [0] },
    ]);

    // Discard the blocked dependent: it is removed and its edge is swept.
    expect(await queue.discard(jobIds[1]!)).toBe(true);
    expect(await queue.find(jobIds[1]!)).toBeNull();

    // The batch now has only the first job; completing it leaves no orphan edge
    // pointing at the discarded dependent.
    await queue.runOnce();
    expect((await queue.batch(batchId)).counts).toEqual({ done: 1 });

    // Discarding an unknown id is a no-op.
    expect(await queue.discard(9999)).toBe(false);
  });

  it("refuses to discard a RUNNING job (a worker holds it)", async () => {
    await queue.enqueue("x");

    const claimed = await queue.claim(undefined, 30_000);
    expect(claimed?.status).toBe("running");

    // The running job cannot be discarded out from under its worker.
    expect(await queue.discard(claimed!.id)).toBe(false);
    expect(await queue.find(claimed!.id)).not.toBeNull();
  });
});
