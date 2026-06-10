import { describe, expect, it } from "vitest";

import { createPgDatabase, openPostgres } from "../src/adapter";
import type { PgClient, PgConfig, PgPool, PgQueryResult } from "../src/adapter";

// ---------------------------------------------------------------------------
// A fake pg pool: every query runs through a handler the test supplies, and the
// fake records the text/values/connection so we can assert the translation,
// BEGIN/COMMIT/ROLLBACK bracketing, client release, and pool end.
// ---------------------------------------------------------------------------

interface QueryCall {
  text: string;
  values: unknown[];
  on: "pool" | "client";
}

type Handler = (text: string, values: unknown[]) => PgQueryResult;

function fakePg(handler: Handler = () => ({ rows: [], rowCount: 0 })) {
  const calls: QueryCall[] = [];
  const state = { released: 0, ended: 0, connected: 0 };

  const query =
    (on: "pool" | "client") =>
    async (text: string, values: unknown[] = []): Promise<PgQueryResult> => {
      calls.push({ text, values, on });

      return handler(text, values);
    };

  const client: PgClient = {
    query: query("client"),
    release: () => {
      state.released += 1;
    },
  };

  const pool: PgPool = {
    query: query("pool"),
    connect: async () => {
      state.connected += 1;

      return client;
    },
    end: async () => {
      state.ended += 1;
    },
  };

  return { pool, calls, state };
}

describe("createPgDatabase — statements", () => {
  it("exec runs the SQL verbatim on the pool", async () => {
    const { pool, calls } = fakePg();
    const db = createPgDatabase(pool);

    await db.exec("CREATE TABLE t (id INTEGER)");

    expect(calls).toEqual([{ text: "CREATE TABLE t (id INTEGER)", values: [], on: "pool" }]);
  });

  it("prepare translates `?` to `$n` once; run reports changes", async () => {
    const { pool, calls } = fakePg(() => ({ rows: [], rowCount: 3 }));
    const db = createPgDatabase(pool);

    const result = await db.prepare("UPDATE t SET a = ? WHERE b = ?").run([1, 2]);

    expect(result).toEqual({ changes: 3 });
    expect(calls[0]?.text).toBe("UPDATE t SET a = $1 WHERE b = $2");
    expect(calls[0]?.values).toEqual([1, 2]);
  });

  it("run surfaces lastInsertRowid from a numeric RETURNING id row", async () => {
    const { pool } = fakePg(() => ({ rows: [{ id: 42 }], rowCount: 1 }));
    const db = createPgDatabase(pool);

    const result = await db.prepare("INSERT INTO t (a) VALUES (?) RETURNING id").run(["x"]);

    expect(result).toEqual({ changes: 1, lastInsertRowid: 42 });
  });

  it("run omits lastInsertRowid when the returned row has no numeric id, and treats null rowCount as 0", async () => {
    const { pool } = fakePg(() => ({ rows: [{ name: "x" }], rowCount: null }));
    const db = createPgDatabase(pool);

    const result = await db.prepare("INSERT INTO t (name) VALUES (?) RETURNING name").run(["x"]);

    expect(result).toEqual({ changes: 0 });
  });

  it("get returns the first row, or undefined when there are none", async () => {
    const present = createPgDatabase(fakePg(() => ({ rows: [{ id: 1 }], rowCount: 1 })).pool);
    const empty = createPgDatabase(fakePg(() => ({ rows: [], rowCount: 0 })).pool);

    expect(await present.prepare("SELECT * FROM t WHERE id = ?").get([1])).toEqual({ id: 1 });
    expect(await empty.prepare("SELECT * FROM t WHERE id = ?").get([9])).toBeUndefined();
  });

  it("all returns every row", async () => {
    const { pool } = fakePg(() => ({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }));
    const db = createPgDatabase(pool);

    expect(await db.prepare("SELECT * FROM t").all()).toEqual([{ id: 1 }, { id: 2 }]);
  });
});

describe("createPgDatabase — transaction", () => {
  it("commits on success, pinning every statement to one client, then releases", async () => {
    const { pool, calls, state } = fakePg(() => ({ rows: [], rowCount: 1 }));
    const db = createPgDatabase(pool);

    const out = await db.transaction(async (tx) => {
      await tx.exec("INSERT INTO t (a) VALUES (1)");

      return "done";
    });

    expect(out).toBe("done");
    expect(calls.map((c) => c.text)).toEqual(["BEGIN", "INSERT INTO t (a) VALUES (1)", "COMMIT"]);
    expect(calls.every((c) => c.on === "client")).toBe(true);
    expect(state.connected).toBe(1);
    expect(state.released).toBe(1);
  });

  it("rolls back and re-raises when the callback throws, still releasing the client", async () => {
    const { pool, calls, state } = fakePg(() => ({ rows: [], rowCount: 0 }));
    const db = createPgDatabase(pool);

    await expect(
      db.transaction(async (tx) => {
        await tx.exec("INSERT INTO t (a) VALUES (1)");

        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(calls.map((c) => c.text)).toEqual(["BEGIN", "INSERT INTO t (a) VALUES (1)", "ROLLBACK"]);
    expect(state.released).toBe(1);
  });

  it("a nested transaction runs flat on the same client (no second BEGIN)", async () => {
    const { pool, calls, state } = fakePg(() => ({ rows: [], rowCount: 1 }));
    const db = createPgDatabase(pool);

    const out = await db.transaction(async (tx) =>
      tx.transaction(async (inner) => {
        await inner.exec("UPDATE t SET a = 1");

        return "nested";
      }),
    );

    expect(out).toBe("nested");
    // One BEGIN/COMMIT around the whole span; the inner transaction added no
    // second BEGIN, and the one client was connected + released once.
    expect(calls.filter((c) => c.text === "BEGIN")).toHaveLength(1);
    expect(calls.filter((c) => c.text === "COMMIT")).toHaveLength(1);
    expect(state.connected).toBe(1);
    expect(state.released).toBe(1);
  });
});

describe("openPostgres", () => {
  it("builds the db from the injected pool and drains it on close", async () => {
    const fake = fakePg(() => ({ rows: [{ id: 7 }], rowCount: 1 }));
    const seen: PgConfig[] = [];

    const { db, close } = await openPostgres({ connectionString: "postgres://x" }, (config) => {
      seen.push(config);

      return fake.pool;
    });

    expect(seen).toEqual([{ connectionString: "postgres://x" }]);
    expect(await db.prepare("SELECT * FROM t WHERE id = ?").get([7])).toEqual({ id: 7 });

    await close();
    expect(fake.state.ended).toBe(1);
  });
});
