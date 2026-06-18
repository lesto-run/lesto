import type { RuntimeEntry } from "@lesto/content-core";
import type { SqlDatabase } from "@lesto/migrate";

import { ContentStoreError } from "./errors";
import { CONTENT_ENTRIES_TABLE } from "./migration";

/** The two columns a load reads back: the collection, and the entry itself. */
interface ContentRow {
  readonly collection: string;
  readonly document: string;
}

/**
 * Read content entries back out of the database, grouped by collection.
 *
 * With no `collection`, every collection is returned — the exact shape
 * {@link https://npmjs.com/package/@lesto/content-core | content-core}'s
 * `setData` expects. Pass a collection to read just that one.
 */
export async function loadEntries(
  db: SqlDatabase,
  collection?: string,
): Promise<Record<string, RuntimeEntry[]>> {
  const sql =
    collection === undefined
      ? `SELECT collection, document FROM ${CONTENT_ENTRIES_TABLE} ORDER BY collection, slug`
      : `SELECT collection, document FROM ${CONTENT_ENTRIES_TABLE} WHERE collection = ? ORDER BY slug`;

  const params = collection === undefined ? [] : [collection];
  const rows = (await db.prepare(sql).all(params)) as ContentRow[];

  const collections: Record<string, RuntimeEntry[]> = {};

  for (const row of rows) {
    const entry = parseDocument(row.document, row.collection);

    (collections[row.collection] ??= []).push(entry);
  }

  return collections;
}

/**
 * Read a single entry by its identity, or `undefined` when it is not there.
 *
 * The companion to {@link loadEntries} for the write path: create checks this is
 * empty before inserting, update checks it is present before merging.
 */
export async function loadEntry(
  db: SqlDatabase,
  collection: string,
  id: string,
): Promise<RuntimeEntry | undefined> {
  const sql = `SELECT collection, document FROM ${CONTENT_ENTRIES_TABLE} WHERE collection = ? AND entry_id = ?`;
  const rows = (await db.prepare(sql).all([collection, id])) as ContentRow[];

  const row = rows[0];

  return row === undefined ? undefined : parseDocument(row.document, row.collection);
}

/** Turn a stored `document` column back into an entry, or fail loudly. */
function parseDocument(document: string, collection: string): RuntimeEntry {
  try {
    return JSON.parse(document) as RuntimeEntry;
  } catch (cause) {
    throw new ContentStoreError(
      "CONTENT_STORE_CORRUPT_DOCUMENT",
      `A stored content document for collection "${collection}" could not be parsed.`,
      { collection, cause },
    );
  }
}
