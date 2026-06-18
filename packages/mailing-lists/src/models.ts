/**
 * The persisted entities a mailing-list is made of, as `@lesto/db` schema
 * values — plus the camelCase helper functions the service speaks.
 *
 *   lists                 — a named list subscribers join.
 *   subscribers           — a recipient holding a status against a list, with a
 *                           confirmation token and a separate unsubscribe token.
 *                           Double opt-in's row.
 *   broadcasts            — one fan-out of a templated email to a list.
 *   broadcast_deliveries  — one row per (broadcast, subscriber): the per-recipient
 *                           ledger that makes a fan-out resumable and exactly-once.
 *
 * The status columns are strings with a fixed set of legal values
 * (`SubscriberStatus` / `DeliveryStatus`). `@lesto/db` has no runtime enum
 * constraint today; the type narrows at the API boundary (the helper
 * signatures) and the database stores whatever string the call sites pass.
 *
 * No global connection: every helper takes an explicit `db: Db`. That
 * follows the JS-y direction laid out in `docs/adr/0004-data-layer-style.md`
 * and matches `@lesto/identity`'s shape exactly.
 *
 * ## Dialect
 *
 * The schema value is dialect-free; the migration renders DDL for whichever
 * engine the migrator runs against (`schema.dialect`) exactly as the existing
 * tables do. The indexes this migration adds (`UNIQUE (list_id, email)`,
 * `UNIQUE` on each token, composite `(list_id, status)`) are spelled
 * identically on SQLite and Postgres, so they go through `schema.addIndex`,
 * which is dialect-agnostic.
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
} from "@lesto/db";
import type { Migration } from "@lesto/migrate";

export const lists = defineTable("lists", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name"),
});

export const subscribers = defineTable("subscribers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listId: integer("list_id").notNull(),
  email: text("email").notNull(),
  status: text("status").notNull(),
  /** One-shot token for `confirm`; rotated (cleared) once it is spent. */
  confirmToken: text("confirm_token"),
  /** Long-lived token for `unsubscribe` and the `List-Unsubscribe` header. */
  unsubscribeToken: text("unsubscribe_token"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const broadcasts = defineTable("broadcasts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  listId: integer("list_id").notNull(),
  mailer: text("mailer").notNull(),
  /** The shared template params, JSON-encoded; merged per recipient at enqueue. */
  params: text("params").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const broadcastDeliveries = defineTable("broadcast_deliveries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  broadcastId: integer("broadcast_id").notNull(),
  subscriberId: integer("subscriber_id").notNull(),
  email: text("email").notNull(),
  unsubscribeToken: text("unsubscribe_token"),
  status: text("status").notNull(),
  /** The mail delivery job id, once this row has been enqueued. */
  jobId: integer("job_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** The lifecycle a subscriber moves through: pending → subscribed → unsubscribed. */
export type SubscriberStatus = "pending" | "subscribed" | "unsubscribed";

/** A broadcast is `pending` while it fans out, `sent` once every row is enqueued. */
export type BroadcastStatus = "pending" | "sent";

/** A per-recipient delivery is `pending` until its mail job is enqueued. */
export type DeliveryStatus = "pending" | "enqueued";

/** A list row, as SELECT yields it. */
export type List = InferRow<typeof lists>;

/** A subscriber row, as SELECT yields it. */
export type Subscriber = InferRow<typeof subscribers>;

/** A broadcast row, as SELECT yields it. */
export type Broadcast = InferRow<typeof broadcasts>;

/** A per-recipient delivery row, as SELECT yields it. */
export type BroadcastDelivery = InferRow<typeof broadcastDeliveries>;

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
    confirmToken: string | null;
    unsubscribeToken: string | null;
  },
): Promise<Subscriber> {
  const now = new Date().toISOString();

  return await db
    .insert(subscribers)
    .values({
      listId: input.listId,
      email: input.email,
      status: input.status,
      confirmToken: input.confirmToken,
      unsubscribeToken: input.unsubscribeToken,
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

/** A subscriber by `(list_id, email)` — the upsert key; `undefined` when none. */
export async function findSubscriberByEmail(
  db: Db,
  listId: number,
  email: string,
): Promise<Subscriber | undefined> {
  return await db
    .select()
    .from(subscribers)
    .where(and(eq(subscribers.listId, listId), eq(subscribers.email, email)))
    .get();
}

/** A *pending* subscriber by confirm token — the row `confirm` is allowed to flip. */
export async function findPendingSubscriberByConfirmToken(
  db: Db,
  token: string,
): Promise<Subscriber | undefined> {
  return await db
    .select()
    .from(subscribers)
    .where(and(eq(subscribers.confirmToken, token), eq(subscribers.status, "pending")))
    .get();
}

/** A subscriber by unsubscribe token (any status); `undefined` when no row matches. */
export async function findSubscriberByUnsubscribeToken(
  db: Db,
  token: string,
): Promise<Subscriber | undefined> {
  return await db.select().from(subscribers).where(eq(subscribers.unsubscribeToken, token)).get();
}

/**
 * Upsert a subscriber back to `pending` for `(list_id, email)`, minting fresh
 * tokens. A second `subscribe` of the same address is the same row reset for a
 * new opt-in, never a duplicate — backed by the `UNIQUE (list_id, email)` index.
 *
 * Runs in one transaction: SELECT the existing row, then UPDATE or INSERT. The
 * unique index is the real guard against a concurrent racer; the transaction
 * keeps the read-then-write consistent on the single connection.
 */
export async function upsertPendingSubscriber(
  db: Db,
  input: {
    listId: number;
    email: string;
    confirmToken: string;
    unsubscribeToken: string;
  },
): Promise<Subscriber> {
  return await db.transaction(async (tx) => {
    const existing = await findSubscriberByEmail(tx, input.listId, input.email);
    const now = new Date().toISOString();

    if (existing) {
      await tx
        .update(subscribers)
        .set({
          status: "pending",
          confirmToken: input.confirmToken,
          unsubscribeToken: input.unsubscribeToken,
          updatedAt: now,
        })
        .where(eq(subscribers.id, existing.id))
        .run();

      return {
        ...existing,
        status: "pending",
        confirmToken: input.confirmToken,
        unsubscribeToken: input.unsubscribeToken,
        updatedAt: now,
      };
    }

    return await insertSubscriber(tx, {
      listId: input.listId,
      email: input.email,
      status: "pending",
      confirmToken: input.confirmToken,
      unsubscribeToken: input.unsubscribeToken,
    });
  });
}

/**
 * Confirm a subscriber: flip to `subscribed` and ROTATE the confirm token so it
 * is single-use — a replayed confirmation link no longer matches a pending row.
 */
export async function confirmSubscriber(db: Db, id: number): Promise<void> {
  await db
    .update(subscribers)
    .set({ status: "subscribed", confirmToken: null, updatedAt: new Date().toISOString() })
    .where(eq(subscribers.id, id))
    .run();
}

/** Flip a subscriber to `unsubscribed`; stamps `updatedAt`. */
export async function unsubscribeSubscriber(db: Db, id: number): Promise<void> {
  await db
    .update(subscribers)
    .set({ status: "unsubscribed", updatedAt: new Date().toISOString() })
    .where(eq(subscribers.id, id))
    .run();
}

/** Every confirmed recipient of a list — what a broadcast fans out to. */
export async function subscribedRecipients(db: Db, listId: number): Promise<Subscriber[]> {
  return await db
    .select()
    .from(subscribers)
    .where(and(eq(subscribers.listId, listId), eq(subscribers.status, "subscribed")))
    .all();
}

/** Insert a broadcast row in the `pending` state, stamping timestamps. */
export async function insertBroadcast(
  db: Db,
  input: { listId: number; mailer: string; params: string },
): Promise<Broadcast> {
  const now = new Date().toISOString();

  return await db
    .insert(broadcasts)
    .values({
      listId: input.listId,
      mailer: input.mailer,
      params: input.params,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
}

/** A broadcast by id; `undefined` when no row matches. */
export async function findBroadcastById(db: Db, id: number): Promise<Broadcast | undefined> {
  return await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get();
}

/** Mark a broadcast `sent` — every delivery row has been enqueued. */
export async function markBroadcastSent(db: Db, id: number): Promise<void> {
  await db
    .update(broadcasts)
    .set({ status: "sent", updatedAt: new Date().toISOString() })
    .where(eq(broadcasts.id, id))
    .run();
}

/** Insert a per-recipient delivery row in the `pending` state. */
export async function insertBroadcastDelivery(
  db: Db,
  input: {
    broadcastId: number;
    subscriberId: number;
    email: string;
    unsubscribeToken: string | null;
  },
): Promise<void> {
  const now = new Date().toISOString();

  await db
    .insert(broadcastDeliveries)
    .values({
      broadcastId: input.broadcastId,
      subscriberId: input.subscriberId,
      email: input.email,
      unsubscribeToken: input.unsubscribeToken,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

/** The still-`pending` delivery rows for a broadcast — what a resume re-enqueues. */
export async function pendingBroadcastDeliveries(
  db: Db,
  broadcastId: number,
): Promise<BroadcastDelivery[]> {
  return await db
    .select()
    .from(broadcastDeliveries)
    .where(
      and(
        eq(broadcastDeliveries.broadcastId, broadcastId),
        eq(broadcastDeliveries.status, "pending"),
      ),
    )
    .all();
}

/** Mark a delivery row `enqueued`, recording the mail job id. */
export async function markDeliveryEnqueued(db: Db, id: number, jobId: number): Promise<void> {
  await db
    .update(broadcastDeliveries)
    .set({ status: "enqueued", jobId, updatedAt: new Date().toISOString() })
    .where(eq(broadcastDeliveries.id, id))
    .run();
}

/**
 * The migration that creates the mailing-list tables and their indexes.
 *
 * Versioned with a sortable, stable prefix — `@lesto/migrate` applies in
 * lexicographic order, so a timestamped version lets later migrations slot
 * in cleanly. All four tables share the migration; rolling back drops them in
 * dependency order (deliveries → broadcasts, subscribers → lists), so no drop
 * orphans a row.
 *
 * The indexes are added in the same DDL change: they turn the service's hot
 * lookups (by token, by `(list_id, status)`, the upsert by `(list_id, email)`)
 * from full table scans into index seeks, and the UNIQUE ones are the real
 * integrity guard behind the upsert and the single-use tokens. They are spelled
 * identically on both dialects, so `schema.addIndex` (dialect-agnostic) renders
 * them; only the `createTableSql` calls fork on `schema.dialect`.
 */
export const mailingListsMigration: { version: string; migration: Migration } = {
  version: "20260609000002_create_mailing_lists",
  migration: {
    async up(schema) {
      // Render for the engine the migrator runs against (`schema.dialect`).
      await schema.execute(createTableSql(lists, schema.dialect));
      await schema.execute(createTableSql(subscribers, schema.dialect));
      await schema.execute(createTableSql(broadcasts, schema.dialect));
      await schema.execute(createTableSql(broadcastDeliveries, schema.dialect));

      // One row per address per list — the upsert key, and the guard against a
      // duplicate-subscribe racing in a second row.
      await schema.addIndex("subscribers", ["list_id", "email"], { unique: true });
      // Single-use confirm tokens and stable unsubscribe tokens are looked up by
      // value and must be globally unique.
      await schema.addIndex("subscribers", "confirm_token", { unique: true });
      await schema.addIndex("subscribers", "unsubscribe_token", { unique: true });
      // The broadcast recipient scan filters on exactly this composite.
      await schema.addIndex("subscribers", ["list_id", "status"]);

      // A broadcast enqueues each recipient at most once: one delivery row per
      // (broadcast, subscriber), enforced so a resumed fan-out cannot double-insert.
      await schema.addIndex("broadcast_deliveries", ["broadcast_id", "subscriber_id"], {
        unique: true,
      });
      // The resume scan filters pending rows of one broadcast.
      await schema.addIndex("broadcast_deliveries", ["broadcast_id", "status"]);
    },
    async down(schema) {
      await schema.execute(dropTableSql(broadcastDeliveries));
      await schema.execute(dropTableSql(broadcasts));
      await schema.execute(dropTableSql(subscribers));
      await schema.execute(dropTableSql(lists));
    },
  },
};
