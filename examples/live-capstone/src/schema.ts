/**
 * The one `messages` table + its bound `live()` shape — the ADR 0042 Tier-4 v1 capstone schema
 * (Inc8, `L-b1501de9`). Imported by BOTH runtimes: the server (`app.ts` → the shape engine + the
 * mutation) and the client (`main.ts` → the durable store + the outbox). `defineTable`'s value is
 * plain metadata (column names/types), so pulling it into the client bundle drags in no
 * server/database runtime — the "one schema, one query language, two runtimes" pitch `live()` makes.
 *
 * Two properties this schema is deliberately shaped for, each load-bearing for the acceptance matrix:
 *
 *   - **`id` is a CLIENT-generated uuid, not a server serial** (the Inc6 correlation linchpin): an
 *     optimistic offline write and the server's later authoritative echo (over the replication
 *     stream) share ONE key, so the echo settles under the optimistic row rather than duplicating it.
 *     A TEXT client id also sidesteps the serial-vs-autoincrement DDL fork between SQLite and Postgres
 *     — the same schema renders on both dialects.
 *   - **`room_id` is the tenancy filter, a NON-primary-key column.** The shape filters on it, so
 *     detecting that a row moved OUT of a shape (a reassigned `room_id`) needs the row's OLD image —
 *     which Postgres emits only under `REPLICA IDENTITY FULL` (see `src/pg-setup.ts`). That is exactly
 *     acceptance (b): delete-from-shape on a non-PK predicate column, and the guard that refuses a
 *     shape whose table cannot supply the old image.
 */

import { defineTable, text, timestamp } from "@lesto/db";
import type { ShapeDefinition } from "@lesto/live-protocol";

/**
 * The `messages` table — the rows a `messagesInRoom(room)` shape reads and re-reads live. `room_id`
 * is the tenancy column the shape binds and the server authorizes (parameter-level authz); `id` is
 * the client-minted uuid the optimistic write and its replication echo correlate on.
 */
export const messages = defineTable("messages", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull(),
  author: text("author").notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").notNull(),
});

/** Every table a capstone shape reads — the allowlist the shape engine validates shapes against. */
export const capstoneTables = [messages] as const;

/**
 * The bound shape one room syncs: every column, filtered to a single `room_id`, in a total order
 * (`created_at` asc) so the snapshot is deterministic. The bound `room_id` value IS the capability
 * the server authorizes at subscribe time — a client names a room, it does not author the predicate.
 */
export function messagesInRoom(room: string): ShapeDefinition {
  return {
    table: "messages",
    key: "id",
    columns: ["id", "roomId", "author", "body", "createdAt"],
    where: [{ column: "roomId", op: "eq", value: room }],
    orderBy: { column: "createdAt", direction: "asc" },
  };
}
