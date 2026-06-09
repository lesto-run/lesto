/**
 * @keel/mailing-lists — Ghost-style subscriber lists with double opt-in.
 *
 *   useDatabase(db);                       // from @keel/orm; app owns the connection
 *   const lists = new MailingLists({ mailer });
 *
 *   const sub = lists.subscribe(list.id, "ada@example.com");  // pending + token
 *   lists.confirm(sub.get("token") as string);                // → subscribed
 *   lists.broadcast(list.id, "digest", { issue: 42 });        // one email apiece
 *   lists.unsubscribe(token);                                 // → unsubscribed
 *
 * The package owns no database connection: it composes @keel/orm (records),
 * @keel/mail (delivery), and @keel/queue (durable enqueue beneath the mailer).
 */

export { List, Subscriber } from "./models";
export type { SubscriberStatus } from "./models";

export { MailingLists } from "./mailing-lists";
export type { MailingListsOptions } from "./mailing-lists";

export { MailingListError } from "./errors";
export type { MailingListErrorCode } from "./errors";
