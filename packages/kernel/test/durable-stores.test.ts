import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fromRequestMiddleware, lesto, runWithContext } from "@lesto/web";
import type { Lesto } from "@lesto/web";

import {
  createApp,
  durableStores,
  installDurableSchema,
  KERNEL_MEMORY_STORES_CODE,
  resetMemoryStoresWarning,
  secureStack,
} from "../src/index";
import type { App, KernelDatabase, SecureStackOptions } from "../src/index";

// The DI boundary: the kernel speaks "array of positional params"; this adapter
// maps that onto better-sqlite3's variadic bind (mirrors the other suites).
function adapt(raw: Database.Database): KernelDatabase {
  const adapted: KernelDatabase = {
    exec: async (sql) => {
      raw.exec(sql);
    },

    prepare: (sql) => {
      const statement = raw.prepare(sql);

      return {
        run: async (params = []) => statement.run(...(params as never[])),
        get: async (params = []) => statement.get(...(params as never[])),
        all: async (params = []) => statement.all(...(params as never[])),
      };
    },

    transaction: async (fn) => {
      raw.exec("BEGIN");

      try {
        const out = await fn(adapted);
        raw.exec("COMMIT");

        return out;
      } catch (error) {
        try {
          raw.exec("ROLLBACK");
        } catch {
          /* preserve the original error */
        }

        throw error;
      }
    },
  };

  return adapted;
}

// A lesto() app whose only route reads the context; the secure stack is mounted
// as the outermost middleware, exactly as production wires it.
function buildApp(options: SecureStackOptions): Lesto {
  return lesto()
    .use(...secureStack(options).map(fromRequestMiddleware))
    .get("/api/whoami", (c) => c.json({ ok: true }));
}

let raw: Database.Database;
let db: KernelDatabase;

beforeEach(() => {
  raw = new Database(":memory:");
  db = adapt(raw);
  // The latch is module-scoped (one warn per process); reset it so each test
  // starts from "not yet warned" and both latch branches are coverable.
  resetMemoryStoresWarning();
});

afterEach(() => {
  raw.close();
  vi.restoreAllMocks();
});

// Drive a request inside a context with a fixed client IP, as the runtime does,
// so every request in a burst shares one bucket.
const burst = (app: App): Promise<number> =>
  runWithContext({ requestId: "r", ip: "9.9.9.9" }, () => app.handle("GET", "/api/whoami")).then(
    (r) => r.status,
  );

describe("createApp — durable schema install after migrate", () => {
  it("installs the session + rate-limit tables by default, after migrate", async () => {
    await createApp({ db, app: lesto().get("/ping", (c) => c.text("pong")) });

    // The two ADR-0013 tables exist — the pit-of-success default put them there
    // with zero config.
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);

    expect(names).toContain("lesto_sessions");
    expect(names).toContain("lesto_rate_limits");
  });

  it("skips the schema install when durable is false", async () => {
    await createApp({ db, app: lesto().get("/ping", (c) => c.text("pong")), durable: false });

    const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[];
    const names = tables.map((t) => t.name);

    expect(names).not.toContain("lesto_sessions");
    expect(names).not.toContain("lesto_rate_limits");
  });
});

describe("secureStack — durable rate-limit store (zero-config fleet correctness)", () => {
  it("shares one SQL bucket across two independently-built stacks over one handle", async () => {
    // The whole point: two app handles over the SAME db must share rate-limit
    // state — a burst spent on one is gone on the other. Memory stores cannot do
    // this; the SQL store auto-wired from `db` does.
    await installDurableSchema(db);

    const a = await createApp({
      db,
      durable: false, // schema already installed above; don't re-install
      app: buildApp({ db, rateLimit: { capacity: 2, refillPerSecond: 0.000001 } }),
    });
    const b = await createApp({
      db,
      durable: false,
      app: buildApp({ db, rateLimit: { capacity: 2, refillPerSecond: 0.000001 } }),
    });

    // Spend the whole bucket through handle A.
    expect(await burst(a)).toBe(200);
    expect(await burst(a)).toBe(200);

    // Handle B, a separate stack and limiter, sees the SAME drained SQL bucket.
    expect(await burst(b)).toBe(429);
  });

  it("threads dialect into the durable store (postgres narrowing path)", async () => {
    // `dialect: "postgres"` keys the FOR-UPDATE path in the SQL store. SQLite
    // rejects FOR UPDATE, so this proves the kernel narrowed the dialect through
    // by observing the resulting prepare error rather than a silent SQLite run.
    await installDurableSchema(db);

    const app = await createApp({
      db,
      durable: false,
      app: buildApp({ db, dialect: "postgres", rateLimit: { capacity: 1, refillPerSecond: 1 } }),
    });

    await expect(burst(app)).rejects.toThrow();
  });

  it("does not warn when a db is wired, even in production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    secureStack({ db, production: true, rateLimit: { capacity: 1, refillPerSecond: 1 } });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("secureStack — production-without-db memory warning (warn-once latch)", () => {
  it("warns exactly once, carrying the stable code", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // First production stack with no db: the warning fires.
    secureStack({ production: true, rateLimit: { capacity: 1, refillPerSecond: 1 } });
    // A SECOND such stack must stay silent — the latch is per-process.
    secureStack({ production: true, rateLimit: { capacity: 1, refillPerSecond: 1 } });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(KERNEL_MEMORY_STORES_CODE);
  });

  it("routes the warning through an injected onMemoryStores seam", () => {
    const onMemoryStores = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    secureStack({
      production: true,
      onMemoryStores,
      rateLimit: { capacity: 1, refillPerSecond: 1 },
    });

    expect(onMemoryStores).toHaveBeenCalledTimes(1);
    // The injected seam replaces the default console.warn entirely.
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent outside production (memory stores are correct in dev/test)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // No `production` flag → dev/test → memory rate limiting is fine, no warning.
    secureStack({ rateLimit: { capacity: 1, refillPerSecond: 1 } });

    expect(warn).not.toHaveBeenCalled();
  });

  it("never warns when the caller brings its own limiter (explicit operator choice)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { RateLimiter, MemoryRateLimitStore } = await import("@lesto/ratelimit");

    secureStack({
      production: true,
      rateLimit: {
        capacity: 1,
        refillPerSecond: 1,
        limiter: new RateLimiter({
          store: new MemoryRateLimitStore(),
          capacity: 1,
          refillPerSecond: 1,
        }),
      },
    });

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("durableStores — the matched session + rate-limit pair", () => {
  it("builds both stores over one handle; the session store reads its own rows", async () => {
    await installDurableSchema(db);

    const { sessionStore, rateLimitStore } = await durableStores(db);

    // Session store: save then find the same row through the same handle.
    await sessionStore.save({ token: "t1", userId: "u1", expiresAt: 9_999_999_999_999 });
    expect(await sessionStore.find("t1")).toEqual({
      token: "t1",
      userId: "u1",
      expiresAt: 9_999_999_999_999,
    });

    // Rate-limit store: a first-seen key takes the insert path.
    const state = await rateLimitStore.update("k", () => ({ tokens: 3, updatedAt: 1_000 }));
    expect(state).toEqual({ tokens: 3, updatedAt: 1_000 });
  });

  it("threads dialect into the rate-limit store half", async () => {
    await installDurableSchema(db);

    // postgres dialect → FOR UPDATE → SQLite rejects it → the update throws,
    // proving the dialect reached the store. (Default sqlite path is exercised
    // by the test above.)
    const { rateLimitStore } = await durableStores(db, { dialect: "postgres" });

    await expect(rateLimitStore.update("k", () => ({ tokens: 1, updatedAt: 1 }))).rejects.toThrow();
  });
});
