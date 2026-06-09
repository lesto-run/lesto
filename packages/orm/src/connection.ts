import { OrmError } from "./errors";

import type { SqlDatabase } from "./types";

/**
 * The active connection.
 *
 * ActiveRecord is, by design, global-connection: models talk to whichever
 * database the app booted with. `useDatabase` sets it; tests reset it.
 */

let active: SqlDatabase | undefined;

export function useDatabase(db: SqlDatabase): void {
  active = db;
}

export function database(): SqlDatabase {
  if (!active) {
    throw new OrmError("ORM_NO_CONNECTION", "No database connection — call useDatabase(db) first.");
  }

  return active;
}

export function resetConnection(): void {
  active = undefined;
}
