/**
 * The one `notes` table + its `live()` shape — imported by BOTH the server (`../serve.ts` via
 * `app.ts`, to create the table and run the shape engine) and the client (`main.ts`, to open
 * the durable store). `defineTable`'s value is plain metadata (column names/types), so pulling
 * it into the client bundle drags in no server/database runtime — the same "one schema, one
 * query language, two runtimes" pitch `@lesto/live`'s `live()` builder makes (see
 * `packages/live/src/builder.ts`).
 */

import { boolean, defineTable, integer, text, timestamp } from "@lesto/db";
import type { ShapeDefinition } from "@lesto/live-protocol";

/** The `notes` table — a single, un-tenanted list (this example has no auth). */
export const notes = defineTable("notes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  text: text("text").notNull(),
  done: boolean("done").notNull().default(false),
  createdAt: timestamp("created_at").notNull(),
});

/**
 * The bound shape the client syncs: every column, in creation order. No `where` (the whole
 * table is the one shared list) and no auth — this example's whole point is the durable OPFS
 * store + bundler wiring, not authorization (see `examples/live` for the auth-scoped version).
 */
export const notesShape: ShapeDefinition = {
  table: "notes",
  key: "id",
  columns: ["id", "text", "done", "createdAt"],
  where: [],
  orderBy: { column: "createdAt", direction: "asc" },
};
