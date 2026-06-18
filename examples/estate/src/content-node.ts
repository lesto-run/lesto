/**
 * The Node/Bun content store — portable filesystem SQLite via `openSqlite`.
 *
 * Kept in its OWN module (apart from `content.tsx`) on purpose: `openSqlite`
 * pulls in better-sqlite3 / `bun:sqlite`, neither of which a Cloudflare Worker
 * can load. `content.tsx` (imported by the Worker via `edge.ts`) therefore stays
 * free of this import; only the Node app (`controllers.ts`) reaches for it.
 */

import { createDb } from "@lesto/db";
import { openSqlite } from "@lesto/runtime";

import { makeContentStore } from "./content";
import type { ContentStore } from "./content";

/** A content store over portable SQLite — the server/`bun run` backend. */
export function nodeContentStore(): ContentStore {
  return makeContentStore(async () => {
    const { db: handle } = await openSqlite(":memory:");

    return { handle, db: createDb(handle) };
  });
}
