import { Model } from "@keel/orm";

/**
 * The two records a mailing list is made of.
 *
 * Neither model owns a connection: the app calls `useDatabase` (from @keel/orm)
 * and creates the tables, and these models read and write whatever connection
 * is active. That keeps the package a pure composition over the ORM.
 */

/** A named list subscribers can join. Maps to table "lists". */
export class List extends Model {
  static override tableName = "lists";
}

/** A subscription a recipient holds against a list — the heart of double opt-in.  */
export class Subscriber extends Model {
  static override tableName = "subscribers";

  static override timestamps = true;
}

/** The lifecycle a subscriber moves through: pending → subscribed → unsubscribed. */
export type SubscriberStatus = "pending" | "subscribed" | "unsubscribed";
