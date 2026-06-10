import { randomBytes } from "node:crypto";

import type { Db } from "@keel/db";
import type { Mailer } from "@keel/mail";

import { MailingListError } from "./errors";
import {
  findPendingSubscriberByToken,
  findSubscriberByToken,
  insertSubscriber,
  setSubscriberStatus,
  subscribedRecipients,
  type Subscriber,
} from "./models";

/**
 * Ghost-style subscriber lists with double opt-in and broadcasts.
 *
 *   const lists = createMailingLists({ db, mailer });
 *
 *   lists.subscribe(list.id, "ada@example.com");  // pending + token
 *   lists.confirm(token);                          // → subscribed
 *   lists.broadcast(list.id, "digest", { ... });   // one email apiece
 *   lists.unsubscribe(token);                      // → unsubscribed
 *
 * The flow is the classic confirmed-subscription dance:
 *   subscribe → a "pending" row carrying a one-shot token
 *   confirm   → that token flips the row to "subscribed"
 *   broadcast → one queued email per "subscribed" recipient
 *
 * Built as a closure factory (matches `@keel/identity`'s shape): no `this`,
 * no inheritance, `db` + `mailer` captured in lexical scope. The package
 * does not open a database — it operates on the {@link Db} the caller hands
 * it, and on the {@link Mailer} alongside.
 */

/** A fresh, unguessable confirmation token. */
const randomToken = (): string => randomBytes(16).toString("hex");

export interface MailingListsOptions {
  /** The database handle the service queries through. Explicit, never global. */
  readonly db: Db;

  /** The mailer broadcast hands one delivery job per recipient to. */
  readonly mailer: Mailer;

  /** Token generator. Injectable so tests are deterministic; random by default. */
  readonly token?: () => string;
}

/**
 * The mailing-list service — an object of functions, all closing over the
 * `db`, `mailer`, and token generator passed to {@link createMailingLists}.
 */
export interface MailingLists {
  /** Begin double opt-in: create a pending subscriber holding a fresh token. */
  subscribe(listId: number, email: string): Subscriber;

  /** Complete double opt-in: flip the pending subscriber for `token` to subscribed. */
  confirm(token: string): Subscriber;

  /** Opt out: flip the subscriber for `token` to unsubscribed. */
  unsubscribe(token: string): Subscriber;

  /**
   * Fan a templated email out to every subscribed recipient of the list.
   *
   * `params` are merged with each recipient's `to`, then handed to the
   * mailer — which enqueues a delivery job apiece. Pending and unsubscribed
   * rows are skipped. Returns the number of emails enqueued.
   */
  broadcast(listId: number, mailerName: string, params: Record<string, unknown>): number;
}

const invalidToken = (token: string): MailingListError =>
  new MailingListError("MAILING_LIST_INVALID_TOKEN", `No subscriber for token "${token}".`, {
    token,
  });

/** Build a {@link MailingLists} bound to the given options. */
export function createMailingLists(options: MailingListsOptions): MailingLists {
  const db = options.db;
  const mailer = options.mailer;
  const token = options.token ?? randomToken;

  return {
    subscribe(listId, email) {
      return insertSubscriber(db, {
        listId,
        email,
        status: "pending",
        token: token(),
      });
    },

    confirm(presented) {
      const subscriber = findPendingSubscriberByToken(db, presented);

      if (!subscriber) throw invalidToken(presented);

      setSubscriberStatus(db, subscriber.id, "subscribed");

      return { ...subscriber, status: "subscribed" };
    },

    unsubscribe(presented) {
      const subscriber = findSubscriberByToken(db, presented);

      if (!subscriber) throw invalidToken(presented);

      setSubscriberStatus(db, subscriber.id, "unsubscribed");

      return { ...subscriber, status: "unsubscribed" };
    },

    broadcast(listId, mailerName, params) {
      const recipients = subscribedRecipients(db, listId);

      for (const recipient of recipients) {
        mailer.send(mailerName, { ...params, to: recipient.email });
      }

      return recipients.length;
    },
  };
}
