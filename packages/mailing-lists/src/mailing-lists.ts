import { randomBytes } from "node:crypto";

import { MailingListError } from "./errors";
import { Subscriber } from "./models";

import type { Mailer } from "@keel/mail";

/**
 * Ghost-style subscriber lists with double opt-in and broadcasts.
 *
 * The flow is the classic confirmed-subscription dance:
 *   subscribe → a "pending" row carrying a one-shot token
 *   confirm   → that token flips the row to "subscribed"
 *   broadcast → one queued email per "subscribed" recipient
 *
 * The package never opens a database — it operates on whatever connection the
 * app activated via @keel/orm.useDatabase, and on the Mailer it is handed. So
 * it is a pure composition of @keel/orm (records), @keel/mail (delivery), and,
 * underneath the mailer, @keel/queue (durable enqueue).
 */

/** A fresh, unguessable confirmation token. */
const randomToken = (): string => randomBytes(16).toString("hex");

export interface MailingListsOptions {
  readonly mailer: Mailer;

  /** Token generator. Injectable so tests are deterministic; random by default. */
  readonly token?: () => string;
}

export class MailingLists {
  private readonly mailer: Mailer;

  private readonly token: () => string;

  constructor(options: MailingListsOptions) {
    this.mailer = options.mailer;
    this.token = options.token ?? randomToken;
  }

  /** Begin double opt-in: create a pending subscriber holding a fresh token. */
  subscribe(listId: number, email: string): Subscriber {
    return Subscriber.create({
      list_id: listId,
      email,
      status: "pending",
      token: this.token(),
    });
  }

  /** Complete double opt-in: flip the pending subscriber for `token` to subscribed. */
  confirm(token: string): Subscriber {
    const subscriber = this.pending(token);

    subscriber.update({ status: "subscribed" });

    return subscriber;
  }

  /** Opt out: flip the subscriber for `token` to unsubscribed. */
  unsubscribe(token: string): Subscriber {
    const subscriber = this.forToken(token);

    subscriber.update({ status: "unsubscribed" });

    return subscriber;
  }

  /**
   * Fan a templated email out to every subscribed recipient of the list.
   *
   * `params` are merged with each recipient's `to`, then handed to the mailer —
   * which enqueues a delivery job apiece. Pending and unsubscribed rows are
   * skipped. Returns the number of emails enqueued.
   */
  broadcast(listId: number, mailerName: string, params: Record<string, unknown>): number {
    const recipients = Subscriber.where({ list_id: listId, status: "subscribed" }).all();

    for (const recipient of recipients) {
      const to = String(recipient.get("email"));

      this.mailer.send(mailerName, { ...params, to });
    }

    return recipients.length;
  }

  // ---- private ----

  /** The pending subscriber for `token`, or a coded error if there is none. */
  private pending(token: string): Subscriber {
    const subscriber = Subscriber.findBy({ token, status: "pending" });

    if (!subscriber) {
      throw this.invalidToken(token);
    }

    return subscriber;
  }

  /** The subscriber for `token` regardless of status, or a coded error. */
  private forToken(token: string): Subscriber {
    const subscriber = Subscriber.findBy({ token });

    if (!subscriber) {
      throw this.invalidToken(token);
    }

    return subscriber;
  }

  private invalidToken(token: string): MailingListError {
    return new MailingListError(
      "MAILING_LIST_INVALID_TOKEN",
      `No subscriber for token "${token}".`,
      { token },
    );
  }
}
