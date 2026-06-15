/**
 * The application kernel: it assembles a Keel app from its parts.
 *
 * Everything a Keel app is made of meets here — the database, the migrations
 * that shape it, the router that maps requests, and the controllers that
 * answer them. The kernel wires them together into one bootable `App` and
 * owns the assembly order: run pending migrations against the supplied
 * database, then stand up the web dispatch core.
 *
 * Controllers query the database through `@keel/db` (see ADR 0004) — they
 * receive a typed `Db` from the app's factory rather than reaching for a
 * global. The kernel itself never touches the data layer beyond handing
 * `config.db` to the migrator.
 *
 * Deliberately transport-free. The node:http listener and the CLI are thin
 * adapters that feed an `App` and write its responses back; they live
 * elsewhere. What lives here is the pure, fully-coverable assembly +
 * delegation.
 */

import type { Dialect } from "@keel/db";

import { Migrator } from "@keel/migrate";
import type { MigrationEntry } from "@keel/migrate";

import type { Router } from "@keel/router";

import { Application } from "@keel/web";
import type { ControllerClass, Keel, KeelResponse, Middleware } from "@keel/web";

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

/** Everything needed to assemble an app: its database, routes, controllers, and migrations. */
export interface AppConfig {
  db: KernelDatabase;

  router: Router;

  /** Controllers keyed by the name used in route targets (`"posts"` in `"posts#index"`). */
  controllers: Record<string, ControllerClass>;

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
   * rejects) and skips the `pg_advisory_lock` boot guard. The app wires the same
   * dialect into its own `createDb(handle, { dialect })`.
   */
  dialect?: Dialect;

  /**
   * Request middleware that wraps every dispatch, outermost first.
   *
   * Absent (the default) is the backward-compatibility floor: no interception,
   * behavior identical to a pipeline-free app. Mount {@link secureStack} (or
   * individual `cors`/`rateLimit`/`csrf` adapters) here to activate the security
   * batteries. Nothing is enabled implicitly — security middleware run only
   * because the app put them in this list.
   */
  middleware?: readonly Middleware[];
}

/**
 * The assembly shape for the code-first router: a composed `keel()` app, its
 * database, and migrations.
 *
 * This is the target shape (ADR 0004). Routes, pages, and middleware all live on
 * the `app` — there is no separate `router`/`controllers`/`middleware` to thread.
 * The kernel runs migrations, then delegates dispatch straight to `app.handle`.
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
   * rejects) and skips the `pg_advisory_lock` boot guard. The app wires the same
   * dialect into its own `createDb(handle, { dialect })`.
   */
  dialect?: Dialect;
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
 * The order is the contract: bring the schema up to date *first*, then stand
 * up dispatch over the now-ready database — so a controller's first query
 * hits a migrated schema, not an empty one.
 */
export async function createApp(config: AppConfig | KeelAppConfig): Promise<App> {
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

  // The code-first shape: the keel() router owns dispatch (routes, pages, and
  // middleware all live on it), so the kernel just delegates to app.handle.
  if ("app" in config) {
    return {
      migrationsApplied,
      handle: (method, path, options) => config.app.handle(method, path, options),
    };
  }

  // Legacy shape: wrap the old Application pipeline. Removed once every consumer
  // has moved to the keel() app (see ADR 0004 Phase 7).
  const application = new Application({
    router: config.router,
    controllers: config.controllers,
    ...(config.middleware !== undefined && { middleware: config.middleware }),
  });

  return {
    migrationsApplied,

    handle: (method, path, options) => application.handle(method, path, options),
  };
}
