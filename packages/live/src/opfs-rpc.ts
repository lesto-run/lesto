/**
 * The main-thread RPC client for the OPFS-SQLite Worker (ADR 0042 Tier 4, v1 Inc9).
 *
 * OPFS `SyncAccessHandle`s — which `@sqlite.org/sqlite-wasm`'s SAHPool VFS requires — are
 * `[Exposed=DedicatedWorker]`: they exist only inside a dedicated Worker, never on the main thread
 * (true of Chrome AND Safari). So the real SQLite engine lives in {@link ./opfs-worker.ts}, and this
 * module is the main-thread half that talks to it: it turns the async {@link SqlDatabase} seam
 * {@link createSqliteLiveStore} consumes into request-id-correlated `postMessage` round-trips.
 *
 * The mapping is 1:1 with the oo1 shim it replaces — a statement handle never crosses the port; each
 * `exec`/`run`/`get`/`all` is one stateless `{ sql, bind }` message, exactly as the previous
 * synchronous adapter re-exec'd per call. Order is preserved by construction: the worker executes
 * messages in arrival order, and `@lesto/db`'s {@link adaptSyncSqlite} FIFO-serializes the
 * `BEGIN…COMMIT` transaction span on this side, so an async callback cannot interleave a second
 * `BEGIN`. This file is deliberately transport-only (a {@link RpcPort}, not a `Worker`) so it is unit
 * tested against a fake port pair; the un-coverable browser wiring is confined to `opfs-sqlite.ts`
 * (the `new Worker(...)` spawn) and `opfs-worker.ts` (the worker-side sqlite binding).
 */

import { adaptSyncSqlite } from "@lesto/db";
import type { SqlDatabase, SqlStatement } from "@lesto/db";

/**
 * The minimal message-port surface this client needs — satisfied by both a real `Worker` (wrapped in
 * `opfs-sqlite.ts`) and a `MessagePort`/fake pair (the test). Kept to `postMessage` + a `message`
 * listener so the adapter is transport-agnostic and testable without a browser.
 */
export interface RpcPort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  /** A `MessagePort` must be `start()`ed to receive; a `Worker` has no such method (hence optional). */
  start?(): void;
}

/** Client → worker. `open` boots the engine; `exec` runs one statement; `close` disposes it. */
export type WorkerRequest =
  | {
      readonly id: number;
      readonly op: "open";
      readonly filename: string;
      readonly vfsName: string;
    }
  | {
      readonly id: number;
      readonly op: "exec";
      readonly sql: string;
      readonly bind?: readonly unknown[];
      readonly wantRows?: boolean;
    }
  | { readonly id: number; readonly op: "close" };

/** Worker → client. A rejected request carries the worker-side error message (Errors don't survive a `throw` across a port cleanly). */
export type WorkerResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly rows?: readonly unknown[];
      readonly changes?: number;
    }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** `Omit` over a discriminated union, per-member — so each request body keeps its own `sql`/`filename`. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A live connection to the worker engine: the async SQL surface, plus a `close` that disposes it. */
export interface WorkerSqlConnection {
  readonly db: SqlDatabase;
  readonly close: () => void;
}

/**
 * Wrap an open {@link RpcPort} as a {@link SqlDatabase}. Sends the `open` handshake first (rejecting
 * if the worker refuses — a missing peer or an OPFS-less browser), then adapts the per-statement RPC
 * to the sync-shaped `exec`/`prepare` pair that {@link adaptSyncSqlite} lifts into the full seam.
 */
export async function createWorkerSqlDatabase(
  port: RpcPort,
  options: { readonly filename: string; readonly vfsName: string },
): Promise<WorkerSqlConnection> {
  let nextId = 1;
  let closed = false;
  const pending = new Map<
    number,
    {
      resolve: (value: Extract<WorkerResponse, { ok: true }>) => void;
      reject: (error: Error) => void;
    }
  >();

  const onMessage = (event: { data: unknown }): void => {
    const data = event.data;

    if (typeof data !== "object" || data === null) return;

    const response = data as { id?: unknown; ok?: unknown; error?: unknown };

    if (typeof response.id !== "number") return;

    const entry = pending.get(response.id);

    if (entry === undefined) return; // a stray/duplicate reply — ignore rather than crash.

    pending.delete(response.id);

    if (response.ok === true) entry.resolve(data as Extract<WorkerResponse, { ok: true }>);
    else
      entry.reject(
        new Error(
          typeof response.error === "string" ? response.error : "OPFS worker request failed",
        ),
      );
  };

  port.addEventListener("message", onMessage);
  port.start?.();

  const request = (
    body: DistributiveOmit<WorkerRequest, "id">,
  ): Promise<Extract<WorkerResponse, { ok: true }>> =>
    new Promise((resolve, reject) => {
      // Fail LOUD after close rather than hang forever: a post-close statement would otherwise
      // enqueue a promise the (terminated) worker can never answer, wedging the store's FIFO
      // transaction chain silently. The pre-Inc9 sync engine threw synchronously here.
      if (closed) {
        reject(new Error("OPFS worker connection is closed"));

        return;
      }

      const id = nextId++;

      pending.set(id, { resolve, reject });
      port.postMessage({ id, ...body });
    });

  await request({ op: "open", filename: options.filename, vfsName: options.vfsName });

  const statements: Pick<SqlDatabase, "exec" | "prepare"> = {
    exec: async (sql) => {
      await request({ op: "exec", sql });
    },

    prepare: (sql): SqlStatement => ({
      run: async (params = []) => {
        const result = await request({ op: "exec", sql, bind: params });

        return { changes: result.changes ?? 0 };
      },
      get: async (params = []) => {
        const result = await request({ op: "exec", sql, bind: params, wantRows: true });

        return (result.rows ?? [])[0];
      },
      all: async (params = []) => {
        const result = await request({ op: "exec", sql, bind: params, wantRows: true });

        return [...(result.rows ?? [])];
      },
    }),
  };

  return {
    db: adaptSyncSqlite(statements),
    close: () => {
      if (closed) return;
      closed = true;

      port.postMessage({ id: nextId++, op: "close" });
      port.removeEventListener("message", onMessage);

      // Reject anything still in flight — its reply can no longer be delivered (listener gone),
      // so without this the awaiting caller (e.g. `store.whenIdle()`) would hang forever.
      const orphaned = new Error("OPFS worker connection closed with a request in flight");

      for (const [, entry] of pending) entry.reject(orphaned);

      pending.clear();
    },
  };
}
