/**
 * The concrete OPFS-SQLite engine for the durable client store (ADR 0042 Tier 4, v1 Inc5).
 *
 * {@link createSqliteLiveStore} speaks the abstract async {@link SqlDatabase} seam; this file is
 * the one place that binds it to a real browser SQLite — `@sqlite.org/sqlite-wasm` over the
 * Origin Private File System via its **SyncAccessHandle Pool VFS** (`installOpfsSAHPoolVfs`),
 * which — unlike the Worker-only `OpfsDb` — runs on the main thread with no COOP/COEP headers,
 * the pit-of-success default for an app just opting into durable sync.
 *
 * It is **coverage-excluded, browser-only wiring** — the same category as `@lesto/runtime`'s
 * `sqlite-drivers.ts` and `bin.ts`: it cannot run under Node/vitest (no OPFS, no WASM worker),
 * so the logic that decides anything lives in the tested {@link createSqliteLiveStore} and the
 * `SqlDatabase`-shaped adapters, while this file only constructs and shims the engine. Everything
 * that matters — the atomic rows+cursor transaction — is exercised there against a real SQLite.
 *
 * `@sqlite.org/sqlite-wasm` is an **optional peer dependency**: only an app that opts into the
 * durable store installs it. Its surface is declared with the local interfaces below (not pulled
 * from the package's own types, which a `@lesto/live` consumer need not have installed), and it is
 * reached through a dynamic `import` whose specifier is typed as a bare `string` — so a downstream
 * `tsc` does not try to resolve the optional peer. NOTE: a `const: string` specifier can also
 * defeat a *bundler*'s static analysis (esbuild/Rollup/Vite may not pre-wire `import(variable)`);
 * an app that opts in may need `optimizeDeps.exclude`/a `@vite-ignore`-style hint. This is
 * browser-only wiring with no example consumer yet — the round-trip must be proven in the Inc6
 * gallery example (tracked) before it is relied on.
 */

import { LestoError } from "@lesto/errors";
import type { SqlDatabase, SqlStatement } from "@lesto/db";

// ── The minimal `@sqlite.org/sqlite-wasm` oo1 surface this driver drives (the real module is far
// larger). Declared locally so the package stays an OPTIONAL peer — typecheck never requires it.

/** The options form of the oo1 `exec` — the only form this driver uses for bound statements. */
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

/** A booted OPFS-SQLite handle, plus the call that releases it. */
export interface OpenOpfsSqlite {
  /** The async SQL surface {@link createSqliteLiveStore} consumes. */
  readonly db: SqlDatabase;

  /** Close the underlying connection. */
  readonly close: () => void;
}

/** Options for {@link openOpfsSqliteDatabase}. */
export interface OpenOpfsSqliteOptions {
  /** The database filename inside the VFS pool. Defaults to `lesto-live.sqlite3`. */
  readonly filename?: string;

  /** The SAHPool VFS name — bump it to isolate pools. Defaults to `lesto-live`. */
  readonly vfsName?: string;
}

/** Raised when OPFS-SQLite cannot be booted (peer dep missing, or OPFS unsupported). */
export class OpfsSqliteError extends LestoError<"LIVE_OPFS_UNAVAILABLE"> {
  constructor(message: string, details?: Record<string, unknown>) {
    super("LIVE_OPFS_UNAVAILABLE", message, details);

    this.name = "OpfsSqliteError";
  }
}

// The optional peer's specifier, typed as a bare `string` so `tsc` will not resolve it at
// type-check time (no error for a consumer that has not installed it). Caveat: this can also hide
// the specifier from a bundler's static analysis — an opting-in app may need to exclude/ignore it
// (see the module doc); to be proven in the Inc6 example.
const SQLITE_WASM_MODULE: string = "@sqlite.org/sqlite-wasm";

/**
 * Open the durable OPFS-SQLite database for the client store, requesting persistent storage so
 * the browser does not evict the slice under pressure. Dynamically imports the optional
 * `@sqlite.org/sqlite-wasm` peer; a clear {@link OpfsSqliteError} names the remedy when it (or
 * OPFS itself) is unavailable. Hand the returned `db` to {@link createSqliteLiveStore}.
 */
export async function openOpfsSqliteDatabase(
  options: OpenOpfsSqliteOptions = {},
): Promise<OpenOpfsSqlite> {
  const filename = options.filename ?? "lesto-live.sqlite3";
  const vfsName = options.vfsName ?? "lesto-live";

  let raw: OoDatabase;

  try {
    const module = (await import(SQLITE_WASM_MODULE)) as { default: Sqlite3InitModule };
    const sqlite3 = await module.default();
    const pool = await sqlite3.installOpfsSAHPoolVfs({ name: vfsName });

    raw = new pool.OpfsSAHPoolDb(filename);
  } catch (cause) {
    throw new OpfsSqliteError(
      "Could not open OPFS-SQLite. Install the optional peer `@sqlite.org/sqlite-wasm`, and " +
        "run in a browser context that supports the Origin Private File System.",
      { cause },
    );
  }

  // Best-effort durable storage — a rejection or an absent API must not fail the open.
  await navigator.storage?.persist?.().catch(() => false);

  return { db: adapt(raw), close: () => raw.close() };
}

/** The empty settle handler for the transaction FIFO — a rolled-back span needs no follow-up. */
const noop = (): void => {};

/**
 * Adapt a synchronous oo1 handle to the async {@link SqlDatabase} seam. The terminals return
 * resolved promises (SQLite is in-process, so there is no real latency) and `transaction` runs a
 * manual `BEGIN…COMMIT/ROLLBACK` span over the one connection, FIFO-serialized so an async
 * callback cannot interleave a second `BEGIN` — the shape `@lesto/runtime`'s `openSqlite` uses.
 */
function adapt(raw: OoDatabase): SqlDatabase {
  const statements: Pick<SqlDatabase, "exec" | "prepare"> = {
    exec: async (sql) => {
      raw.exec(sql);
    },

    prepare: (sql): SqlStatement => ({
      run: async (params = []) => {
        raw.exec({ sql, bind: params });

        return { changes: raw.changes() };
      },
      get: async (params = []) => {
        const resultRows: unknown[] = [];

        raw.exec({ sql, bind: params, rowMode: "object", resultRows });

        return resultRows[0];
      },
      all: async (params = []) => {
        const resultRows: unknown[] = [];

        raw.exec({ sql, bind: params, rowMode: "object", resultRows });

        return resultRows;
      },
    }),
  };

  let chain: Promise<unknown> = Promise.resolve();

  const db: SqlDatabase = {
    ...statements,

    transaction: async <T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        raw.exec("BEGIN");

        try {
          const tx: SqlDatabase = { ...statements, transaction: (inner) => inner(tx) };
          const out = await fn(tx);

          raw.exec("COMMIT");

          return out;
        } catch (error) {
          try {
            raw.exec("ROLLBACK");
          } catch {
            // Best-effort: a failed rollback must not mask the original error.
          }

          throw error;
        }
      });

      chain = run.then(noop, noop);

      return run;
    },
  };

  return db;
}
