/**
 * @keel/content-store — content on the one substrate.
 *
 * The content engine (@keel/content-core) reads markdown and produces entries.
 * This package writes those entries to the SQL database and reads them back into
 * the runtime, so content lives on the same DB as everything else in Keel —
 * SQLite locally, Postgres at scale — rather than in generated files.
 *
 *   new Migrator(db, [contentEntriesMigration]).migrate();
 *   persistEntries(db, entries);   // build time: pipeline output -> DB
 *   createEntry(db, { collection, slug, data, content });  // author into the DB
 *   hydrateRuntime(db);            // boot time: DB -> runtime queries
 */

export { ContentStoreError } from "./errors";
export type { ContentStoreErrorCode } from "./errors";

export { CONTENT_ENTRIES_TABLE, contentEntriesMigration } from "./migration";

export { persistEntries } from "./persist";
export type { PersistOptions, PersistResult } from "./persist";

export { loadEntries, loadEntry } from "./load";

export { createEntry, updateEntry, deleteEntry, pruneEntries } from "./write";
export type { WriteEntryInput, WriteEntryResult, DeleteEntryResult } from "./write";

export { hydrateRuntime } from "./hydrate";
