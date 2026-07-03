/**
 * The browser entry point for the durable OPFS-SQLite client store (ADR 0042 Tier 4, v1 Inc5,
 * corrected in Inc9).
 *
 * {@link createSqliteLiveStore} speaks the abstract async {@link SqlDatabase} seam; this file is the
 * one place that binds it to a real browser SQLite — `@sqlite.org/sqlite-wasm` over the Origin
 * Private File System via its **SyncAccessHandle Pool VFS** (`installOpfsSAHPoolVfs`). That VFS needs
 * `FileSystemFileHandle.prototype.createSyncAccessHandle`, which is **`[Exposed=DedicatedWorker]`** —
 * available only inside a dedicated Worker, in Chrome and Safari alike. So the engine CANNOT run on
 * the main thread (the pre-Inc9 bug: "Missing required OPFS APIs." in every browser); it runs in
 * {@link ./opfs-worker.ts}, and this module spawns that worker and hands its port to the tested RPC
 * client {@link createWorkerSqlDatabase}. SAHPool needs no COOP/COEP headers — only the worker.
 *
 * This module is browser-only wiring and coverage-excluded — the same category as `@lesto/runtime`'s
 * `sqlite-drivers.ts`: it constructs a real `Worker`, which cannot run under Node/vitest. Everything
 * that decides anything now lives in tested code: the request correlation in {@link ./opfs-rpc.ts}
 * and the atomic rows+cursor transaction in {@link createSqliteLiveStore} / `@lesto/db`'s
 * {@link adaptSyncSqlite} (the shared, 100%-covered `BEGIN…COMMIT` FIFO helper).
 *
 * `@sqlite.org/sqlite-wasm` is an **optional peer dependency**: only an app that opts into the durable
 * store installs it. It is reached through a **literal** `import("@sqlite.org/sqlite-wasm")` — but
 * that literal now lives inside `opfs-worker.ts`, loaded via `new Worker(new URL("./opfs-worker.ts",
 * import.meta.url))`, so a bundler statically wires the peer into the worker chunk. This engine lives
 * behind the opt-in **`@lesto/live/opfs`** subpath and is NOT re-exported from the `@lesto/live`
 * barrel: a consumer importing `@lesto/live` never pulls the worker (or its literal peer) into its
 * `tsc`/bundler graph, while an app importing `@lesto/live/opfs` has installed the peer, so the
 * literal resolves and bundles. The package also declares the peer as a `devDependency` so its OWN
 * typecheck resolves the literal. This split resolves the tension the Inc6 example
 * (`examples/live-durable`, L-f5bffa40 → L-4ed8e591) proved is real: a NON-literal specifier lets a
 * bundler SILENTLY drop the import (no diagnostic), so `dist/` never gets the engine and the call
 * throws at runtime; a literal on a dedicated subpath fixes the build without reopening the `tsc`
 * requirement for peer-less consumers.
 */

// The `worker.postMessage` in the port adapter below is a `Worker.postMessage`, whose signature is a
// message (+ optional transfer list) — no `targetOrigin` argument exists (that belongs to
// `window.postMessage`). The unicorn rule cannot tell the two APIs apart, so disable it file-wide.
// oxlint-disable unicorn/require-post-message-target-origin
import { LestoError } from "@lesto/errors";

import { createWorkerSqlDatabase } from "./opfs-rpc";
import type { RpcPort } from "./opfs-rpc";

import type { SqlDatabase } from "@lesto/db";

/** A booted OPFS-SQLite handle, plus the call that releases it. */
export interface OpenOpfsSqlite {
  /** The async SQL surface {@link createSqliteLiveStore} consumes. */
  readonly db: SqlDatabase;

  /** Close the underlying connection (disposes the worker's engine and terminates the worker). */
  readonly close: () => void;
}

/** Options for {@link openOpfsSqliteDatabase}. */
export interface OpenOpfsSqliteOptions {
  /** The database filename inside the VFS pool. Defaults to `lesto-live.sqlite3`. */
  readonly filename?: string;

  /** The SAHPool VFS name — bump it to isolate pools. Defaults to `lesto-live`. */
  readonly vfsName?: string;
}

/** Raised when OPFS-SQLite cannot be booted (peer dep missing, OPFS unsupported, or no Worker). */
export class OpfsSqliteError extends LestoError<"LIVE_OPFS_UNAVAILABLE"> {
  constructor(message: string, details?: Record<string, unknown>) {
    super("LIVE_OPFS_UNAVAILABLE", message, details);

    this.name = "OpfsSqliteError";
  }
}

/**
 * Open the durable OPFS-SQLite database for the client store. Spawns the dedicated engine worker,
 * completes its `open` handshake, and requests persistent storage so the browser does not evict the
 * slice under pressure. A clear {@link OpfsSqliteError} names the remedy when the worker cannot boot
 * (the optional `@sqlite.org/sqlite-wasm` peer is missing, or OPFS itself is unavailable). Hand the
 * returned `db` to {@link createSqliteLiveStore}.
 */
export async function openOpfsSqliteDatabase(
  options: OpenOpfsSqliteOptions = {},
): Promise<OpenOpfsSqlite> {
  const filename = options.filename ?? "lesto-live.sqlite3";
  const vfsName = options.vfsName ?? "lesto-live";

  let worker: Worker;

  try {
    // A statically-analyzable `new Worker(new URL(...))` so the bundler emits the worker chunk (with
    // the literal sqlite-wasm import inside it). `type: "module"` — `opfs-worker.ts` is ESM.
    worker = new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module" });
  } catch (cause) {
    throw new OpfsSqliteError(
      "Could not start the OPFS-SQLite worker. This build may not have bundled it, or Web Workers " +
        "are unavailable in this context.",
      { cause },
    );
  }

  const port: RpcPort = {
    // A `Worker` delivers a `MessageEvent` (which has `.data`); the `RpcPort` listener reads only
    // `.data`, so the cast through `unknown` is sound and keeps the same reference for removal.
    postMessage: (message) => worker.postMessage(message),
    addEventListener: (type, listener) =>
      worker.addEventListener(type, listener as unknown as EventListener),
    removeEventListener: (type, listener) =>
      worker.removeEventListener(type, listener as unknown as EventListener),
  };

  // A worker whose SCRIPT fails to load never answers a message; race the load-`error` event so the
  // `open` handshake rejects loudly instead of hanging. (A peer/OPFS failure INSIDE the worker is
  // caught there and returned as a rejected `open`, so this only backstops a hard load failure.)
  const loadFailure = new Promise<never>((_, reject) => {
    worker.addEventListener(
      "error",
      (event) => reject(new Error(event.message || "OPFS worker failed to load")),
      { once: true },
    );
  });

  try {
    const connection = await Promise.race([
      createWorkerSqlDatabase(port, { filename, vfsName }),
      loadFailure,
    ]);

    // Best-effort durable storage — a rejection or an absent API must not fail the open. `persist()`
    // is `[Exposed=Window]`, so it stays here on the main thread rather than in the worker.
    await navigator.storage?.persist?.().catch(() => false);

    return {
      db: connection.db,
      close: () => {
        connection.close();
        worker.terminate();
      },
    };
  } catch (cause) {
    worker.terminate();

    throw new OpfsSqliteError(
      "Could not open OPFS-SQLite. Install the optional peer `@sqlite.org/sqlite-wasm`, and run in a " +
        "browser that supports the Origin Private File System (its SyncAccessHandle is Worker-only).",
      { cause },
    );
  }
}
