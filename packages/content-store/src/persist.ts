import type { RuntimeEntry } from "@volo/content-core";
import type { SqlDatabase } from "@volo/migrate";

import { ContentStoreError } from "./errors";
import { CONTENT_ENTRIES_TABLE } from "./migration";

/** Knobs for {@link persistEntries}. The clock is injected so tests are exact. */
export interface PersistOptions {
  /** Current epoch milliseconds (system time). Defaults to the system clock. */
  readonly now?: () => number;
}

/** What a persist run did: how many entries were written (inserted or updated). */
export interface PersistResult {
  readonly persisted: number;
}

// Upsert on the entry's identity. An entry seen again updates in place; its
// original `created_at` is never overwritten because it is absent from the SET.
const UPSERT_SQL = `
INSERT INTO ${CONTENT_ENTRIES_TABLE}
  (collection, entry_id, slug, status, published_at, document, created_at, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (collection, entry_id) DO UPDATE SET
  slug = excluded.slug,
  status = excluded.status,
  published_at = excluded.published_at,
  document = excluded.document,
  updated_at = excluded.updated_at
`;

/** Read a key off an entry only when it carries a string there. */
function readString(entry: RuntimeEntry, key: string): string | null {
  const value = entry[key];

  return typeof value === "string" ? value : null;
}

/**
 * Write content entries to the database, upserting on `(collection, entry_id)`.
 *
 * The whole entry is serialized into the `document` column; `slug`, `status`,
 * and the publish date are lifted out for indexing. Re-persisting the same
 * entry updates it in place — the operation is idempotent on identity.
 */
export async function persistEntries(
  db: SqlDatabase,
  entries: readonly RuntimeEntry[],
  options: PersistOptions = {},
): Promise<PersistResult> {
  const now = options.now ?? Date.now;
  const statement = db.prepare(UPSERT_SQL);

  let persisted = 0;

  for (const entry of entries) {
    if (entry.id === "" || entry.collection === "") {
      throw new ContentStoreError(
        "CONTENT_STORE_INVALID_ENTRY",
        "A content entry needs a non-empty id and collection to be persisted.",
        { id: entry.id, collection: entry.collection },
      );
    }

    const slug = readString(entry, "slug") ?? entry.id;
    const status = readString(entry, "status");
    const publishedAt = readString(entry, "publishedAt") ?? readString(entry, "date");
    const timestamp = new Date(now()).toISOString();

    await statement.run([
      entry.collection,
      entry.id,
      slug,
      status,
      publishedAt,
      JSON.stringify(entry),
      timestamp,
      timestamp,
    ]);

    persisted += 1;
  }

  return { persisted };
}
