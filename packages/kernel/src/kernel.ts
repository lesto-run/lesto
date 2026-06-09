/**
 * The application kernel: it assembles a Keel app from its parts.
 *
 * Everything a Keel app is made of meets here — the database, the migrations
 * that shape it, the router that maps requests, and the controllers that answer
 * them. The kernel wires them together into one bootable `App` and is the single
 * place that knows the assembly order: connect the ORM, run pending migrations,
 * then stand up the web dispatch core.
 *
 * It is deliberately transport-free. The node:http listener and the CLI are thin
 * adapters that feed an `App` and write its responses back; they live elsewhere.
 * What lives here is the pure, fully-coverable assembly + delegation.
 */

import { useDatabase } from "@keel/orm";

import { Migrator } from "@keel/migrate";
import type { MigrationEntry } from "@keel/migrate";

import type { Router } from "@keel/router";

import { Application } from "@keel/web";
import type { ControllerClass, KeelResponse } from "@keel/web";

/**
 * The one database handle the kernel threads through everything.
 *
 * It is the union of what its consumers need: `@keel/orm` prepares statements and
 * binds array-positional params; `@keel/migrate` also runs raw `exec` DDL. A
 * single better-sqlite3 (or Postgres) adapter satisfies the whole surface, so the
 * kernel hands the same handle to both without either knowing the driver.
 */
export interface KernelDatabase {
  exec(sql: string): unknown;

  prepare(sql: string): {
    run(params?: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(params?: unknown[]): unknown;
    all(params?: unknown[]): unknown[];
  };
}

/** Everything needed to assemble an app: its database, routes, controllers, and migrations. */
export interface AppConfig {
  db: KernelDatabase;

  router: Router;

  /** Controllers keyed by the name used in route targets (`"posts"` in `"posts#index"`). */
  controllers: Record<string, ControllerClass>;

  /** Schema migrations to bring the database up to date on boot. Absent means none. */
  migrations?: MigrationEntry[];
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
 * The order is the contract: point the ORM at the database first, then bring the
 * schema up to date, then stand up dispatch over the now-ready database — so a
 * controller's first query hits a migrated schema, not an empty one.
 */
export function createApp(config: AppConfig): App {
  // Connect the ORM: every Model from here on talks to this database.
  useDatabase(config.db);

  // Run pending migrations up front so the schema is ready before any request.
  // No migrations configured means nothing ran — an empty applied list.
  const migrationsApplied: readonly string[] =
    config.migrations === undefined ? [] : new Migrator(config.db, config.migrations).migrate();

  // The web core owns request dispatch; the kernel only hands it its parts.
  const application = new Application({
    router: config.router,
    controllers: config.controllers,
  });

  return {
    migrationsApplied,

    handle: (method, path, options) => application.handle(method, path, options),
  };
}
