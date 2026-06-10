import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Cache, installCacheSchema, MemoryStore, sqlStore, systemClock } from "../src/index";

import type { CacheStore, SqlDatabase } from "../src/index";

// A clock we can stop, so every expiry path is deterministic.
let now: number;
const clock = (): number => now;

// A small adapter around better-sqlite3 — wired only in the test, never in src.
// The driver seam is Promise-returning (ADR 0006): `prepare()` stays sync, but
// the terminals and `exec` resolve, and `transaction(fn)` brackets the work in
// BEGIN/COMMIT (ROLLBACK on reject). better-sqlite3 is synchronous under the
// hood, so each verb resolves an already-computed value.
let database: Database.Database;
const makeSqlDatabase = (): SqlDatabase => {
  database = new Database(":memory:");

  const adapt = (): SqlDatabase => ({
    prepare: (sql) => {
      const statement = database.prepare(sql);

      return {
        run: async (parameters = []) => statement.run(...parameters),
        get: async (parameters = []) => statement.get(...parameters),
        all: async (parameters = []) => statement.all(...parameters) as unknown[],
      };
    },
    exec: async (sql) => {
      database.exec(sql);
    },
    transaction: async (fn) => {
      database.exec("BEGIN");

      try {
        const result = await fn(adapt());

        database.exec("COMMIT");

        return result;
      } catch (error) {
        database.exec("ROLLBACK");

        throw error;
      }
    },
  });

  return adapt();
};

afterEach(() => {
  database?.close();
});

// Each store is exercised through the identical suite, end to end.
const stores: ReadonlyArray<{ name: string; make: () => CacheStore }> = [
  { name: "MemoryStore", make: () => new MemoryStore() },
  {
    name: "sqlStore",
    make: () => {
      const db = makeSqlDatabase();
      installCacheSchema(db);
      // installCacheSchema is idempotent — a second call must not throw.
      installCacheSchema(db);

      return sqlStore(db);
    },
  },
];

describe.each(stores)("Cache over $name", ({ make }) => {
  let store: CacheStore;
  let cache: Cache;

  beforeEach(() => {
    now = 1_000_000;
    store = make();
    cache = new Cache({ store, clock });
  });

  describe("fetch", () => {
    it("misses: produces, caches, and returns the value", async () => {
      let calls = 0;

      const value = await cache.fetch("k", () => {
        calls += 1;

        return { hello: "world" };
      });

      expect(value).toEqual({ hello: "world" });
      expect(calls).toBe(1);
      expect(await cache.read("k")).toEqual({ hello: "world" });
    });

    it("hits: returns the cached value without calling produce", async () => {
      await cache.write("k", 41);

      const value = await cache.fetch("k", () => {
        throw new Error("produce must not run on a hit");
      });

      expect(value).toBe(41);
    });

    it("re-produces when the cached entry has expired", async () => {
      await cache.fetch("k", () => "stale", { ttlMs: 100 });

      now += 101; // past the deadline

      let calls = 0;
      const value = await cache.fetch("k", () => {
        calls += 1;

        return "fresh";
      });

      expect(value).toBe("fresh");
      expect(calls).toBe(1);
      expect(await cache.read("k")).toBe("fresh");
    });
  });

  describe("remember (single-flight)", () => {
    it("misses: computes, caches, and returns the value", async () => {
      let calls = 0;

      const value = await cache.remember("k", () => {
        calls += 1;

        return { hello: "world" };
      });

      expect(value).toEqual({ hello: "world" });
      expect(calls).toBe(1);
      expect(await cache.read("k")).toEqual({ hello: "world" });
    });

    it("hits: returns the cached value without computing", async () => {
      await cache.write("k", 41);

      const value = await cache.remember("k", () => {
        throw new Error("compute must not run on a hit");
      });

      expect(value).toBe(41);
    });

    it("coalesces N concurrent misses into a single compute", async () => {
      let calls = 0;

      // A compute we control: it parks until we release it, so all N callers
      // are provably in flight at the same time before any of them resolves.
      let release!: (value: string) => void;
      const gate = new Promise<string>((resolve) => {
        release = resolve;
      });

      const compute = (): Promise<string> => {
        calls += 1;

        return gate;
      };

      // Fire ten callers at the same key before the compute can settle.
      const callers = Array.from({ length: 10 }, () => cache.remember("k", compute));

      release("shared");

      const results = await Promise.all(callers);

      // Every caller saw the one shared value; compute ran exactly once.
      expect(results).toEqual(Array.from({ length: 10 }, () => "shared"));
      expect(calls).toBe(1);

      // The value landed in the cache, and the in-flight ledger was released:
      // a fresh call now hits without recomputing.
      expect(await cache.read("k")).toBe("shared");
      expect(await cache.remember("k", () => "ignored")).toBe("shared");
      expect(calls).toBe(1);
    });

    it("re-computes once the cached entry has expired", async () => {
      await cache.remember("k", () => "stale", { ttlMs: 100 });

      now += 101; // past the deadline

      let calls = 0;
      const value = await cache.remember("k", () => {
        calls += 1;

        return "fresh";
      });

      expect(value).toBe("fresh");
      expect(calls).toBe(1);
      expect(await cache.read("k")).toBe("fresh");
    });

    it("propagates a rejection to every waiter and caches nothing", async () => {
      let calls = 0;

      let fail!: (error: Error) => void;
      const gate = new Promise<string>((_resolve, reject) => {
        fail = reject;
      });

      const boom = new Error("origin is down");

      const compute = (): Promise<string> => {
        calls += 1;

        return gate;
      };

      // Three callers join the one in-flight compute, then it fails.
      const callers = [
        cache.remember("k", compute),
        cache.remember("k", compute),
        cache.remember("k", compute),
      ];

      fail(boom);

      // Each waiter sees the very same rejection — the compute ran once.
      const settled = await Promise.allSettled(callers);
      for (const outcome of settled) {
        expect(outcome.status).toBe("rejected");
        expect((outcome as PromiseRejectedResult).reason).toBe(boom);
      }
      expect(calls).toBe(1);

      // No poisoned cache: the failed key was never written…
      expect(await cache.read("k")).toBeUndefined();

      // …and the ledger was released, so the next call retries cleanly.
      const retried = await cache.remember("k", () => "recovered");
      expect(retried).toBe("recovered");
      expect(await cache.read("k")).toBe("recovered");
    });

    it("a delete mid-flight wins: the resolving leader does not resurrect the value", async () => {
      let release!: (value: string) => void;
      const gate = new Promise<string>((resolve) => {
        release = resolve;
      });

      // `read` is async now (ADR 0006), so the leader registers its ledger entry
      // a microtask after `remember` is called — not synchronously. We gate the
      // invalidation on the compute actually starting, so the delete provably
      // lands *after* the lead is registered and *while* it is still parked.
      let started!: () => void;
      const computing = new Promise<void>((resolve) => {
        started = resolve;
      });

      const caller = cache.remember("k", () => {
        started();

        return gate;
      });

      await computing;

      await cache.delete("k");

      release("late");

      // The leader still resolves with the value it computed — the work was
      // real and joined waiters must see something — but the explicit delete
      // wins: nothing is written back to the store.
      expect(await caller).toBe("late");
      expect(await cache.read("k")).toBeUndefined();

      // And the ledger is empty, so the next call leads a fresh compute.
      let calls = 0;
      const fresh = await cache.remember("k", () => {
        calls += 1;

        return "fresh";
      });
      expect(fresh).toBe("fresh");
      expect(calls).toBe(1);
      expect(await cache.read("k")).toBe("fresh");
    });

    it("a clear mid-flight wins: the resolving leader does not resurrect the value", async () => {
      let release!: (value: string) => void;
      const gate = new Promise<string>((resolve) => {
        release = resolve;
      });

      let started!: () => void;
      const computing = new Promise<void>((resolve) => {
        started = resolve;
      });

      const caller = cache.remember("k", () => {
        started();

        return gate;
      });

      await computing;

      await cache.clear();

      release("late");

      expect(await caller).toBe("late");
      expect(await cache.read("k")).toBeUndefined();
    });

    it("a fresh leader after a mid-flight delete is not clobbered by the stale one", async () => {
      // Two computes we release independently, to drive the exact interleaving:
      // stale leads → delete → fresh leads → fresh resolves → stale resolves.
      let releaseStale!: (value: string) => void;
      const staleGate = new Promise<string>((resolve) => {
        releaseStale = resolve;
      });

      let releaseFresh!: (value: string) => void;
      const freshGate = new Promise<string>((resolve) => {
        releaseFresh = resolve;
      });

      let staleStarted!: () => void;
      const staleComputing = new Promise<void>((resolve) => {
        staleStarted = resolve;
      });

      const stale = cache.remember("k", () => {
        staleStarted();

        return staleGate;
      });

      // Wait for the stale leader's ledger entry to exist before invalidating it.
      await staleComputing;

      // Invalidate, abandoning the stale leader's ledger entry.
      await cache.delete("k");

      // A new caller now leads its own compute for the same key. Wait for it to
      // register before driving the resolutions.
      let freshStarted!: () => void;
      const freshComputing = new Promise<void>((resolve) => {
        freshStarted = resolve;
      });

      const fresh = cache.remember("k", () => {
        freshStarted();

        return freshGate;
      });

      await freshComputing;

      // Fresh settles first and writes; then the stale leader settles last.
      releaseFresh("fresh");
      expect(await fresh).toBe("fresh");
      expect(await cache.read("k")).toBe("fresh");

      releaseStale("stale");
      expect(await stale).toBe("stale");

      // The late, stale leader neither overwrote the fresh value nor cleared the
      // fresh ledger entry: the cache still holds "fresh".
      expect(await cache.read("k")).toBe("fresh");
    });
  });

  describe("write", () => {
    it("with a ttl: the value lives until the deadline, then expires", async () => {
      await cache.write("k", "v", { ttlMs: 50 });

      now += 49;
      expect(await cache.read("k")).toBe("v");

      now += 1; // exactly at the deadline counts as expired
      expect(await cache.read("k")).toBeUndefined();
    });

    it("without a ttl: the value never expires", async () => {
      await cache.write("k", "forever");

      now += 1_000_000_000;
      expect(await cache.read("k")).toBe("forever");
    });
  });

  describe("read", () => {
    it("returns undefined for a missing key", async () => {
      expect(await cache.read("absent")).toBeUndefined();
    });

    it("deletes an expired entry and returns undefined", async () => {
      await cache.write("k", "v", { ttlMs: 10 });

      now += 11;

      expect(await cache.read("k")).toBeUndefined();
      // The dead entry was evicted at the store level, not merely hidden.
      expect(await store.get("k")).toBeUndefined();
    });
  });

  it("delete removes a single key", async () => {
    await cache.write("k", "v");

    await cache.delete("k");

    expect(await cache.read("k")).toBeUndefined();
  });

  it("clear empties the whole store", async () => {
    await cache.write("a", 1);
    await cache.write("b", 2);

    await cache.clear();

    expect(await cache.read("a")).toBeUndefined();
    expect(await cache.read("b")).toBeUndefined();
  });
});

describe("default clock", () => {
  it("uses real time when no clock is injected", async () => {
    const cache = new Cache({ store: new MemoryStore() });

    // A ttl far in the future stays live against the real wall clock.
    await cache.write("k", "v", { ttlMs: 60_000 });
    expect(await cache.read("k")).toBe("v");

    // A ttl already in the past expires immediately.
    await cache.write("expired", "v", { ttlMs: -1 });
    expect(await cache.read("expired")).toBeUndefined();
  });

  it("exports a systemClock that returns epoch milliseconds", () => {
    const before = Date.now();

    const t = systemClock();

    expect(t).toBeGreaterThanOrEqual(before);
  });
});
