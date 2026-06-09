import { setData } from "@keel/content-core";
import type { SqlDatabase } from "@keel/migrate";

import { loadEntries } from "./load";

/**
 * Load every content entry from the database into content-core's runtime store.
 *
 * After this call, content-core's `getCollection`, `getEntry`, and `query` read
 * from the database-backed data — the same runtime API, now on the SQL
 * substrate instead of generated files. Call it once at boot.
 */
export function hydrateRuntime(db: SqlDatabase): void {
  setData(loadEntries(db));
}
