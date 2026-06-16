import { randomBytes } from "node:crypto";

import type { Db } from "@keel/db";
import type { Mailer } from "@keel/mail";
import type { JsonValue } from "@keel/queue";

import { MailingListError } from "./errors";
import {
  confirmSubscriber,
  findBroadcastById,
  findPendingSubscriberByConfirmToken,
  findSubscriberByUnsubscribeToken,
  insertBroadcast,
  insertBroadcastDelivery,
  markBroadcastSent,
  markDeliveryEnqueued,
  pendingBroadcastDeliveries,
  subscribedRecipients,
  unsubscribeSubscriber,
  upsertPendingSubscriber,
  type BroadcastDelivery,
  type Subscriber,
} from "./models";

/**
 * Ghost-style subscriber lists with double opt-in and resumable broadcasts.
 *
 *   const lists = createMailingLists({
 *     db,
 *     mailer,
 *     confirmationMailer: { name: "confirm", confirmUrl: (t) => `https://x.com/confirm/${t}` },
 *     unsubscribeUrl: (t) => `https://x.com/unsubscribe/${t}`,
 *   });
 *
 *   await lists.subscribe(list.id, "ada@example.com"); // pending + confirm email enqueued
 *   await lists.confirm(confirmToken);                  // → subscribed (token rotated away)
 *   await lists.broadcast(list.id, "digest", { ... });  // → { broadcastId, enqueued }
 *   await lists.unsubscribe(unsubscribeToken);          // → unsubscribed
 *
 * The flow is the classic confirmed-subscription dance:
 *   subscribe → a "pending" row carrying a one-shot confirm token; if a
 *               `confirmationMailer` is configured, its confirmation email is
 *               enqueued so the recipient can opt in. A second subscribe of the
 *               same address is an UPSERT — the same row reset to pending, never
 *               a duplicate (backed by `UNIQUE (list_id, email)`).
 *   confirm   → that confirm token flips the row to "subscribed" and is rotated
 *               (cleared) so the link is single-use.
 *   broadcast → a `broadcasts` row plus one `broadcast_deliveries` row per
 *               recipient, written in a chunked transaction, then a mail job per
 *               pending delivery. A crash mid-fan-out resumes from the pending
 *               rows instead of double-sending; each email carries
 *               `List-Unsubscribe`/`List-Unsubscribe-Post` headers.
 *   unsubscribe → the long-lived unsubscribe token flips the row to "unsubscribed".
 *
 * ## The HTTP boundary must rate-limit `subscribe`
 *
 * `subscribe` is unauthenticated by nature (anyone may join a list) and it both
 * writes a row and enqueues an email. That makes it a spam/abuse amplifier if
 * exposed raw. This package does NOT rate-limit — it has no request context — so
 * the HTTP handler that fronts `subscribe` MUST apply `@keel/ratelimit` (keyed by
 * IP and/or email) before calling it. The double opt-in itself blunts list-bombing
 * (an unconfirmed address never receives a broadcast), but the confirmation email
 * is still a send the caller is on the hook to throttle.
 *
 * Built as a closure factory (matches `@keel/identity`'s shape): no `this`,
 * no inheritance; `db`, `mailer`, the token generator, and the optional
 * deliverability config are captured in lexical scope. The package does not open
 * a database — it operates on the {@link Db} the caller hands it, and on the
 * {@link Mailer} alongside.
 */

/** A fresh, unguessable token (16 random bytes, hex). */
const randomToken = (): string => randomBytes(16).toString("hex");

/**
 * The confirmation-email config. When present, `subscribe` enqueues `name` with
 * `{ to, confirmUrl }` so a registered mailer template can render the opt-in link.
 */
export interface ConfirmationMailer {
  /** The registered mailer template name to enqueue on subscribe. */
  readonly name: string;

  /** Build the confirmation link the recipient clicks, from the confirm token. */
  confirmUrl(token: string): string;
}

export interface MailingListsOptions {
  /** The database handle the service queries through. Explicit, never global. */
  readonly db: Db;

  /** The mailer broadcast (and the confirmation flow) hand delivery jobs to. */
  readonly mailer: Mailer;

  /**
   * When set, `subscribe` enqueues this template with `{ to, confirmUrl }` so the
   * recipient receives an opt-in link. When omitted, `subscribe` creates the
   * pending row but enqueues nothing — the caller drives confirmation itself.
   */
  readonly confirmationMailer?: ConfirmationMailer;

  /**
   * Build the one-click unsubscribe URL for a recipient's unsubscribe token.
   * When set, every broadcast email carries `List-Unsubscribe` /
   * `List-Unsubscribe-Post` headers (a Gmail/Yahoo bulk-sender requirement). The
   * headers ride in each recipient's params under `headers`, so the broadcast
   * template must spread `params.headers` into the email it returns.
   */
  readonly unsubscribeUrl?: (token: string) => string;

  /** Token generator. Injectable so tests are deterministic; random by default. */
  readonly token?: () => string;

  /**
   * How many delivery rows to write per transaction when fanning a broadcast
   * out. A 100k-recipient list is inserted in batches of this size rather than
   * one giant statement or 100k serial round trips. Defaults to 1000.
   */
  readonly chunkSize?: number;
}

/** A queued broadcast: which row it created, and how many emails it enqueued. */
export interface BroadcastResult {
  /** The `broadcasts` row id — pass it to {@link MailingLists.resumeBroadcast}. */
  readonly broadcastId: number;

  /** How many delivery jobs were enqueued in this run. */
  readonly enqueued: number;
}

/**
 * The mailing-list service — an object of functions, all closing over the
 * `db`, `mailer`, token generator, and deliverability config passed to
 * {@link createMailingLists}.
 */
export interface MailingLists {
  /**
   * Begin double opt-in: upsert a pending subscriber holding a fresh confirm
   * token, and (when a `confirmationMailer` is configured) enqueue the
   * confirmation email. Re-subscribing an address resets the same row — never a
   * duplicate. The email is validated for shape first.
   */
  subscribe(listId: number, email: string): Promise<Subscriber>;

  /** Complete double opt-in: flip the pending subscriber for `confirmToken` to subscribed, rotating the token. */
  confirm(confirmToken: string): Promise<Subscriber>;

  /** Opt out: flip the subscriber for `unsubscribeToken` to unsubscribed. */
  unsubscribe(unsubscribeToken: string): Promise<Subscriber>;

  /**
   * Fan a templated email out to every subscribed recipient of the list.
   *
   * Records a `broadcasts` row and one `broadcast_deliveries` row per recipient
   * in chunked transactions, then enqueues a mail job per pending delivery,
   * marking each enqueued. A crash partway through leaves the unfinished rows
   * `pending`; {@link resumeBroadcast} (or a fresh `broadcast`) picks up exactly
   * those — no recipient is enqueued twice. Returns the new broadcast id and how
   * many jobs this run enqueued.
   */
  broadcast(
    listId: number,
    mailerName: string,
    params: Record<string, unknown>,
  ): Promise<BroadcastResult>;

  /**
   * Resume a broadcast that crashed mid-fan-out: enqueue only the still-`pending`
   * delivery rows for `broadcastId`. Idempotent — running it after the broadcast
   * already finished enqueues nothing.
   */
  resumeBroadcast(broadcastId: number): Promise<BroadcastResult>;
}

const invalidToken = (token: string): MailingListError =>
  new MailingListError("MAILING_LIST_INVALID_TOKEN", `No subscriber for token "${token}".`, {
    token,
  });

/**
 * A pragmatic email shape check at the boundary: exactly one `@`, non-empty
 * local and domain parts, a dotted domain, and no whitespace or header-injection
 * characters. This is a syntactic guard, not RFC 5322 — the real proof an
 * address exists is the confirmation email round-trip.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

function assertEmailShape(email: string): void {
  if (!EMAIL_RE.test(email)) {
    throw new MailingListError(
      "MAILING_LIST_INVALID_EMAIL",
      `"${email}" is not a valid email address.`,
      { email },
    );
  }
}

const DEFAULT_CHUNK_SIZE = 1000;

/** Slice `items` into runs of at most `size`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
}

/** Build a {@link MailingLists} bound to the given options. */
export function createMailingLists(options: MailingListsOptions): MailingLists {
  const db = options.db;
  const mailer = options.mailer;
  const token = options.token ?? randomToken;
  const confirmationMailer = options.confirmationMailer;
  const unsubscribeUrl = options.unsubscribeUrl;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;

  /** The `List-Unsubscribe` header pair for a recipient, or `undefined` when unconfigured. */
  const listUnsubscribeHeaders = (
    unsubscribeToken: string | null,
  ): Record<string, string> | undefined => {
    if (!unsubscribeUrl || unsubscribeToken === null) return undefined;

    return {
      "List-Unsubscribe": `<${unsubscribeUrl(unsubscribeToken)}>`,
      // RFC 8058 one-click: a POST to the URL above unsubscribes with no further
      // interaction — what Gmail/Yahoo require to honor the header.
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  };

  /**
   * Enqueue the still-pending deliveries of a broadcast, marking each enqueued
   * as it goes. Shared by `broadcast` and `resumeBroadcast`. Each iteration is
   * idempotent against a crash: the mail job is enqueued, THEN the row is marked
   * — a crash between the two leaves the row `pending`, so a resume re-enqueues
   * it (at-least-once, the same floor the queue and mailer already document),
   * never double-marking it `enqueued`.
   */
  const drainDeliveries = async (
    broadcastId: number,
    mailerName: string,
    params: Record<string, unknown>,
    pending: BroadcastDelivery[],
  ): Promise<number> => {
    let enqueued = 0;

    for (const delivery of pending) {
      const headers = listUnsubscribeHeaders(delivery.unsubscribeToken);

      // `params` is caller-supplied JSON the broadcast row already round-trips as
      // a string, so it is JSON-shaped by construction; the cast is the honest
      // bridge from the public `Record<string, unknown>` to the queue's `JsonValue`.
      const jobId = await mailer.send(mailerName, {
        ...(params as Record<string, JsonValue>),
        to: delivery.email,
        ...(headers === undefined ? {} : { headers }),
      });

      await markDeliveryEnqueued(db, delivery.id, jobId);
      enqueued += 1;
    }

    // The loop only completes if every pending row was enqueued (an enqueue
    // failure propagates and leaves the rest `pending` for a resume), so once we
    // are here the broadcast has no work left — mark it `sent`. Idempotent: a
    // resume that found nothing pending re-marks an already-`sent` row.
    await markBroadcastSent(db, broadcastId);

    return enqueued;
  };

  return {
    async subscribe(listId, email) {
      assertEmailShape(email);

      const subscriber = await upsertPendingSubscriber(db, {
        listId,
        email,
        confirmToken: token(),
        unsubscribeToken: token(),
      });

      if (confirmationMailer) {
        // The confirm token is non-null on a freshly upserted pending row.
        await mailer.send(confirmationMailer.name, {
          to: email,
          confirmUrl: confirmationMailer.confirmUrl(subscriber.confirmToken!),
        });
      }

      return subscriber;
    },

    async confirm(presented) {
      const subscriber = await findPendingSubscriberByConfirmToken(db, presented);

      if (!subscriber) throw invalidToken(presented);

      await confirmSubscriber(db, subscriber.id);

      // Reflect the rotation: the spent confirm token is cleared on the row.
      return { ...subscriber, status: "subscribed", confirmToken: null };
    },

    async unsubscribe(presented) {
      const subscriber = await findSubscriberByUnsubscribeToken(db, presented);

      if (!subscriber) throw invalidToken(presented);

      await unsubscribeSubscriber(db, subscriber.id);

      return { ...subscriber, status: "unsubscribed" };
    },

    async broadcast(listId, mailerName, params) {
      const recipients = await subscribedRecipients(db, listId);

      // The broadcast row + every delivery row are written first, in chunked
      // transactions, so the full recipient set is durably recorded BEFORE any
      // email is enqueued. If the process dies during fan-out, the ledger already
      // knows every intended recipient and which ones are still `pending`.
      const broadcastRow = await insertBroadcast(db, {
        listId,
        mailer: mailerName,
        params: JSON.stringify(params),
      });

      for (const batch of chunk(recipients, chunkSize)) {
        await db.transaction(async (tx) => {
          for (const recipient of batch) {
            await insertBroadcastDelivery(tx, {
              broadcastId: broadcastRow.id,
              subscriberId: recipient.id,
              email: recipient.email,
              unsubscribeToken: recipient.unsubscribeToken,
            });
          }
        });
      }

      const pending = await pendingBroadcastDeliveries(db, broadcastRow.id);
      const enqueued = await drainDeliveries(broadcastRow.id, mailerName, params, pending);

      return { broadcastId: broadcastRow.id, enqueued };
    },

    async resumeBroadcast(broadcastId) {
      const broadcastRow = await findBroadcastById(db, broadcastId);

      if (!broadcastRow) {
        throw new MailingListError(
          "MAILING_LIST_UNKNOWN_BROADCAST",
          `No broadcast with id ${broadcastId}.`,
          { broadcastId },
        );
      }

      const params = JSON.parse(broadcastRow.params) as Record<string, unknown>;
      const pending = await pendingBroadcastDeliveries(db, broadcastId);
      const enqueued = await drainDeliveries(broadcastId, broadcastRow.mailer, params, pending);

      return { broadcastId, enqueued };
    },
  };
}
