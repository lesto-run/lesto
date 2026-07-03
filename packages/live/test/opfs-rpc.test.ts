import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { createWorkerSqlDatabase } from "../src/opfs-rpc";
import type { RpcPort } from "../src/opfs-rpc";

/**
 * {@link createWorkerSqlDatabase} is the main-thread half of the OPFS-SQLite Worker (v1 Inc9). It
 * cannot spawn a real `Worker` under vitest, so these tests drive it over a fake {@link RpcPort}
 * pair. The realistic path is backed by a REAL better-sqlite3 (the repo's canonical test engine),
 * faithfully mirroring `opfs-worker.ts`'s dispatch — so the request→response mapping is proven
 * against genuine SQLite, not canned replies. A second, fully-programmable port covers the
 * correlation edges a happy engine never produces (strays, missing fields, a refused open).
 */

type Listener = (event: { data: unknown }) => void;

interface WorkerMessage {
  readonly id?: number;
  readonly op?: string;
  readonly sql?: string;
  readonly bind?: readonly unknown[];
  readonly wantRows?: boolean;
}

/**
 * A fake worker backed by a real in-memory better-sqlite3, mirroring `opfs-worker.ts`'s `handleMessage`
 * exactly (id echo, wantRows vs. changes, the string form for schema/`BEGIN`…`COMMIT`, error catch).
 */
function sqliteBackedChannel(): { clientPort: RpcPort; dispose: () => void } {
  const clientListeners = new Set<Listener>();
  const workerListeners = new Set<Listener>();
  let db: Database.Database | undefined;

  const toClient = (message: unknown): void => {
    queueMicrotask(() => clientListeners.forEach((listener) => listener({ data: message })));
  };

  const onRequest: Listener = (event) => {
    const message = event.data as WorkerMessage;
    const { id } = message;

    if (typeof id !== "number") return;

    try {
      if (message.op === "open") {
        db = new Database(":memory:");
        toClient({ id, ok: true });
        return;
      }

      if (message.op === "exec") {
        if (db === undefined) throw new Error("exec before open");
        if (typeof message.sql !== "string") throw new Error("missing sql");

        if (message.wantRows === true) {
          const rows = db.prepare(message.sql).all(...((message.bind ?? []) as unknown[]));
          toClient({ id, ok: true, rows });
          return;
        }

        if (message.bind !== undefined) {
          const info = db.prepare(message.sql).run(...(message.bind as unknown[]));
          toClient({ id, ok: true, changes: info.changes });
          return;
        }

        db.exec(message.sql);
        toClient({ id, ok: true, changes: 0 });
        return;
      }

      if (message.op === "close") {
        db?.close();
        db = undefined;
        toClient({ id, ok: true });
        return;
      }

      throw new Error("unknown op");
    } catch (cause) {
      toClient({ id, ok: false, error: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  workerListeners.add(onRequest);

  const clientPort: RpcPort = {
    postMessage: (message) =>
      queueMicrotask(() => workerListeners.forEach((l) => l({ data: message }))),
    addEventListener: (_type, listener) => clientListeners.add(listener),
    removeEventListener: (_type, listener) => clientListeners.delete(listener),
  };

  return { clientPort, dispose: () => db?.close() };
}

/** A port whose worker side the test scripts directly — for correlation edges and boot refusal. */
function programmableChannel(): {
  clientPort: RpcPort;
  onRequest: (handler: (request: WorkerMessage) => void) => void;
  sendToClient: (data: unknown) => void;
  listenerCount: () => number;
  wasStarted: () => boolean;
} {
  const clientListeners = new Set<Listener>();
  const handlers = new Set<(request: WorkerMessage) => void>();
  let started = false;

  const clientPort: RpcPort = {
    postMessage: (message) =>
      queueMicrotask(() => handlers.forEach((h) => h(message as WorkerMessage))),
    addEventListener: (_type, listener) => clientListeners.add(listener),
    removeEventListener: (_type, listener) => clientListeners.delete(listener),
    start: () => {
      started = true;
    },
  };

  return {
    clientPort,
    onRequest: (handler) => handlers.add(handler),
    sendToClient: (data) => queueMicrotask(() => clientListeners.forEach((l) => l({ data }))),
    listenerCount: () => clientListeners.size,
    wasStarted: () => started,
  };
}

/** Let all queued microtasks (message deliveries) drain. */
const flush = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

const opts = { filename: "lesto-live.sqlite3", vfsName: "lesto-live" } as const;

describe("createWorkerSqlDatabase", () => {
  it("round-trips real SQLite over the port (exec, run, get, all)", async () => {
    const channel = sqliteBackedChannel();
    const { db, close } = await createWorkerSqlDatabase(channel.clientPort, opts);

    await db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");

    expect(
      await db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run([1, "hello"]),
    ).toEqual({
      changes: 1,
    });
    expect(
      await db.prepare("INSERT INTO notes (id, body) VALUES (?, ?)").run([2, "world"]),
    ).toEqual({
      changes: 1,
    });
    expect(await db.prepare("SELECT body FROM notes WHERE id = ?").get([1])).toEqual({
      body: "hello",
    });
    expect(await db.prepare("SELECT body FROM notes ORDER BY id").all([])).toEqual([
      { body: "hello" },
      { body: "world" },
    ]);

    close();
    channel.dispose();
  });

  it("runs a FIFO transaction over the port (BEGIN/COMMIT via the string exec form)", async () => {
    const channel = sqliteBackedChannel();
    const { db } = await createWorkerSqlDatabase(channel.clientPort, opts);

    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await db.transaction(async (tx) => {
      await tx.prepare("INSERT INTO t (id) VALUES (?)").run([1]);
      await tx.prepare("INSERT INTO t (id) VALUES (?)").run([2]);
    });

    expect(await db.prepare("SELECT COUNT(*) AS n FROM t").get([])).toEqual({ n: 2 });
    channel.dispose();
  });

  it("rejects with the worker's error message on a failing statement", async () => {
    const channel = sqliteBackedChannel();
    const { db } = await createWorkerSqlDatabase(channel.clientPort, opts);

    await expect(db.prepare("SELECT * FROM missing").all([])).rejects.toThrow(/no such table/i);
    channel.dispose();
  });

  it("rejects the open when the worker refuses to boot (missing peer / no OPFS)", async () => {
    const channel = programmableChannel();

    channel.onRequest((request) => {
      if (request.op === "open")
        channel.sendToClient({ id: request.id, ok: false, error: "peer missing" });
    });

    await expect(createWorkerSqlDatabase(channel.clientPort, opts)).rejects.toThrow("peer missing");
    expect(channel.wasStarted()).toBe(true); // a MessagePort-shaped port is start()ed
  });

  it("ignores stray/malformed replies and falls back for absent fields", async () => {
    const channel = programmableChannel();

    channel.onRequest((request) => {
      if (request.op === "open") {
        channel.sendToClient({ id: request.id, ok: true });
        return;
      }

      if (request.op !== "exec") return;

      const sql = request.sql ?? "";

      if (sql.includes("RUN_NODELTA"))
        channel.sendToClient({ id: request.id, ok: true }); // no `changes`
      else if (sql.includes("GET_NONE"))
        channel.sendToClient({ id: request.id, ok: true }); // no `rows`
      else if (sql.includes("ALL_NONE"))
        channel.sendToClient({ id: request.id, ok: true }); // no `rows`
      else if (sql.includes("ERR_NOMSG"))
        channel.sendToClient({ id: request.id, ok: false }); // no `error`
      else channel.sendToClient({ id: request.id, ok: true, rows: [{ v: 1 }] });
    });

    const { db } = await createWorkerSqlDatabase(channel.clientPort, opts);

    // Strays the correlation loop must survive without throwing: a non-object, null, a reply with
    // no numeric id, and a reply for an id that is not pending.
    channel.sendToClient(42);
    channel.sendToClient(null);
    channel.sendToClient({ ok: true });
    channel.sendToClient({ id: 999_999, ok: true });
    await flush();

    expect(await db.prepare("RUN_NODELTA").run([])).toEqual({ changes: 0 });
    expect(await db.prepare("GET_NONE").get([])).toBeUndefined();
    expect(await db.prepare("ALL_NONE").all([])).toEqual([]);
    await expect(db.prepare("ERR_NOMSG").run([])).rejects.toThrow("OPFS worker request failed");

    // …and the client is still healthy after all of that.
    expect(await db.prepare("SELECT").all([])).toEqual([{ v: 1 }]);
  });

  it("close() sends a close op and stops listening", async () => {
    const channel = programmableChannel();
    const closes: number[] = [];

    channel.onRequest((request) => {
      if (request.op === "open") channel.sendToClient({ id: request.id, ok: true });
      if (request.op === "close" && typeof request.id === "number") closes.push(request.id);
    });

    const { close } = await createWorkerSqlDatabase(channel.clientPort, opts);
    const before = channel.listenerCount();

    close();
    await flush();

    expect(closes).toHaveLength(1);
    expect(channel.listenerCount()).toBe(before - 1);
  });
});
