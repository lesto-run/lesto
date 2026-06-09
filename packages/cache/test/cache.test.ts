import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Cache, installCacheSchema, MemoryStore, sqlStore, systemClock } from "../src/index";

import type { CacheStore, SqlDatabase } from "../src/index";

// A clock we can stop, so every expiry path is deterministic.
let now: number;
const clock = (): number => now;

// A ~6-line adapter around better-sqlite3 — wired only in the test, never in src.
let database: Database.Database;
const makeSqlDatabase = (): SqlDatabase => {
  database = new Database(":memory:");

  return {
    prepare: (sql) => {
      const statement = database.prepare(sql);

      return {
        run: (parameters = []) => statement.run(...parameters),
        get: (parameters = []) => statement.get(...parameters),
        all: (parameters = []) => statement.all(...parameters),
      };
    },
    exec: (sql) => database.exec(sql),
  };
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
      expect(cache.read("k")).toEqual({ hello: "world" });
    });

    it("hits: returns the cached value without calling produce", async () => {
      cache.write("k", 41);

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
      expect(cache.read("k")).toBe("fresh");
    });
  });

  describe("write", () => {
    it("with a ttl: the value lives until the deadline, then expires", () => {
      cache.write("k", "v", { ttlMs: 50 });

      now += 49;
      expect(cache.read("k")).toBe("v");

      now += 1; // exactly at the deadline counts as expired
      expect(cache.read("k")).toBeUndefined();
    });

    it("without a ttl: the value never expires", () => {
      cache.write("k", "forever");

      now += 1_000_000_000;
      expect(cache.read("k")).toBe("forever");
    });
  });

  describe("read", () => {
    it("returns undefined for a missing key", () => {
      expect(cache.read("absent")).toBeUndefined();
    });

    it("deletes an expired entry and returns undefined", () => {
      cache.write("k", "v", { ttlMs: 10 });

      now += 11;

      expect(cache.read("k")).toBeUndefined();
      // The dead entry was evicted at the store level, not merely hidden.
      expect(store.get("k")).toBeUndefined();
    });
  });

  it("delete removes a single key", () => {
    cache.write("k", "v");

    cache.delete("k");

    expect(cache.read("k")).toBeUndefined();
  });

  it("clear empties the whole store", () => {
    cache.write("a", 1);
    cache.write("b", 2);

    cache.clear();

    expect(cache.read("a")).toBeUndefined();
    expect(cache.read("b")).toBeUndefined();
  });
});

describe("default clock", () => {
  it("uses real time when no clock is injected", () => {
    const cache = new Cache({ store: new MemoryStore() });

    // A ttl far in the future stays live against the real wall clock.
    cache.write("k", "v", { ttlMs: 60_000 });
    expect(cache.read("k")).toBe("v");

    // A ttl already in the past expires immediately.
    cache.write("expired", "v", { ttlMs: -1 });
    expect(cache.read("expired")).toBeUndefined();
  });

  it("exports a systemClock that returns epoch milliseconds", () => {
    const before = Date.now();

    const t = systemClock();

    expect(t).toBeGreaterThanOrEqual(before);
  });
});
