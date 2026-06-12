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

import { describe, expect, it } from "vitest";

import {
  installRateLimitSchema,
  isUniqueViolation,
  MemoryRateLimitStore,
  RateLimiter,
  RateLimitError,
  sqlRateLimitStore,
} from "../src/index";
import type { BucketState, Dialect, SqlDatabase, SqlStatement } from "../src/index";

interface Row {
  tokens: number | string;
  updated_at: number | string;
}

/** An error shaped like a SQLite unique violation. */
function uniqueViolation(): Error {
  return new Error("UNIQUE constraint failed: keel_rate_limits.key");
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
    expect(create).toContain("CREATE TABLE IF NOT EXISTS keel_rate_limits");
    expect(create).toContain("tokens     DOUBLE PRECISION NOT NULL");
    expect(create).toContain("updated_at BIGINT NOT NULL");
    expect(index).toContain("CREATE INDEX IF NOT EXISTS keel_rate_limits_updated_at");
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
  it("is true for the PG SQLSTATE, true for SQLITE_CONSTRAINT* and the message shape", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
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
