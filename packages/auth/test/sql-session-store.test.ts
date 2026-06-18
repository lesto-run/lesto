/**
 * `sqlSessionStore` / `installSessionSchema` — the durable, SQL-backed session
 * store (ADR 0013 §4).
 *
 * Auth stays dependency-free: rather than boot a real SQLite engine, these tests
 * drive a tiny SQL-keyed fake `SqlDatabase` — a Map of rows plus a dispatch that
 * recognizes the exact statements the store prepares. That proves the store's
 * own logic (parameter shapes, upsert, the string→number coercion, the two
 * sweeps). The real-engine, two-driver proof is `@volo/integration` (item 7).
 */

import { describe, expect, it } from "vitest";

import {
  installSessionSchema,
  MemorySessionStore,
  Sessions,
  sha256,
  sqlSessionStore,
} from "../src/index";
import type { Session, SqlDatabase, SqlStatement } from "../src/index";

interface Row {
  token: string;
  user_id: string;
  expires_at: number | string;
}

/**
 * A fake `SqlDatabase` over a Map keyed by token. `prepare` returns a statement
 * that dispatches on the SQL text the store actually issues; `exec` records DDL
 * so `installSessionSchema`'s call shapes can be asserted. `expiresAsString`
 * forces `expires_at` to be returned string-typed (the node-postgres BIGINT
 * shape) so the read-side `Number()` coercion is exercised.
 */
function makeFakeDb(options: { expiresAsString?: boolean } = {}): {
  db: SqlDatabase;
  rows: Map<string, Row>;
  execed: string[];
} {
  const rows = new Map<string, Row>();
  const execed: string[] = [];

  const readExpires = (value: number): number | string =>
    options.expiresAsString ? String(value) : value;

  const prepare = (sql: string): SqlStatement => {
    if (sql.includes("INSERT INTO volo_sessions")) {
      return {
        run: async (params = []) => {
          const [token, userId, expiresAt] = params as [string, string, number];
          rows.set(token, { token, user_id: userId, expires_at: readExpires(expiresAt) });
          return { changes: 1 };
        },
        get: async () => undefined,
        all: async () => [],
      };
    }

    if (sql.startsWith("SELECT")) {
      return {
        run: async () => ({ changes: 0 }),
        get: async (params = []) => {
          const [token] = params as [string];
          return rows.get(token);
        },
        all: async () => [],
      };
    }

    if (sql.includes("WHERE token = ?")) {
      return {
        run: async (params = []) => {
          const [token] = params as [string];
          const changes = rows.delete(token) ? 1 : 0;
          return { changes };
        },
        get: async () => undefined,
        all: async () => [],
      };
    }

    if (sql.includes("WHERE user_id = ?")) {
      return {
        run: async (params = []) => {
          const [userId] = params as [string];
          let changes = 0;
          for (const [token, row] of rows) {
            if (row.user_id === userId) {
              rows.delete(token);
              changes += 1;
            }
          }
          return { changes };
        },
        get: async () => undefined,
        all: async () => [],
      };
    }

    // DELETE ... WHERE expires_at < ?
    return {
      run: async (params = []) => {
        const [before] = params as [number];
        let changes = 0;
        for (const [token, row] of rows) {
          if (Number(row.expires_at) < before) {
            rows.delete(token);
            changes += 1;
          }
        }
        return { changes };
      },
      get: async () => undefined,
      all: async () => [],
    };
  };

  const db: SqlDatabase = {
    prepare,
    exec: async (sql) => {
      execed.push(sql.trim());
    },
  };

  return { db, rows, execed };
}

describe("installSessionSchema", () => {
  it("issues the table + two indexes, all IF NOT EXISTS (idempotent)", async () => {
    const { db, execed } = makeFakeDb();

    await installSessionSchema(db);
    // Idempotent — a second install must not throw.
    await installSessionSchema(db);

    expect(execed).toHaveLength(6);

    const [create, userIndex, expiresIndex] = execed;
    expect(create).toContain("CREATE TABLE IF NOT EXISTS volo_sessions");
    // BIGINT, not INTEGER — epoch-ms overflows PG int4.
    expect(create).toContain("expires_at BIGINT NOT NULL");
    expect(userIndex).toContain("CREATE INDEX IF NOT EXISTS volo_sessions_user_id");
    expect(expiresIndex).toContain("CREATE INDEX IF NOT EXISTS volo_sessions_expires_at");
  });
});

describe("sqlSessionStore", () => {
  const session: Session = { token: "t1", userId: "u1", expiresAt: 1_800_000_000_000 };

  it("save then find round-trips the session", async () => {
    const { db } = makeFakeDb();
    const store = sqlSessionStore(db);

    await store.save(session);

    expect(await store.find("t1")).toEqual(session);
  });

  it("stores the token's SHA-256 digest, never the plaintext (snapshot-safe)", async () => {
    const { db, rows } = makeFakeDb();
    const store = sqlSessionStore(db);

    await store.save(session);

    // The row is keyed by sha256(token) — the plaintext "t1" is nowhere in the
    // table, so a leaked DB dump holds nothing a client could present.
    expect(rows.has("t1")).toBe(false);
    expect(rows.has(sha256("t1"))).toBe(true);
    expect(rows.get(sha256("t1"))?.token).toBe(sha256("t1"));

    // find/delete still take (and return) the plaintext — hashing is invisible.
    const found = await store.find("t1");
    expect(found?.token).toBe("t1");
  });

  it("find returns undefined when only the raw digest (not the plaintext) is presented", async () => {
    // Defense-in-depth: an attacker holding a snapshot digest cannot replay it
    // as a token — presenting the digest hashes it AGAIN and matches no row.
    const { db } = makeFakeDb();
    const store = sqlSessionStore(db);

    await store.save(session);

    expect(await store.find(sha256("t1"))).toBeUndefined();
  });

  it("save upserts on the primary key (re-save overwrites, never duplicates)", async () => {
    const { db, rows } = makeFakeDb();
    const store = sqlSessionStore(db);

    await store.save(session);
    await store.save({ token: "t1", userId: "u2", expiresAt: 1_900_000_000_000 });

    expect(rows.size).toBe(1);
    expect(await store.find("t1")).toEqual({
      token: "t1",
      userId: "u2",
      expiresAt: 1_900_000_000_000,
    });
  });

  it("find returns undefined on a miss", async () => {
    const { db } = makeFakeDb();
    const store = sqlSessionStore(db);

    expect(await store.find("nope")).toBeUndefined();
  });

  it("coerces a string-typed expires_at (the PG BIGINT shape) to a number", async () => {
    const { db } = makeFakeDb({ expiresAsString: true });
    const store = sqlSessionStore(db);

    await store.save(session);

    const found = await store.find("t1");
    expect(found?.expiresAt).toBe(1_800_000_000_000);
    expect(typeof found?.expiresAt).toBe("number");
    expect(typeof found?.userId).toBe("string");
  });

  it("delete removes the row", async () => {
    const { db, rows } = makeFakeDb();
    const store = sqlSessionStore(db);

    await store.save(session);
    await store.delete("t1");

    expect(rows.size).toBe(0);
    expect(await store.find("t1")).toBeUndefined();
  });

  it("deleteByUserId removes exactly that user's sessions and returns the count", async () => {
    const { db } = makeFakeDb();
    const store = sqlSessionStore(db);

    await store.save({ token: "a", userId: "u1", expiresAt: 1 });
    await store.save({ token: "b", userId: "u1", expiresAt: 2 });
    await store.save({ token: "c", userId: "u2", expiresAt: 3 });

    expect(await store.deleteByUserId("u1")).toBe(2);
    expect(await store.find("a")).toBeUndefined();
    expect(await store.find("c")).not.toBeUndefined();
  });

  it("deleteExpired deletes rows strictly before `now` (boundary: < now, not >= now)", async () => {
    const { db } = makeFakeDb();
    const store = sqlSessionStore(db);

    await store.save({ token: "past", userId: "u", expiresAt: 99 });
    await store.save({ token: "at", userId: "u", expiresAt: 100 });
    await store.save({ token: "future", userId: "u", expiresAt: 101 });

    expect(await store.deleteExpired(100)).toBe(1);
    expect(await store.find("past")).toBeUndefined();
    // `at` (== now) is NOT swept — the predicate is strict `<`.
    expect(await store.find("at")).not.toBeUndefined();
    expect(await store.find("future")).not.toBeUndefined();
  });
});

describe("Sessions over sqlSessionStore", () => {
  it("create → verify → expire-deletes-the-row, all through the SQL store", async () => {
    const { db, rows } = makeFakeDb();
    let now = 1_000;
    const sessions = new Sessions({ store: sqlSessionStore(db), clock: () => now });

    const session = await sessions.create("u1", 60_000);
    expect(rows.size).toBe(1);

    now = 30_000;
    expect(await sessions.verify(session.token)).toEqual(session);

    // At expiry, verify returns undefined AND deletes the row (sweep-on-sight).
    now = 61_000;
    expect(await sessions.verify(session.token)).toBeUndefined();
    expect(rows.size).toBe(0);
  });

  it("is interchangeable with the memory store (same Sessions contract)", async () => {
    let now = 1_000;
    const sessions = new Sessions({ store: new MemorySessionStore(), clock: () => now });

    const session = await sessions.create("u1", 60_000);
    now = 30_000;
    expect(await sessions.verify(session.token)).toEqual(session);
  });
});
