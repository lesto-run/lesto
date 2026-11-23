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
  const state = { released: 0, ended: 0, connected: 0, releaseErr: undefined as unknown };

  const query =
    (on: "pool" | "client") =>
    async (text: string, values: unknown[] = []): Promise<PgQueryResult> => {
      calls.push({ text, values, on });

      return handler(text, values);
    };

  const client: PgClient = {
    query: query("client"),
    release: (err?: unknown) => {
      state.released += 1;
      state.releaseErr = err;
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

  it("run returns only { changes } — lastInsertRowid is never inferred (pg omits it)", async () => {
    // Even when a RETURNING row comes back, run() does NOT leak an id; a caller
    // that wants the id reads it via .returning().get() / RETURNING id + .get().
    const { pool } = fakePg(() => ({ rows: [{ id: 42 }], rowCount: 1 }));
    const db = createPgDatabase(pool);

    const result = await db.prepare("INSERT INTO t (a) VALUES (?) RETURNING id").run(["x"]);

    expect(result).toEqual({ changes: 1 });
  });

  it("treats a null rowCount as 0 changes", async () => {
    const { pool } = fakePg(() => ({ rows: [], rowCount: null }));
    const db = createPgDatabase(pool);

    expect(await db.prepare("UPDATE t SET a = ?").run([1])).toEqual({ changes: 0 });
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

  it("rolls back and re-raises when the callback throws, discarding the client via release(err)", async () => {
    const { pool, calls, state } = fakePg(() => ({ rows: [], rowCount: 0 }));
    const db = createPgDatabase(pool);

    const boom = new Error("boom");

    await expect(
      db.transaction(async (tx) => {
        await tx.exec("INSERT INTO t (a) VALUES (1)");

        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(calls.map((c) => c.text)).toEqual(["BEGIN", "INSERT INTO t (a) VALUES (1)", "ROLLBACK"]);
    expect(state.released).toBe(1);
    // The error is handed to release() so the pool discards the suspect client.
    expect(state.releaseErr).toBe(boom);
  });

  it("a failing ROLLBACK does not mask the original error", async () => {
    // The work throws, then ROLLBACK itself throws — the ORIGINAL error must win.
    const { pool, state } = fakePg((text) => {
      if (text === "ROLLBACK") throw new Error("rollback failed");

      return { rows: [], rowCount: 0 };
    });
    const db = createPgDatabase(pool);

    const boom = new Error("original");

    await expect(
      db.transaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(state.released).toBe(1);
    expect(state.releaseErr).toBe(boom);
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

  it("stamps the postgres dialect marker on the handle AND on the tx handle", async () => {
    const { pool } = fakePg();
    const db = createPgDatabase(pool);

    // The marker is what lets a consumer (the queue, createDb) infer the engine
    // instead of trusting a caller-remembered flag — and the tx handle is a
    // SqlDatabase too, so it must carry the same stamp.
    expect(db.dialect).toBe("postgres");

    await db.transaction(async (tx) => {
      expect(tx.dialect).toBe("postgres");
    });
  });
});

describe("createPgDatabase — batch", () => {
  it("runs the statements in order on ONE client inside BEGIN/COMMIT, with per-statement results", async () => {
    const { pool, calls, state } = fakePg((text) =>
      text.startsWith("SELECT") ? { rows: [{ id: 1 }], rowCount: 1 } : { rows: [], rowCount: 2 },
    );

    const results = await createPgDatabase(pool).batch([
      { sql: "UPDATE t SET a = ? WHERE b = ?", params: [1, 2], returns: "changes" },
      { sql: "SELECT * FROM t WHERE a = ?", params: [1], returns: "rows" },
    ]);

    expect(results).toEqual([
      { returns: "changes", changes: 2 },
      { returns: "rows", rows: [{ id: 1 }] },
    ]);
    expect(calls).toEqual([
      { text: "BEGIN", values: [], on: "client" },
      { text: "UPDATE t SET a = $1 WHERE b = $2", values: [1, 2], on: "client" },
      { text: "SELECT * FROM t WHERE a = $1", values: [1], on: "client" },
      { text: "COMMIT", values: [], on: "client" },
    ]);
    expect(state.connected).toBe(1);
    expect(state.released).toBe(1);
  });

  it("all-or-nothing: a failing statement rolls back the span and stops the batch", async () => {
    const violation = new Error("duplicate key value violates unique constraint");
    const { pool, calls, state } = fakePg((text) => {
      if (text.startsWith("INSERT INTO t (b)")) throw violation;

      return { rows: [], rowCount: 1 };
    });

    await expect(
      createPgDatabase(pool).batch([
        { sql: "INSERT INTO t (a) VALUES (?)", params: [1], returns: "changes" },
        { sql: "INSERT INTO t (b) VALUES (?)", params: [2], returns: "changes" },
        { sql: "INSERT INTO t (c) VALUES (?)", params: [3], returns: "changes" },
      ]),
    ).rejects.toBe(violation);

    expect(calls.map((c) => c.text)).toEqual([
      "BEGIN",
      "INSERT INTO t (a) VALUES ($1)",
      "INSERT INTO t (b) VALUES ($1)",
      "ROLLBACK",
    ]);
    expect(state.releaseErr).toBe(violation);
  });

  it("an empty batch resolves [] and never checks out a client", async () => {
    const { pool, calls, state } = fakePg();

    await expect(createPgDatabase(pool).batch([])).resolves.toEqual([]);
    expect(calls).toEqual([]);
    expect(state.connected).toBe(0);
  });

  it("a batch on the tx handle runs flat inside the open span (no second BEGIN)", async () => {
    const { pool, calls } = fakePg(() => ({ rows: [], rowCount: 1 }));

    await createPgDatabase(pool).transaction((tx) =>
      tx.batch([{ sql: "UPDATE t SET a = 1", params: [], returns: "changes" }]),
    );

    expect(calls.map((c) => c.text)).toEqual(["BEGIN", "UPDATE t SET a = 1", "COMMIT"]);
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
