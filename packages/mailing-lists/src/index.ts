/**
 * @keel/mailing-lists — Ghost-style subscriber lists with double opt-in and
 * resumable broadcasts.
 *
 *   const db = createDb(sqlAdapter);
 *   await new Migrator(sql, [mailingListsMigration]).migrate();
 *
 *   const list = await insertList(db, { name: "Weekly" });
 *   const lists = createMailingLists({
 *     db,
 *     mailer,
 *     confirmationMailer: { name: "confirm", confirmUrl: (t) => `https://x.com/confirm/${t}` },
 *     unsubscribeUrl: (t) => `https://x.com/unsubscribe/${t}`,
 *   });
 *
 *   const sub = await lists.subscribe(list.id, "ada@example.com"); // pending; confirm email enqueued
 *   await lists.confirm(sub.confirmToken!);                         // → subscribed (token rotated)
 *   await lists.broadcast(list.id, "digest", { issue: 42 });        // → { broadcastId, enqueued }
 *   await lists.unsubscribe(sub.unsubscribeToken!);                 // → unsubscribed
 *
 * Composes:
 *   - `@keel/db`    — the lists/subscribers/broadcasts schemas, queries, and DDL
 *   - `@keel/mail`  — delivery (confirmation + per-recipient broadcast emails)
 *   - `@keel/queue` — durable enqueue beneath the mailer
 *
 * The package opens no database and holds no request context; the caller hands
 * it a {@link Db} and a {@link Mailer}, and `createMailingLists` returns the
 * service. The HTTP boundary that fronts `subscribe` MUST rate-limit it (see the
 * note on {@link createMailingLists}).
 */

export {
  broadcastDeliveries,
  broadcasts,
  confirmSubscriber,
  findBroadcastById,
  findPendingSubscriberByConfirmToken,
  findSubscriberByEmail,
  findSubscriberById,
  findSubscriberByUnsubscribeToken,
  insertBroadcast,
  insertBroadcastDelivery,
  insertList,
  insertSubscriber,
  lists,
  mailingListsMigration,
  markBroadcastSent,
  markDeliveryEnqueued,
  pendingBroadcastDeliveries,
  subscribedRecipients,
  subscribers,
  unsubscribeSubscriber,
  upsertPendingSubscriber,
} from "./models";
export type {
  Broadcast,
  BroadcastDelivery,
  BroadcastStatus,
  DeliveryStatus,
  List,
  Subscriber,
  SubscriberStatus,
} from "./models";

export { createMailingLists } from "./mailing-lists";
export type {
  BroadcastResult,
  ConfirmationMailer,
  MailingLists,
  MailingListsOptions,
} from "./mailing-lists";

export { MailingListError } from "./errors";
export type { MailingListErrorCode } from "./errors";
