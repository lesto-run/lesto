/**
 * `sqlRateLimitStore` / `installRateLimitSchema` — the durable, fleet-correct
 * limiter (ADR 0013 §5).
 *
 * These tests drive a scripted fake `SqlDatabase` whose `transaction` hands out a
 * recording `tx`, so the single-transaction / locked-read / bounded-retry logic
 * is proven without a real engine (that, on both drivers, is item 7). The fake's
 * `transaction` is itself FIFO-serial (one chain) — the same guarantee item 1
 * gives real SQLite — so a Map backing it is an honest stand-in.
 */

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_RATELIMIT_SWEEP_INTERVAL_MS,
  DEFAULT_RATELIMIT_SWEEP_RETENTION_MS,
  installRateLimitSchema,
  isUniqueViolation,
  MemoryRateLimitStore,
  RateLimiter,
  RateLimitError,
  sqlRateLimitStore,
  startRateLimitSweep,
} from "../src/index";
import type { BucketState, Dialect, SqlDatabase, SqlStatement } from "../src/index";

interface Row {
  tokens: number | string;
  updated_at: number | string;
}

/** An error shaped like a SQLite unique violation. */
function uniqueViolation(): Error {
  return new Error("UNIQUE constraint failed: lesto_rate_limits.key");
}

/**
 * A fake `SqlDatabase` over a Map. Records every prepared SQL string so the
 * `FOR UPDATE` fork can be asserted; `failInsertTimes` makes the next N INSERTs
 * throw a unique violation (to drive the first-insert-race retry); `rowsAsString`
 * stores numbers as strings to exercise the PG-BIGINT `Number()` coercion.
 */
function makeFakeDb(
  options: { failInsertTimes?: number; rowsAsString?: boolean; insertError?: () => Error } = {},
): {
  db: SqlDatabase;
  rows: Map<string, Row>;
  prepared: string[];
  execed: string[];
} {
  const rows = new Map<string, Row>();
  const prepared: string[] = [];
  const execed: string[] = [];
  let insertFailures = options.failInsertTimes ?? 0;

  const store = (value: number): number | string => (options.rowsAsString ? String(value) : value);

  const prepare = (sql: string): SqlStatement => {
    prepared.push(sql);

    if (sql.startsWith("SELECT")) {
      return {
        run: async () => ({ changes: 0 }),
        get: async (params = []) => rows.get((params as [string])[0]),
        all: async () => [],
      };
    }

    if (sql.startsWith("UPDATE")) {
      return {
        run: async (params = []) => {
          const [tokens, updatedAt, key] = params as [number, number, string];
          rows.set(key, { tokens: store(tokens), updated_at: store(updatedAt) });
          return { changes: 1 };
        },
        get: async () => undefined,
        all: async () => [],
      };
    }

    if (sql.startsWith("INSERT")) {
      return {
        run: async (params = []) => {
          if (insertFailures > 0) {
            insertFailures -= 1;
            throw (options.insertError ?? uniqueViolation)();
          }
          const [key, tokens, updatedAt] = params as [string, number, number];
          rows.set(key, { tokens: store(tokens), updated_at: store(updatedAt) });
          return { changes: 1 };
        },
        get: async () => undefined,
        all: async () => [],
      };
    }

    // DELETE ... WHERE updated_at < ?
    return {
      run: async (params = []) => {
        const [before] = params as [number];
        let changes = 0;
        for (const [key, row] of rows) {
          if (Number(row.updated_at) < before) {
            rows.delete(key);
            changes += 1;
          }
        }
        return { changes };
      },
      get: async () => undefined,
      all: async () => [],
    };
  };

  // A FIFO-serial fake transaction (one chain), mirroring item 1's real SQLite.
  let chain: Promise<unknown> = Promise.resolve();
  const db: SqlDatabase = {
    prepare,
    exec: async (sql) => {
      execed.push(sql.trim());
    },
    transaction: (fn) => {
      const run = chain.then(() => fn({ prepare, exec: db.exec, transaction: db.transaction }));
      chain = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };

  return { db, rows, prepared, execed };
}

const fullThenSpend = (now: number): ((current: BucketState | undefined) => BucketState) => {
  return (current) => {
    const tokens = current === undefined ? 4 : current.tokens - 1;
    return { tokens, updatedAt: now };
  };
};

describe("installRateLimitSchema", () => {
  it("issues the table + index, all IF NOT EXISTS (idempotent)", async () => {
    const { db, execed } = makeFakeDb();

    await installRateLimitSchema(db);
    await installRateLimitSchema(db);

    expect(execed).toHaveLength(4);
    const [create, index] = execed;
    expect(create).toContain("CREATE TABLE IF NOT EXISTS lesto_rate_limits");
    expect(create).toContain("tokens     DOUBLE PRECISION NOT NULL");
    expect(create).toContain("updated_at BIGINT NOT NULL");
    expect(index).toContain("CREATE INDEX IF NOT EXISTS lesto_rate_limits_updated_at");
  });
});

describe("sqlRateLimitStore.update", () => {
  it("row-absent: mutate(undefined) then INSERT", async () => {
    const { db, rows, prepared } = makeFakeDb();
    const store = sqlRateLimitStore(db);

    const next = await store.update("k", fullThenSpend(1000));

    expect(next).toEqual({ tokens: 4, updatedAt: 1000 });
    expect(rows.get("k")).toEqual({ tokens: 4, updated_at: 1000 });
    expect(prepared.some((s) => s.startsWith("INSERT"))).toBe(true);
    expect(prepared.some((s) => s.startsWith("UPDATE"))).toBe(false);
  });

  it("row-present: SELECT → mutate(current) → UPDATE, coercing PG-string columns", async () => {
    const { db, rows, prepared } = makeFakeDb({ rowsAsString: true });
    const store = sqlRateLimitStore(db);

    await store.update("k", fullThenSpend(1000)); // INSERT 4
    const next = await store.update("k", fullThenSpend(2000)); // 4 -> 3

    // The current state fed to mutate was Number()-coerced from the stored string.
    expect(next).toEqual({ tokens: 3, updatedAt: 2000 });
    expect(rows.get("k")).toEqual({ tokens: "3", updated_at: "2000" });
    expect(prepared.some((s) => s.startsWith("UPDATE"))).toBe(true);
  });

  it("appends FOR UPDATE to the SELECT only on the postgres dialect", async () => {
    for (const dialect of ["sqlite", "postgres"] as Dialect[]) {
      const { db, prepared } = makeFakeDb();
      const store = sqlRateLimitStore(db, { dialect });

      await store.update("k", fullThenSpend(1000));

      const select = prepared.find((s) => s.startsWith("SELECT"))!;
      expect(select.includes("FOR UPDATE")).toBe(dialect === "postgres");
    }
  });

  it("defaults to the sqlite dialect (no FOR UPDATE)", async () => {
    const { db, prepared } = makeFakeDb();
    const store = sqlRateLimitStore(db);

    await store.update("k", fullThenSpend(1000));

    expect(prepared.find((s) => s.startsWith("SELECT"))!.includes("FOR UPDATE")).toBe(false);
  });

  it("retries once on a first-insert conflict, then succeeds (mutate runs twice)", async () => {
    const { db, rows } = makeFakeDb({ failInsertTimes: 1 });
    const store = sqlRateLimitStore(db);

    let mutateCalls = 0;
    const next = await store.update("k", (current) => {
      mutateCalls += 1;
      return { tokens: current === undefined ? 4 : current.tokens, updatedAt: 1000 };
    });

    expect(mutateCalls).toBe(2); // first attempt (failed INSERT) + retry
    expect(next).toEqual({ tokens: 4, updatedAt: 1000 });
    expect(rows.get("k")).toEqual({ tokens: 4, updated_at: 1000 });
  });

  it("throws RATELIMIT_STORE_CONFLICT after two consecutive conflicts", async () => {
    const { db } = makeFakeDb({ failInsertTimes: 2 });
    const store = sqlRateLimitStore(db);

    await expect(store.update("k", fullThenSpend(1000))).rejects.toMatchObject({
      code: "RATELIMIT_STORE_CONFLICT",
      details: { key: "k" },
    });

    // And it is the coded class, branchable.
    await expect(
      sqlRateLimitStore(makeFakeDb({ failInsertTimes: 2 }).db).update("k", fullThenSpend(1000)),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it("propagates a non-conflict error without retrying", async () => {
    const boom = new Error("connection reset");
    const { db } = makeFakeDb({ failInsertTimes: 1, insertError: () => boom });
    const store = sqlRateLimitStore(db);

    let mutateCalls = 0;
    await expect(
      store.update("k", (current) => {
        mutateCalls += 1;
        return { tokens: current === undefined ? 4 : current.tokens, updatedAt: 1000 };
      }),
    ).rejects.toBe(boom);

    // No retry: mutate ran exactly once.
    expect(mutateCalls).toBe(1);
  });

  it("propagates a non-conflict error raised on the RETRY without re-coding it", async () => {
    // First INSERT a unique violation (triggers retry); the retry INSERT throws a
    // different error — it must propagate untouched, not become a coded conflict.
    let call = 0;
    const { db } = makeFakeDb({
      failInsertTimes: 2,
      insertError: () => {
        call += 1;
        return call === 1 ? uniqueViolation() : new Error("disk full");
      },
    });
    const store = sqlRateLimitStore(db);

    await expect(store.update("k", fullThenSpend(1000))).rejects.toThrow("disk full");
  });

  it("fails CLOSED when the transaction seam cannot serialize the read-modify-write (D1)", async () => {
    // A backend with no real interactive transaction — Cloudflare D1 — must NOT
    // silently degrade to a passthrough. Its adapter refuses `transaction()` with a
    // coded rejection (see @lesto/cloudflare `CLOUDFLARE_D1_TRANSACTION_UNSUPPORTED`).
    // The store must propagate that refusal so a rate check on D1 ERRORS (fails
    // closed → the request is denied), never silently returns a lost-update verdict
    // that lets the caller through (fail open). This is the second half of F3.
    const prepared: string[] = [];
    const stmt: SqlStatement = {
      run: async () => ({ changes: 1 }),
      get: async () => undefined,
      all: async () => [],
    };
    const refusingDb: SqlDatabase = {
      prepare: (sql) => {
        prepared.push(sql);
        return stmt;
      },
      exec: async () => {},
      transaction: () =>
        Promise.reject(
          Object.assign(new Error("D1 has no interactive transaction"), {
            code: "CLOUDFLARE_D1_TRANSACTION_UNSUPPORTED",
          }),
        ),
    };
    const store = sqlRateLimitStore(refusingDb);

    let mutateCalls = 0;
    await expect(
      store.update("k", (current) => {
        mutateCalls += 1;
        return { tokens: current === undefined ? 4 : current.tokens - 1, updatedAt: 1000 };
      }),
    ).rejects.toMatchObject({ code: "CLOUDFLARE_D1_TRANSACTION_UNSUPPORTED" });

    // Non-vacuous fail-OPEN guard: the refusal is neither swallowed nor re-coded as
    // a store conflict, and NO statement ever reached the handle — so no bucket
    // read-modify-write ran outside a real transaction (which is exactly the
    // lost-update / fail-open path the refusal prevents).
    expect(prepared).toEqual([]);
    expect(mutateCalls).toBe(0);
  });
});

describe("sqlRateLimitStore.sweep", () => {
  it("deletes rows strictly before `before` and returns the count", async () => {
    const { db, rows } = makeFakeDb();
    const store = sqlRateLimitStore(db);

    await store.update("old", () => ({ tokens: 5, updatedAt: 100 }));
    await store.update("edge", () => ({ tokens: 5, updatedAt: 200 }));
    await store.update("fresh", () => ({ tokens: 5, updatedAt: 300 }));

    expect(await store.sweep(200)).toBe(1); // only `old` (< 200); `edge` (== 200) survives
    expect(rows.has("old")).toBe(false);
    expect(rows.has("edge")).toBe(true);
    expect(rows.has("fresh")).toBe(true);
  });
});

describe("isUniqueViolation", () => {
  it("is true for the PG SQLSTATE, true for SQLITE_CONSTRAINT_UNIQUE/_PRIMARYKEY, and the message shape", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(true);
    expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" })).toBe(true);
    expect(isUniqueViolation(new Error("UNIQUE constraint failed: t.key"))).toBe(true);
  });

  it("is false for unrelated errors, non-matching codes, and non-objects", () => {
    expect(isUniqueViolation({ code: "08006" })).toBe(false);
    expect(isUniqueViolation(new Error("syntax error"))).toBe(false);
    expect(isUniqueViolation({ code: 42 })).toBe(false);
    expect(isUniqueViolation("nope")).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
  });

  it("is false for SQLITE_CONSTRAINT_NOTNULL/_CHECK/_FOREIGNKEY/_TRIGGER — a shared NOT NULL/CHECK/FK failure must never be swallowed as a fake unique-conflict retry", () => {
    // Structured non-unique SQLite constraint codes: these share the
    // `SQLITE_CONSTRAINT` prefix with the unique/primary-key codes, but must NOT
    // match — e.g. a null password_hash hitting a NOT NULL column on the shared
    // `users` table must fail LOUD, never be retried as a benign birth-race.
    expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_NOTNULL" })).toBe(false);
    expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_CHECK" })).toBe(false);
    expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })).toBe(false);
    expect(isUniqueViolation({ code: "SQLITE_CONSTRAINT_TRIGGER" })).toBe(false);
  });
});

describe("RateLimiter over sqlRateLimitStore", () => {
  it("admit/deny/refill matches the memory store byte-for-byte under one clock", async () => {
    let now = 1_000;
    const clock = (): number => now;

    const sql = new RateLimiter({
      store: sqlRateLimitStore(makeFakeDb().db),
      capacity: 3,
      refillPerSecond: 2,
      clock,
    });
    const memory = new RateLimiter({
      store: new MemoryRateLimitStore(),
      capacity: 3,
      refillPerSecond: 2,
      clock,
    });

    // Drain the bucket, then deny, then refill — both stores in lockstep.
    for (const step of [0, 0, 0, 0, 500]) {
      now += step;
      const a = await sql.check("user");
      const b = await memory.check("user");
      expect(a).toEqual(b);
    }
  });
});

// ---------------------------------------------------------------------------
// startRateLimitSweep — the process-safe periodic sweep driver (L-f8e7d11f)
//
// A durable SQL store moves growth from RAM to `lesto_rate_limits` ROWS, and the
// store starts no timer. This driver runs `sweep` on a cadence, unref'd so it never
// pins the event loop, no-overlap so a slow delete never stacks, with a stop handle
// for a graceful drain. Tests drive it through an injected timer seam — no waiting.
// ---------------------------------------------------------------------------

/** A hand-driven timer seam: `fire()` runs the captured callback; records teardown. */
function timerHarness(handle: unknown = { id: 1 }): {
  fire: () => void;
  readonly cleared: boolean;
  readonly handle: unknown;
  setInterval: (callback: () => void, ms: number) => unknown;
  clearInterval: (h: unknown) => void;
} {
  let callback: (() => void) | undefined;
  let cleared = false;
  const lastMs: number[] = [];

  return {
    fire: (): void => callback?.(),
    get cleared(): boolean {
      return cleared;
    },
    get handle(): unknown {
      return handle;
    },
    setInterval: (cb, ms): unknown => {
      callback = cb;
      lastMs.push(ms);

      return handle;
    },
    clearInterval: (h): void => {
      if (h === handle) cleared = true;
    },
  };
}

/** Settle the sweep's `.then/.finally` microtasks so `sweeping` resets between ticks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("startRateLimitSweep", () => {
  it("sweeps each tick against clock() - retentionMs", async () => {
    const swept: number[] = [];
    const store = {
      sweep: async (before: number): Promise<number> => {
        swept.push(before);

        return 1;
      },
    };
    const timer = timerHarness();

    startRateLimitSweep(store, {
      retentionMs: 10_000,
      intervalMs: 1000,
      clock: () => 1_700_000_000_000,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });

    timer.fire();
    await settle();

    // The safe threshold: rows untouched for at least the retention window.
    expect(swept).toEqual([1_700_000_000_000 - 10_000]);
  });

  it("stop() clears the interval", () => {
    const timer = timerHarness();

    const sweep = startRateLimitSweep(
      { sweep: async () => 0 },
      { setInterval: timer.setInterval, clearInterval: timer.clearInterval },
    );

    expect(timer.cleared).toBe(false);
    sweep.stop();
    expect(timer.cleared).toBe(true);
  });

  it("does not overlap: a tick while a sweep is in flight is skipped", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = {
      sweep: async (): Promise<number> => {
        calls += 1;
        await gate;

        return 0;
      },
    };
    const timer = timerHarness();

    startRateLimitSweep(store, {
      intervalMs: 1000,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });

    timer.fire(); // starts the in-flight sweep (calls = 1)
    timer.fire(); // still in flight → skipped
    expect(calls).toBe(1);

    release();
    await settle();

    timer.fire(); // the previous one settled → this one runs
    expect(calls).toBe(2);
  });

  it("routes a sweep rejection to onError and keeps ticking", async () => {
    const boom = new Error("db down");
    let fail = true;
    const store = {
      sweep: async (): Promise<number> => {
        if (fail) throw boom;

        return 0;
      },
    };
    const onError = vi.fn();
    const timer = timerHarness();

    startRateLimitSweep(store, {
      intervalMs: 1000,
      onError,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });

    timer.fire();
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);

    // A transient fault does not wedge the cadence: the next tick runs.
    fail = false;
    timer.fire();
    await settle();

    expect(onError).toHaveBeenCalledTimes(1); // no new error
  });

  it("swallows a sweep rejection when no onError is wired", async () => {
    const store = {
      sweep: async (): Promise<number> => {
        throw new Error("ignored");
      },
    };
    const timer = timerHarness();

    startRateLimitSweep(store, {
      intervalMs: 1000,
      setInterval: timer.setInterval,
      clearInterval: timer.clearInterval,
    });

    // No unhandled rejection escapes: the catch runs with onError undefined.
    expect(() => timer.fire()).not.toThrow();
    await settle();
  });

  it("unrefs a timer that supports it, so it never pins the event loop", () => {
    const unref = vi.fn();
    const withUnref = { id: 2, unref };
    const timer = timerHarness(withUnref);

    startRateLimitSweep(
      { sweep: async () => 0 },
      { setInterval: timer.setInterval, clearInterval: timer.clearInterval },
    );

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("tolerates a timer with no unref (a non-Node runtime / fake)", () => {
    const timer = timerHarness(42); // a bare numeric handle, no unref method

    expect(() =>
      startRateLimitSweep(
        { sweep: async () => 0 },
        { setInterval: timer.setInterval, clearInterval: timer.clearInterval },
      ),
    ).not.toThrow();
  });

  it("uses the system clock and default windows when unconfigured, and really unrefs + clears", async () => {
    // No injected clock/timers: exercises the Date.now default clock (fired below),
    // the default interval/retention, the REAL setInterval (unref'd) and clearInterval.
    const swept: number[] = [];
    const store = {
      sweep: async (before: number): Promise<number> => {
        swept.push(before);

        return 0;
      },
    };
    const before = Date.now();

    // Inject only setInterval so we can fire the tick and observe the default clock,
    // while leaving retention/interval defaulted.
    let tick: (() => void) | undefined;
    const sweep = startRateLimitSweep(store, {
      setInterval: (cb) => {
        tick = cb;

        return { unref: () => undefined };
      },
    });

    tick?.();
    await settle();

    const after = Date.now();
    expect(swept).toHaveLength(1);
    // The default retention is one hour, and the default clock is the wall clock.
    expect(swept[0]).toBeGreaterThanOrEqual(before - DEFAULT_RATELIMIT_SWEEP_RETENTION_MS);
    expect(swept[0]).toBeLessThanOrEqual(after - DEFAULT_RATELIMIT_SWEEP_RETENTION_MS);

    sweep.stop(); // default clearInterval path
  });

  it("builds and tears down over the real global timers with default options", () => {
    // Covers the default setInterval + clearInterval arrows (real timers). The 60s
    // cadence never fires within the test; stop() clears it immediately (and it is
    // unref'd regardless, so it could never keep the process alive).
    const sweep = startRateLimitSweep({ sweep: async () => 0 });

    expect(DEFAULT_RATELIMIT_SWEEP_INTERVAL_MS).toBe(60_000);
    expect(() => sweep.stop()).not.toThrow();
  });

  it("rejects a non-positive or non-finite intervalMs, loudly, at the call", () => {
    for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => startRateLimitSweep({ sweep: async () => 0 }, { intervalMs })).toThrow(
        /intervalMs/,
      );
    }
  });

  it("rejects a negative or non-finite retentionMs, loudly, at the call", () => {
    for (const retentionMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => startRateLimitSweep({ sweep: async () => 0 }, { retentionMs })).toThrow(
        /retentionMs/,
      );
    }
  });
});
