/**
 * The application kernel: it assembles a Keel app from its parts.
 *
 * Everything a Keel app is made of meets here — the database, the migrations
 * that shape it, and the composed `keel()` app that maps and answers requests.
 * The kernel wires them together into one bootable `App` and owns the assembly
 * order: run pending migrations against the supplied database, then delegate
 * dispatch to the app.
 *
 * Handlers query the database through `@keel/db` (see ADR 0004) — they close
 * over a typed `Db` from the app's factory rather than reaching for a global.
 * The kernel itself never touches the data layer beyond handing `config.db` to
 * the migrator.
 *
 * Deliberately transport-free. The node:http listener and the CLI are thin
 * adapters that feed an `App` and write its responses back; they live
 * elsewhere. What lives here is the pure, fully-coverable assembly +
 * delegation.
 */

import type { Dialect } from "@keel/db";

import { Migrator } from "@keel/migrate";
import type { MigrationEntry } from "@keel/migrate";

import type { Keel, KeelResponse, UiDialect } from "@keel/web";

import { installDurableSchema } from "./secure-stack";

/**
 * The one database handle the kernel threads through the migrator.
 *
 * `@keel/migrate` consumes `exec` (for DDL) + `prepare` (for the bookkeeping
 * table); `@keel/db` consumes the same shape for the runtime query layer. A
 * single better-sqlite3 (or future Postgres) adapter satisfies both
 * structurally, so the kernel hands the same handle to the migrator and the
 * app wraps it in `createDb(handle)` for its controllers.
 */
export interface KernelDatabase {
  exec(sql: string): Promise<void>;

  prepare(sql: string): {
    run(params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
    get(params?: unknown[]): Promise<unknown>;
    all(params?: unknown[]): Promise<unknown[]>;
  };

  /** Run `fn` in one transaction on one connection (ADR 0006); see `@keel/db`. */
  transaction<T>(fn: (tx: KernelDatabase) => Promise<T>): Promise<T>;
}

/**
 * Everything needed to assemble an app: a composed `keel()` app, its database,
 * and migrations.
 *
 * Routes, pages, and middleware all live on the `app` — there is no separate
 * `router`/`controllers`/`middleware` to thread (ADR 0004). The kernel runs
 * migrations, then delegates dispatch straight to `app.handle`.
 */
export interface KeelAppConfig {
  db: KernelDatabase;

  app: Keel;

  /**
   * Schema migrations to bring the database up to date on boot. Absent means
   * none. Pass the literal `"skip"` for a fleet member that must NOT migrate on
   * boot — when one instance (or a separate release step) owns the migration and
   * the rest should come up against the already-migrated schema. `"skip"` runs
   * zero migrations and reports an empty applied list.
   */
  migrations?: MigrationEntry[] | "skip";

  /**
   * The SQL dialect the boot migrations render DDL for. Defaults to `"sqlite"`.
   * A Postgres deploy MUST set `"postgres"` or the migrator emits SQLite-only
   * DDL (`GENERATED ALWAYS AS IDENTITY` becomes `AUTOINCREMENT`, which Postgres
   * rejects) and skips the advisory-lock boot guard. The app wires the same
   * dialect into its own `createDb(handle, { dialect })`.
   */
  dialect?: Dialect;

  /**
   * The UI client/server dialect (ADR 0007/0008's matched pair). The single key
   * that drives BOTH the island client bundle's `react`→`preact/compat` alias
   * (read by the CLI for `keel dev`/`build`) AND the page server renderer
   * (applied to `app` here, on boot). `{ dialect: "preact" }` shrinks the island
   * runtime to ~10 KB gzip; absent (or `"react"`) keeps React streaming, the
   * default. `createApp` wires the server half; the CLI wires the client half
   * from the same value, so the two can never diverge.
   */
  ui?: { dialect: UiDialect };

  /**
   * Install the durable-store schemas (sessions + rate limits, ADR 0013) on the
   * `db` after migrate, so a SQL-backed `sqlSessionStore` / `sqlRateLimitStore`
   * has its tables ready before the first request. This is the pit-of-success
   * default: a `createApp({ db })` app gets durable, fleet-correct stores with
   * zero config — pair it with `secureStack({ db })` for limits and
   * `durableStores(db)` for the session half.
   *
   * Set `false` to opt OUT — for a deploy whose sessions/limits are deliberately
   * per-process memory, or a fleet member that defers schema installation to the
   * release step that owns the migration. The schema install is idempotent
   * (`IF NOT EXISTS`), so leaving it on is harmless even when nothing uses the
   * tables. Defaults to `true`.
   */
  durable?: boolean;
}

/** A booted application: a request handler plus the record of what migrations ran. */
export interface App {
  /** Dispatch a request through the web core, returning the controller's response. */
  handle(
    method: string,
    path: string,
    options?: { query?: Record<string, string>; headers?: Record<string, string>; body?: unknown },
  ): Promise<KeelResponse>;

  /** The migration versions applied during boot, in the order they ran. */
  readonly migrationsApplied: readonly string[];
}

/**
 * Assemble a bootable app from its parts.
 *
 * The order is the contract: bring the schema up to date *first*, then delegate
 * dispatch over the now-ready database — so a handler's first query hits a
 * migrated schema, not an empty one.
 */
export async function createApp(config: KeelAppConfig): Promise<App> {
  // Run pending migrations up front so the schema is ready before any
  // request. No migrations configured means nothing ran — empty applied list.
  // Migrations are async now (ADR 0006): await them so the schema is fully
  // applied before dispatch is stood up — a query's first hit must land on a
  // migrated schema, never a half-applied one.
  // `undefined` (no migrations configured) and `"skip"` (a fleet member that
  // defers to another instance's migrate) both run nothing — empty applied list.
  const migrationsApplied: readonly string[] =
    config.migrations === undefined || config.migrations === "skip"
      ? []
      : await new Migrator(config.db, config.migrations, {
          dialect: config.dialect ?? "sqlite",
        }).migrate();

  // Durable stores are the pit-of-success default (ADR 0013): install the
  // session + rate-limit schemas right after migrate so a SQL-backed store has
  // its tables before the first request. Idempotent (`IF NOT EXISTS`), so it is
  // safe even when nothing uses the tables; `durable: false` opts a deliberately
  // memory-store (or migration-deferring) deploy out of the install entirely.
  // A ternary (not a bare `if`) so coverage scores both arms — the install and
  // the explicit `durable: false` skip — without an un-instrumentable implicit else.
  await (config.durable === false ? Promise.resolve() : installDurableSchema(config.db));

  // The keel() app owns dispatch (routes, pages, and middleware all live on it),
  // so the kernel just delegates to app.handle once the schema is ready.
  //
  // The matched pair's SERVER half (ADR 0008) is wired elsewhere: under the CLI's
  // in-process Node/Bun runtime the page renderer is React (`react-dom/server`) —
  // the process is NOT aliased to Preact — so the server renderer stays React even
  // when `ui.dialect: "preact"` selects the Preact CLIENT bundle. That pairing is
  // sound for deferred (`ssr: false`) islands, which mount fresh on the Preact
  // client and never hydrate server markup (the scaffold's default). Full
  // server-side Preact (byte-identical `ssr: true` markup) is the estate bespoke
  // path, where the WHOLE worker process is aliased react→preact/compat at build
  // time and the app calls `.renderer(preactServerRenderer)` itself — a Preact
  // server renderer cannot consume React's `createElement` output in a React
  // process, so the CLI does not force it. The `applyUiDialect` / `.renderer()`
  // seam + the `WEB_DIALECT_MISMATCH` guard remain for that bespoke wiring; the
  // CLI drives only the client half from `ui.dialect`.
  return {
    migrationsApplied,
    handle: (method, path, options) => config.app.handle(method, path, options),
  };
}
