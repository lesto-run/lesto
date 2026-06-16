import { KeelError } from "@keel/errors";

import type { JobContext, JsonValue, Queue } from "@keel/queue";

/**
 * Mailers — define an email as a function of its params; send it by name.
 *
 * Delivery rides on @keel/queue: `send` enqueues a job, and a worker renders the
 * template and hands it to the transport. So retries, backoff, and deploy-safe
 * reclaim come for free, and the request path never blocks on SMTP.
 *
 * The template body is either a ready `html` string or a `react` element paired
 * with a `render` function — wire react-email's `render` and your components
 * become typed, prop-driven emails. A plain-text `text` alternative and extra
 * `headers` may ride alongside; transports turn them into a multipart body and
 * MIME headers respectively.
 *
 * ## Delivery is at-least-once
 *
 * Because delivery is queue-backed, a worker that crashes after the transport
 * accepted the message but before the job is marked done will hand the *same*
 * email to the transport again on reclaim. So an address can receive a message
 * more than once. A stable, job-derived `messageId` rides every delivery
 * ({@link RenderedEmail.messageId}) precisely so an idempotent provider can
 * dedupe; transports SHOULD forward it (e.g. SMTP `Message-ID`, a provider's
 * idempotency key) so retries collapse to a single send.
 */

const DELIVER_JOB = "keel.mail.deliver";

export type MailErrorCode =
  | "MAIL_UNKNOWN_MAILER"
  | "MAIL_EMPTY_BODY"
  | "MAIL_NO_RENDERER"
  | "MAIL_INVALID_ADDRESS"
  | "MAIL_INVALID_HEADER";

export class MailError extends KeelError<MailErrorCode> {
  constructor(code: MailErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "MailError";
  }
}

export interface Email {
  readonly to: string;
  readonly subject: string;
  readonly from?: string;

  /** Ready HTML body. Mutually sufficient with `react`. */
  readonly html?: string;

  /** A react element rendered to HTML by the injected {@link EmailRenderer}. */
  readonly react?: unknown;

  /**
   * Plain-text alternative. When present along`html`, transports emit a
   * `multipart/alternative` body so text-only clients still render.
   */
  readonly text?: string;

  /**
   * Extra headers (e.g. `Reply-To`, `List-Unsubscribe`). Header *names* and
   * *values* are validated for CR/LF injection at both build and deliver time.
   */
  readonly headers?: Record<string, string>;
}

export interface RenderedEmail {
  readonly to: string;
  readonly subject: string;
  readonly from?: string;
  readonly html: string;
  readonly text?: string;
  readonly headers?: Record<string, string>;

  /**
   * A stable id derived from the delivery job. Identical across every
   * at-least-once retry of the same job, so an idempotent transport can dedupe.
   */
  readonly messageId: string;
}

/**
 * A sink that actually puts an email on the wire.
 *
 * ## Contract: delivery is at-least-once
 *
 * The mailer rides @keel/queue, which guarantees *at-least-once* execution: a
 * crash between a successful `send` and the job being marked done re-runs the
 * handler, so `send` may be called more than once for the same logical email.
 * Every {@link RenderedEmail} carries a stable, job-derived `messageId` that is
 * **identical across retries** — an idempotent transport SHOULD key on it (SMTP
 * `Message-ID`, a provider idempotency key) so duplicate sends collapse to one
 * delivered message. A transport with no dedupe will deliver duplicates on
 * retry; that is the documented, accepted floor.
 *
 * `send` MUST reject (throw / reject the promise) on a non-delivery so the queue
 * retries; returning normally signals the message was accepted.
 */
export interface MailTransport {
  send(email: RenderedEmail): Promise<void>;
}

export type EmailRenderer = (element: unknown) => string | Promise<string>;

type Builder = (params: JsonValue) => Email | Promise<Email>;

export interface MailerOptions {
  readonly queue: Queue;
  readonly transport: MailTransport;
  readonly render?: EmailRenderer;
  readonly defaultFrom?: string;

  /**
   * How long to defer a re-parked unknown-mailer job (see {@link Mailer.deliver}).
   * Defaults to 60s — long enough for a rolling deploy to finish.
   */
  readonly unknownMailerParkMs?: number;

  /**
   * How many times an unknown-mailer job may be parked before it is allowed to
   * fail loudly. Bounds the deploy-skew grace period so a genuinely-deleted
   * mailer cannot park forever. Defaults to 10.
   */
  readonly maxUnknownMailerParks?: number;
}

const DEFAULT_PARK_MS = 60_000;
const DEFAULT_MAX_PARKS = 10;

export class Mailer {
  private readonly queue: Queue;

  private readonly transport: MailTransport;

  private readonly render: EmailRenderer | undefined;

  private readonly defaultFrom: string | undefined;

  private readonly unknownMailerParkMs: number;

  private readonly maxUnknownMailerParks: number;

  private readonly builders = new Map<string, Builder>();

  constructor(options: MailerOptions) {
    this.queue = options.queue;
    this.transport = options.transport;
    this.render = options.render;
    this.defaultFrom = options.defaultFrom;
    this.unknownMailerParkMs = options.unknownMailerParkMs ?? DEFAULT_PARK_MS;
    this.maxUnknownMailerParks = options.maxUnknownMailerParks ?? DEFAULT_MAX_PARKS;

    this.queue.define(DELIVER_JOB, (payload, context) =>
      this.deliver(payload as unknown as DeliverPayload, context),
    );
  }

  /**
   * Define an email template by name.
   *
   * The template is a function of its params, so the concrete `to`/`subject`/
   * `from`/`headers` only exist once it runs. They are validated for header
   * injection at deliver time (see {@link deliver}) — and again at the transport
   * edge — rather than here, where there is nothing concrete to check yet.
   */
  define<P extends JsonValue>(name: string, build: (params: P) => Email | Promise<Email>): this {
    this.builders.set(name, build as Builder);

    return this;
  }

  /** Queue an email for delivery. Returns the job id. */
  async send<P extends JsonValue>(
    name: string,
    params: P,
    options: { maxAttempts?: number } = {},
  ): Promise<number> {
    return this.queue.enqueue(DELIVER_JOB, { mailer: name, params }, options);
  }

  // Runs inside the worker: build → render → validate headers → hand to the transport.
  private async deliver(payload: DeliverPayload, context: JobContext): Promise<void> {
    const build = this.builders.get(payload.mailer);

    if (!build) {
      await this.parkUnknownMailer(payload);

      return;
    }

    const email = await build(payload.params);
    const html = await this.renderBody(email);
    const from = email.from ?? this.defaultFrom;

    assertNoInjection("to", email.to, "MAIL_INVALID_ADDRESS");
    assertNoInjection("subject", email.subject, "MAIL_INVALID_HEADER");

    if (from !== undefined) {
      assertNoInjection("from", from, "MAIL_INVALID_ADDRESS");
    }

    const headers = email.headers === undefined ? undefined : assertHeaders(email.headers);

    await this.transport.send({
      to: email.to,
      subject: email.subject,
      html,
      messageId: messageIdFor(context.job.id),
      ...(from === undefined ? {} : { from }),
      ...(email.text === undefined ? {} : { text: email.text }),
      ...(headers === undefined ? {} : { headers }),
    });
  }

  /**
   * Park an unknown-mailer job instead of retrying it in place.
   *
   * Deploy skew: an old worker can claim a job whose mailer only exists on the
   * *new* deploy. Throwing would burn this job's `maxAttempts` against a worker
   * that can never succeed, retiring a perfectly valid email to `failed`.
   * Instead we complete this job successfully and re-enqueue a delayed copy, so
   * any worker — old or new — gets another chance once the rollout settles. A
   * `parks` counter bounds the grace period: a mailer that was genuinely deleted
   * eventually fails loudly rather than parking forever.
   */
  private async parkUnknownMailer(payload: DeliverPayload): Promise<void> {
    const parks = (payload.parks ?? 0) + 1;

    if (parks > this.maxUnknownMailerParks) {
      throw new MailError(
        "MAIL_UNKNOWN_MAILER",
        `No mailer named "${payload.mailer}" after ${this.maxUnknownMailerParks} parks.`,
        { mailer: payload.mailer, parks },
      );
    }

    await this.queue.enqueue(
      DELIVER_JOB,
      { mailer: payload.mailer, params: payload.params, parks },
      // Parked jobs carry their own retry budget (the `parks` counter), so a
      // re-enqueued copy needs exactly one attempt: park again, or fail loudly.
      { delayMs: this.unknownMailerParkMs, maxAttempts: 1 },
    );
  }

  private async renderBody(email: Email): Promise<string> {
    if (email.html !== undefined) {
      return email.html;
    }

    if (email.react !== undefined) {
      if (!this.render) {
        throw new MailError(
          "MAIL_NO_RENDERER",
          "A `react` email needs a `render` function (e.g. react-email).",
        );
      }

      return this.render(email.react);
    }

    throw new MailError("MAIL_EMPTY_BODY", "An email must provide `html` or `react`.");
  }
}

/** Derive the stable, retry-invariant message id from a delivery job's id. */
export function messageIdFor(jobId: number): string {
  return `keel-mail-${jobId}`;
}

/** Reject CR or LF anywhere in a header-bound value. */
export function assertNoInjection(
  field: string,
  value: string,
  code: "MAIL_INVALID_ADDRESS" | "MAIL_INVALID_HEADER",
): void {
  if (/[\r\n]/.test(value)) {
    throw new MailError(code, `\`${field}\` must not contain CR or LF (header injection).`, {
      field,
    });
  }
}

/** Validate every header name and value; returns the headers unchanged. */
export function assertHeaders(headers: Record<string, string>): Record<string, string> {
  for (const [name, value] of Object.entries(headers)) {
    assertNoInjection(`header name ${name}`, name, "MAIL_INVALID_HEADER");
    assertNoInjection(`header ${name}`, value, "MAIL_INVALID_HEADER");
  }

  return headers;
}

interface DeliverPayload {
  readonly mailer: string;
  readonly params: JsonValue;
  readonly parks?: number;
}
