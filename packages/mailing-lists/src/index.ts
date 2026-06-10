/**
 * @keel/mailing-lists — Ghost-style subscriber lists with double opt-in.
 *
 *   const db = createDb(sqlAdapter);
 *   new Migrator(sql, [mailingListsMigration]).migrate();
 *
 *   const list = insertList(db, { name: "Weekly" });
 *   const lists = createMailingLists({ db, mailer });
 *
 *   const sub = lists.subscribe(list.id, "ada@example.com");  // pending + token
 *   lists.confirm(sub.token!);                                 // → subscribed
 *   lists.broadcast(list.id, "digest", { issue: 42 });         // one email apiece
 *   lists.unsubscribe(sub.token!);                             // → unsubscribed
 *
 * Composes:
 *   - `@keel/db`    — the `lists` + `subscribers` schemas, queries, and DDL
 *   - `@keel/mail`  — delivery
 *   - `@keel/queue` — durable enqueue beneath the mailer
 *
 * The package opens no database; the caller hands it a {@link Db} and a
 * mailer, and `createMailingLists` returns the service.
 */

export {
  findPendingSubscriberByToken,
  findSubscriberById,
  findSubscriberByToken,
  insertList,
  insertSubscriber,
  lists,
  mailingListsMigration,
  setSubscriberStatus,
  subscribedRecipients,
  subscribers,
} from "./models";
export type { List, Subscriber, SubscriberStatus } from "./models";

export { createMailingLists } from "./mailing-lists";
export type { MailingLists, MailingListsOptions } from "./mailing-lists";

export { MailingListError } from "./errors";
export type { MailingListErrorCode } from "./errors";
