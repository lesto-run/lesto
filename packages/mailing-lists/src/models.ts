/**
 * The two persisted entities a mailing-list is made of, as `@keel/db` schema
 * values — plus the camelCase helper functions the service speaks.
 *
 *   lists       — a named list subscribers join.
 *   subscribers — a recipient holding a status against a list, with a
 *                 confirmation token. Double opt-in's row.
 *
 * The status column is a string with three legal values — `SubscriberStatus`.
 * `@keel/db` doesn't have a runtime enum constraint today; the type narrows
 * at the API boundary (the helper signatures) and the database stores
 * whatever string the call sites pass.
 *
 * No global connection: every helper takes an explicit `db: Db`. That
 * follows the JS-y direction laid out in `docs/adr/0004-data-layer-style.md`
 * and matches `@keel/identity`'s shape exactly.
 */

import {
  createTableSql,
  defineTable,
  dropTableSql,
  and,
  eq,
  integer,
  text,
  type Db,
  type InferRow,
} from "@keel/db";
import type { Migration } from "@keel/migrate";

export const lists = defineTable("lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"),
});

export const subscribers = defineTable("subscribers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listId: integer("list_id").notNull(),
  email: text("email").notNull(),
  status: text("status").notNull(),
  token: text("token"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** The lifecycle a subscriber moves through: pending → subscribed → unsubscribed. */
export type SubscriberStatus = "pending" | "subscribed" | "unsubscribed";

/** A list row, as SELECT yields it. */
export type List = InferRow<typeof lists>;

/** A subscriber row, as SELECT yields it. */
export type Subscriber = InferRow<typeof subscribers>;

/** Insert a list. Returns the row. */
export async function insertList(db: Db, input: { name?: string | null }): Promise<List> {
  return await db
    .insert(lists)
    .values({ name: input.name ?? null })
    .returning()
    .get();
}

/** Insert a subscriber, stamping timestamps. Returns the row. */
export async function insertSubscriber(
  db: Db,
  input: {
    listId: number;
    email: string;
    status: SubscriberStatus;
    token: string | null;
  },
): Promise<Subscriber> {
  const now = new Date().toISOString();

  return await db
    .insert(subscribers)
    .values({
      listId: input.listId,
      email: input.email,
      status: input.status,
      token: input.token,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** A subscriber by id; `undefined` when no row matches. */
export async function findSubscriberById(db: Db, id: number): Promise<Subscriber | undefined> {
  return await db.select().from(subscribers).where(eq(subscribers.id, id)).get();
}

/** A subscriber by token (any status); `undefined` when no row matches. */
export async function findSubscriberByToken(
  db: Db,
  token: string,
): Promise<Subscriber | undefined> {
  return await db.select().from(subscribers).where(eq(subscribers.token, token)).get();
}

/** A *pending* subscriber by token — the row `confirm` is allowed to flip. */
export async function findPendingSubscriberByToken(
  db: Db,
  token: string,
): Promise<Subscriber | undefined> {
  return await db
    .select()
    .from(subscribers)
    .where(and(eq(subscribers.token, token), eq(subscribers.status, "pending")))
    .get();
}

/** Update a subscriber's status; stamps `updatedAt`. */
export async function setSubscriberStatus(
  db: Db,
  id: number,
  status: SubscriberStatus,
): Promise<void> {
  await db
    .update(subscribers)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(subscribers.id, id))
    .run();
}

/** Every confirmed recipient of a list — what broadcast iterates. */
export async function subscribedRecipients(db: Db, listId: number): Promise<Subscriber[]> {
  return await db
    .select()
    .from(subscribers)
    .where(and(eq(subscribers.listId, listId), eq(subscribers.status, "subscribed")))
    .all();
}

/**
 * The migration that creates `lists` and `subscribers`.
 *
 * Versioned with a sortable, stable prefix — `@keel/migrate` applies in
 * lexicographic order, so a timestamped version lets later migrations slot
 * in cleanly. Both tables share the migration; rolling back drops both
 * together (lists first would orphan subscribers, so subscribers come down
 * first in `down`).
 */
export const mailingListsMigration: { version: string; migration: Migration } = {
  version: "20260609000002_create_mailing_lists",
  migration: {
    async up(schema) {
      await schema.execute(createTableSql(lists));
      await schema.execute(createTableSql(subscribers));
    },
    async down(schema) {
      await schema.execute(dropTableSql(subscribers));
      await schema.execute(dropTableSql(lists));
    },
  },
};
