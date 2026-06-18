import type { RuntimeEntry } from "@volo/content-core";
import type { SqlDatabase } from "@volo/migrate";

import { ContentStoreError } from "./errors";
import { loadEntry } from "./load";
import { CONTENT_ENTRIES_TABLE } from "./migration";
import { persistEntries, type PersistOptions } from "./persist";

/** The loose, authoring-shaped input a write tool hands the store. */
export interface WriteEntryInput {
  readonly collection: string;
  readonly slug: string;
  /** Open-ended frontmatter. Merged over the existing entry on update. */
  readonly data?: Record<string, unknown>;
  /** The body. Replaces the existing body on update when given. */
  readonly content?: string;
}

/** What a single-entry write produced — the entry as it now lives in the store. */
export interface WriteEntryResult {
  readonly entry: RuntimeEntry;
}

/** What a delete did — how many rows it removed (0 when nothing matched). */
export interface DeleteEntryResult {
  readonly deleted: number;
}

/**
 * Materialize a new entry from loose authoring input.
 *
 * Entries created through the store have no file on disk, so their metadata is
 * synthesized from the collection and slug — a virtual path that keeps the
 * entry's shape identical to one the pipeline would have produced.
 */
function buildEntry(input: WriteEntryInput): RuntimeEntry {
  return {
    // Frontmatter first; identity is pinned after it, so `data` can never
    // override the entry's id, collection, slug, or file metadata.
    ...input.data,
    id: input.slug,
    collection: input.collection,
    slug: input.slug,
    file: {
      path: `${input.collection}/${input.slug}.md`,
      fileName: `${input.slug.replace(/.*\//, "")}.md`,
      extension: ".md",
      directory: input.collection,
      pathSegments: input.slug.split("/"),
      isIndex: false,
    },
    ...(input.content === undefined ? {} : { content: input.content }),
  };
}

/**
 * Create a new entry, failing if one already lives at `(collection, slug)`.
 *
 * Create is deliberately not an upsert: an agent that means to add content
 * should hear about a collision rather than silently overwrite.
 */
export async function createEntry(
  db: SqlDatabase,
  input: WriteEntryInput,
  options?: PersistOptions,
): Promise<WriteEntryResult> {
  if ((await loadEntry(db, input.collection, input.slug)) !== undefined) {
    throw new ContentStoreError(
      "CONTENT_STORE_ENTRY_EXISTS",
      `An entry "${input.slug}" already exists in collection "${input.collection}".`,
      { collection: input.collection, slug: input.slug },
    );
  }

  const entry = buildEntry(input);

  await persistEntries(db, [entry], options);

  return { entry };
}

/**
 * Update an existing entry, failing if it is not there.
 *
 * `data` is merged over the entry's current fields; `content` replaces the body
 * when given. Identity (`id`, `collection`, `file`) is held fixed — an update
 * cannot move an entry, only change what it holds.
 */
export async function updateEntry(
  db: SqlDatabase,
  input: WriteEntryInput,
  options?: PersistOptions,
): Promise<WriteEntryResult> {
  const existing = await loadEntry(db, input.collection, input.slug);

  if (existing === undefined) {
    throw new ContentStoreError(
      "CONTENT_STORE_ENTRY_NOT_FOUND",
      `No entry "${input.slug}" exists in collection "${input.collection}".`,
      { collection: input.collection, slug: input.slug },
    );
  }

  const entry: RuntimeEntry = {
    ...existing,
    ...input.data,
    ...(input.content === undefined ? {} : { content: input.content }),
    id: existing.id,
    collection: existing.collection,
    file: existing.file,
  };

  await persistEntries(db, [entry], options);

  return { entry };
}

/** Remove an entry by its identity. Removing nothing is success, not an error. */
export async function deleteEntry(
  db: SqlDatabase,
  collection: string,
  id: string,
): Promise<DeleteEntryResult> {
  const sql = `DELETE FROM ${CONTENT_ENTRIES_TABLE} WHERE collection = ? AND entry_id = ?`;
  const result = await db.prepare(sql).run([collection, id]);

  return { deleted: result.changes };
}

/** The identity columns a prune reads to find what to drop. */
interface IdentityRow {
  readonly collection: string;
  readonly entry_id: string;
}

/** A null byte cannot appear in a collection or id, so it is a safe separator. */
function identityKey(collection: string, id: string): string {
  return `${collection}\u0000${id}`;
}

/**
 * Delete every stored entry whose identity is not in `keep`.
 *
 * This is the pruning half of a full build: after a fresh pipeline run, rows for
 * source that no longer exists are removed so the database mirrors the build
 * exactly. It loads only identities (not documents) and deletes the difference.
 */
export async function pruneEntries(
  db: SqlDatabase,
  keep: readonly RuntimeEntry[],
): Promise<DeleteEntryResult> {
  const kept = new Set(keep.map((entry) => identityKey(entry.collection, entry.id)));

  const rows = (await db
    .prepare(`SELECT collection, entry_id FROM ${CONTENT_ENTRIES_TABLE}`)
    .all()) as IdentityRow[];

  const statement = db.prepare(
    `DELETE FROM ${CONTENT_ENTRIES_TABLE} WHERE collection = ? AND entry_id = ?`,
  );

  let deleted = 0;

  for (const row of rows) {
    if (!kept.has(identityKey(row.collection, row.entry_id))) {
      await statement.run([row.collection, row.entry_id]);
      deleted += 1;
    }
  }

  return { deleted };
}
