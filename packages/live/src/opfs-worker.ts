/**
 * The dedicated Worker that hosts the OPFS-SQLite engine (ADR 0042 Tier 4, v1 Inc9).
 *
 * `@sqlite.org/sqlite-wasm`'s SAHPool VFS (`installOpfsSAHPoolVfs`) requires
 * `FileSystemFileHandle.prototype.createSyncAccessHandle`, which is `[Exposed=DedicatedWorker]` — it
 * exists ONLY inside a dedicated Worker, in Chrome and Safari alike. Booting it on the main thread
 * (the pre-Inc9 mistake) failed with "Missing required OPFS APIs." in every browser. So the engine
 * runs here, and the main thread drives it over `postMessage` via {@link ./opfs-rpc.ts}.
 *
 * The **literal** `import("@sqlite.org/sqlite-wasm")` lives in THIS module (loaded through the opt-in
 * `@lesto/live/opfs` subpath's `new Worker(new URL("./opfs-worker.ts", import.meta.url))`), so a
 * bundler statically wires the ~1.1 MB peer into the worker chunk — the same requirement the Inc6
 * finding (L-4ed8e591) established, now satisfied from inside the worker rather than the main thread.
 *
 * This is browser-only wiring and coverage-excluded (no OPFS/WASM worker under Node/vitest); the
 * request-correlation logic that decides anything is the tested {@link ./opfs-rpc.ts}.
 */

// Every `postMessage` here is a dedicated-worker `self.postMessage`, whose signature is a message
// (+ optional transfer list) — no `targetOrigin` argument exists (that belongs to
// `window.postMessage`). The unicorn rule cannot tell the two APIs apart, so disable it file-wide.
// oxlint-disable unicorn/require-post-message-target-origin

// ── The minimal `@sqlite.org/sqlite-wasm` oo1 surface this engine drives (the real module is far
// larger). Declared locally so the package keeps sqlite-wasm an OPTIONAL peer — see `opfs-sqlite.ts`.

/** The options form of the oo1 `exec` — the only form this engine uses for bound statements. */
interface OoExecOptions {
  readonly sql: string;
  readonly bind?: readonly unknown[];
  readonly rowMode?: "object" | "array";
  readonly resultRows?: unknown[];
}

/** A `@sqlite.org/sqlite-wasm` oo1 database handle (the SAHPool variant). */
interface OoDatabase {
  exec(sqlOrOptions: string | OoExecOptions): unknown;
  changes(): number;
  close(): void;
}

/** The SAHPool VFS utility returned by `installOpfsSAHPoolVfs` — its DB constructor is all we need. */
interface OoSAHPoolUtil {
  OpfsSAHPoolDb: new (filename: string) => OoDatabase;
}

/** The initialized `sqlite3` namespace — the SAHPool installer is all we touch. */
interface Sqlite3Static {
  installOpfsSAHPoolVfs(options?: { name?: string; directory?: string }): Promise<OoSAHPoolUtil>;
}

/** The module's default export — `sqlite3InitModule`. */
type Sqlite3InitModule = () => Promise<Sqlite3Static>;

/** The dedicated-worker global surface this module uses (the `WebWorker` lib is not in this tsconfig). */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

const ctx = self as unknown as WorkerScope;

/** The one open engine handle for this worker's lifetime (a worker owns exactly one durable store). */
let db: OoDatabase | undefined;

ctx.addEventListener("message", (event) => {
  void handleMessage(event.data);
});

/**
 * Dispatch one main-thread request. Every reply echoes the request `id` so the client can correlate;
 * any throw becomes `{ ok: false, error }` rather than an unhandled rejection, so a boot failure (a
 * missing peer, an OPFS-less context) surfaces as a rejected `open` on the main thread.
 */
async function handleMessage(raw: unknown): Promise<void> {
  const message = raw as {
    readonly id?: number;
    readonly op?: string;
    readonly filename?: string;
    readonly vfsName?: string;
    readonly sql?: string;
    readonly bind?: readonly unknown[];
    readonly wantRows?: boolean;
  };

  const { id } = message;

  if (typeof id !== "number") return;

  try {
    switch (message.op) {
      case "open": {
        const module = (await import("@sqlite.org/sqlite-wasm")) as unknown as {
          default: Sqlite3InitModule;
        };
        const sqlite3 = await module.default();
        // Omit `name` when absent rather than pass `undefined` (exactOptionalPropertyTypes).
        const pool = await sqlite3.installOpfsSAHPoolVfs(
          message.vfsName === undefined ? {} : { name: message.vfsName },
        );

        db = new pool.OpfsSAHPoolDb(message.filename ?? "lesto-live.sqlite3");
        ctx.postMessage({ id, ok: true });

        return;
      }

      case "exec": {
        if (db === undefined) throw new Error("OPFS worker received exec before open");
        if (typeof message.sql !== "string") throw new Error("OPFS worker exec missing sql");

        if (message.wantRows === true) {
          const resultRows: unknown[] = [];
          // Include `bind` only when present (exactOptionalPropertyTypes); `get`/`all` always send it.
          const query: OoExecOptions =
            message.bind === undefined
              ? { sql: message.sql, rowMode: "object", resultRows }
              : { sql: message.sql, bind: message.bind, rowMode: "object", resultRows };

          db.exec(query);
          ctx.postMessage({ id, ok: true, rows: resultRows });

          return;
        }

        // Mirror the oo1 shim exactly: the bound form for a parameterized statement, the plain
        // string form for schema / `BEGIN`…`COMMIT` (the client ignores `changes` for those).
        if (message.bind === undefined) db.exec(message.sql);
        else db.exec({ sql: message.sql, bind: message.bind });

        ctx.postMessage({ id, ok: true, changes: db.changes() });

        return;
      }

      case "close": {
        db?.close();
        db = undefined;
        ctx.postMessage({ id, ok: true });
        ctx.close();

        return;
      }

      default:
        throw new Error(`OPFS worker received unknown op: ${String(message.op)}`);
    }
  } catch (cause) {
    ctx.postMessage({
      id,
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
