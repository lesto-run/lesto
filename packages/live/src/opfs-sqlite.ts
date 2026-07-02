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
 * `SqlDatabase`-shaped adapters, while this file only constructs the oo1 handle and shims its
 * synchronous `exec`/`prepare` surface. The manual `BEGIN`…`COMMIT`/`ROLLBACK` FIFO transaction
 * that surface needs is no longer duplicated (and no longer coverage-excluded) here: `adapt()`
 * hands the shimmed `exec`/`prepare` pair to `@lesto/db`'s {@link adaptSyncSqlite}, the one
 * tested copy `@lesto/runtime`'s `openSqlite` shares. Everything that matters — the atomic
 * rows+cursor transaction — is exercised there against a real SQLite, PLUS the FIFO/rollback/
 * flat-nesting invariants are now covered directly by `adaptSyncSqlite`'s own suite.
 *
 * `@sqlite.org/sqlite-wasm` is an **optional peer dependency**: only an app that opts into the
 * durable store installs it. Its surface is declared with the local interfaces below (not pulled
 * from the package's own types), and it is reached through a **literal** dynamic
 * `import("@sqlite.org/sqlite-wasm")` so a real bundler statically wires the peer into the build.
 *
 * That literal is why this engine lives behind the opt-in **`@lesto/live/opfs`** subpath and is
 * NOT re-exported from the main `@lesto/live` barrel. The split resolves a tension the Inc6
 * example (`examples/live-durable`, L-f5bffa40 → L-4ed8e591) proved is real: a NON-literal
 * specifier (a `const: string`, the earlier shape) keeps `tsc` from resolving the optional peer
 * for a peer-less consumer — but a bundler defeats it the same way, and WORSE than a warning:
 * production Rollup/Vite silently drops the import with no diagnostic, so `dist/` never gets the
 * ~1.1 MB engine and the call throws at runtime (`@vite-ignore`/`optimizeDeps.exclude` do not fix
 * the production build). A literal fixes the bundler but would re-open the `tsc` requirement — IF
 * it sat in the main barrel. Keeping it on a dedicated subpath dissolves both: a consumer
 * importing `@lesto/live` never pulls this module (or its literal) into its `tsc`/bundler graph,
 * while an app that imports `@lesto/live/opfs` has installed the peer, so the literal resolves for
 * its `tsc` AND bundles for its build. This package also declares the peer as a `devDependency`,
 * so its OWN typecheck resolves the literal without the incidental install.
 */

import { adaptSyncSqlite } from "@lesto/db";
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
    // A LITERAL specifier so a bundler statically wires the optional peer into the build (a
    // non-literal was silently dropped — the Inc6 finding, L-4ed8e591; see the module doc). Cast
    // through `unknown`: this driver binds only the minimal oo1 surface declared above, not the
    // peer's own (far larger) types.
    const module = (await import("@sqlite.org/sqlite-wasm")) as unknown as {
      default: Sqlite3InitModule;
    };
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

/**
 * Adapt a synchronous oo1 handle to the async {@link SqlDatabase} seam. The terminals return
 * resolved promises (SQLite is in-process, so there is no real latency); `transaction` (the
 * manual `BEGIN…COMMIT/ROLLBACK` span, FIFO-serialized so an async callback cannot interleave a
 * second `BEGIN`) is `@lesto/db`'s shared {@link adaptSyncSqlite} — the same tested helper
 * `@lesto/runtime`'s `openSqlite` builds its transaction on. This moves what used to be
 * coverage-excluded transaction logic into that helper's own 100%-covered suite; only the
 * oo1-specific `exec`/`prepare` shim below remains untestable browser wiring.
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

  return adaptSyncSqlite(statements);
}
