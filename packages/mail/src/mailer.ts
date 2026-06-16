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
 *
 * ## Delivery observability (opt-in hooks)
 *
 * `onDelivered` / `onFailed` fire once per attempt so an operator can answer
 * "did the password reset go out?" without reading the queue. Their payloads
 * carry only operational identifiers — mailer name, job id, attempt number (and
 * an error code on failure). **No recipient address, subject, or body ever
 * reaches a hook**, so wiring them to a log/metrics/OTLP sink can never leak
 * PII. A hook that throws is swallowed (a broken metrics sink must not fail a
 * delivery or trigger a spurious retry); see {@link Mailer.deliver}.
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
   * Plain-text alternative. When present alongside `html`, transports emit a
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

/**
 * What a delivery-observability hook learns about an attempt.
 *
 * Deliberately **PII-free**: a hook gets the mailer name, the queue job id, and
 * the attempt number — never the recipient address, subject, or body. That is
 * the whole point: these are safe to forward to a log line, a counter, or an
 * OTLP span without a privacy review. `jobId` ties an event back to the queue
 * row; `attempt` distinguishes the first try from an at-least-once retry of the
 * same job.
 */
export interface DeliveryEvent {
  /** The registered mailer name (e.g. `"verify"`). Not the recipient. */
  readonly mailerName: string;

  /** The @keel/queue job id carrying this delivery. */
  readonly jobId: number;

  /** 1-based attempt number; > 1 means an at-least-once retry. */
  readonly attempt: number;
}

/** A {@link DeliveryEvent} plus the coded reason an attempt failed. */
export interface DeliveryFailure extends DeliveryEvent {
  /**
   * The {@link MailErrorCode} when the failure was a coded mail error, else
   * `"MAIL_TRANSPORT_ERROR"` for any other throw (a transport reject, a thrown
   * builder, etc.). Branch on this, never on a message string.
   */
  readonly code: MailErrorCode | "MAIL_TRANSPORT_ERROR";
}

/**
 * Fires once after the transport accepts an email. The hook is observational —
 * its return value is ignored and a throw is swallowed, so a broken sink can
 * neither fail nor retry a delivery.
 */
export type OnDelivered = (event: DeliveryEvent) => void | Promise<void>;

/**
 * Fires once when an attempt fails (a thrown builder/render, a header-injection
 * refusal, or a transport reject) — *before* the error propagates to the queue
 * for its retry decision. Swallowing a throw here keeps a broken sink from
 * masking the real failure.
 */
export type OnFailed = (failure: DeliveryFailure) => void | Promise<void>;

/**
 * What a renderer may hand back: HTML, or HTML paired with a plain-text
 * alternative. Returning `text` is how a renderer (e.g. react-email's
 * `render(el, { plainText: true })`) auto-fills the multipart text part — the
 * mailer drops it into {@link RenderedEmail.text} so the transport emits
 * `multipart/alternative` with no per-template effort.
 */
export interface RenderedBody {
  readonly html: string;
  readonly text?: string;
}

export type EmailRenderer = (
  element: unknown,
) => string | RenderedBody | Promise<string | RenderedBody>;

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

  /**
   * Observability seam: called once after the transport accepts an email. The
   * {@link DeliveryEvent} carries only operational ids (mailer name, job id,
   * attempt) — never the recipient or body — so it is safe to forward to logs,
   * metrics, or an OTLP span. A throw here is swallowed.
   */
  readonly onDelivered?: OnDelivered;

  /**
   * Observability seam: called once when an attempt fails, before the error
   * propagates to the queue. The {@link DeliveryFailure} adds a coded reason to
   * the PII-free {@link DeliveryEvent}. A throw here is swallowed.
   */
  readonly onFailed?: OnFailed;
}

const DEFAULT_PARK_MS = 60_000;
const DEFAULT_MAX_PARKS = 10;

/**
 * A type-safe sender bound to one template's params — the typed face of
 * {@link Mailer.template}. `send`'s argument is exactly the builder's param
 * type, so a wrong-shaped payload is a *compile* error. The open
 * {@link Mailer.send} stays string-keyed (it must, for deploy-skew dynamic
 * dispatch to an as-yet-undefined mailer); this is the typed path for the
 * common case where the call site knows the template.
 */
export interface MailTemplate<P extends JsonValue> {
  /** The registered mailer name. */
  readonly name: string;

  /** Queue this template with type-checked params. Returns the job id. */
  send(params: P, options?: { maxAttempts?: number }): Promise<number>;
}

export class Mailer {
  private readonly queue: Queue;

  private readonly transport: MailTransport;

  private readonly render: EmailRenderer | undefined;

  private readonly defaultFrom: string | undefined;

  private readonly unknownMailerParkMs: number;

  private readonly maxUnknownMailerParks: number;

  private readonly onDelivered: OnDelivered | undefined;

  private readonly onFailed: OnFailed | undefined;

  private readonly builders = new Map<string, Builder>();

  constructor(options: MailerOptions) {
    this.queue = options.queue;
    this.transport = options.transport;
    this.render = options.render;
    this.defaultFrom = options.defaultFrom;
    this.unknownMailerParkMs = options.unknownMailerParkMs ?? DEFAULT_PARK_MS;
    this.maxUnknownMailerParks = options.maxUnknownMailerParks ?? DEFAULT_MAX_PARKS;
    this.onDelivered = options.onDelivered;
    this.onFailed = options.onFailed;

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

  /**
   * Define a template AND get back a {@link MailTemplate} sender for it.
   *
   *   const welcome = mailer.template(
   *     "welcome",
   *     (p: { to: string; name: string }) => ({ to: p.to, subject: "Hi", react: <W {...p} /> }),
   *   );
   *   welcome.send({ to: "ada@x.com", name: "Ada" }); // typed — wrong shape won't compile
   *
   * The runtime is exactly {@link define} + {@link send}; the value it adds is the
   * type binding between the template's params and what you send it.
   */
  template<P extends JsonValue>(
    name: string,
    build: (params: P) => Email | Promise<Email>,
  ): MailTemplate<P> {
    this.define(name, build);

    return {
      name,
      send: (params, options) => this.send(name, params, options),
    };
  }

  // Runs inside the worker: build → render → validate headers → hand to the
  // transport, wrapped in the delivery-observability envelope.
  private async deliver(payload: DeliverPayload, context: JobContext): Promise<void> {
    const event: DeliveryEvent = {
      mailerName: payload.mailer,
      jobId: context.job.id,
      attempt: context.attempt,
    };

    let delivered = false;

    try {
      // `attempt` returns false for a *successful* park (no email went out, the
      // job is deliberately re-enqueued) so neither hook fires; true once the
      // transport accepts. A genuine failure — including the finally-exhausted
      // unknown mailer — throws and is reported below.
      delivered = await this.attempt(payload, context.job.id);
    } catch (error) {
      // Report, then re-throw so the queue still makes its retry decision. The
      // failure payload carries only the coded reason — no recipient or body.
      await this.notify(this.onFailed, { ...event, code: failureCode(error) });

      throw error;
    }

    if (delivered) {
      await this.notify(this.onDelivered, event);
    }
  }

  /**
   * Do one delivery attempt. Returns `true` once the transport accepts the
   * email; `false` for a successful unknown-mailer park (no email sent, job
   * re-enqueued). Throws on a real failure — including an exhausted park.
   */
  private async attempt(payload: DeliverPayload, jobId: number): Promise<boolean> {
    const build = this.builders.get(payload.mailer);

    if (!build) {
      await this.parkUnknownMailer(payload);

      return false;
    }

    await this.deliverEmail(build, payload.params, jobId);

    return true;
  }

  // The delivery work itself: build the email, render it, validate every
  // header-bound value, and hand a {@link RenderedEmail} to the transport.
  private async deliverEmail(build: Builder, params: JsonValue, jobId: number): Promise<void> {
    const email = await build(params);
    const rendered = await this.renderBody(email);
    const from = email.from ?? this.defaultFrom;

    // An explicit `email.text` wins; otherwise a renderer-supplied plain-text
    // alternative (react-email's `plainText` render) auto-fills the multipart
    // text part — so deliverability improves with zero per-template work.
    const text = email.text ?? rendered.text;

    assertNoInjection("to", email.to, "MAIL_INVALID_ADDRESS");
    assertNoInjection("subject", email.subject, "MAIL_INVALID_HEADER");

    if (from !== undefined) {
      assertNoInjection("from", from, "MAIL_INVALID_ADDRESS");
    }

    const headers = email.headers === undefined ? undefined : assertHeaders(email.headers);

    await this.transport.send({
      to: email.to,
      subject: email.subject,
      html: rendered.html,
      messageId: messageIdFor(jobId),
      ...(from === undefined ? {} : { from }),
      ...(text === undefined ? {} : { text }),
      ...(headers === undefined ? {} : { headers }),
    });
  }

  /**
   * Run an observability hook, swallowing any throw.
   *
   * An observability sink is best-effort: a broken metrics call must never fail
   * a real delivery or, worse, mask the actual failure that `onFailed` is
   * reporting. So the hook's result is awaited but its rejection is discarded.
   */
  private async notify<E>(
    hook: ((event: E) => void | Promise<void>) | undefined,
    event: E,
  ): Promise<void> {
    if (hook === undefined) return;

    try {
      await hook(event);
    } catch {
      // Intentionally ignored — see method doc.
    }
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

  private async renderBody(email: Email): Promise<RenderedBody> {
    if (email.html !== undefined) {
      return { html: email.html };
    }

    if (email.react !== undefined) {
      if (!this.render) {
        throw new MailError(
          "MAIL_NO_RENDERER",
          "A `react` email needs a `render` function (e.g. react-email).",
        );
      }

      // The hook may return just HTML or `{ html, text }`; normalize to the latter.
      const rendered = await this.render(email.react);

      return typeof rendered === "string" ? { html: rendered } : rendered;
    }

    throw new MailError("MAIL_EMPTY_BODY", "An email must provide `html` or `react`.");
  }
}

/** Derive the stable, retry-invariant message id from a delivery job's id. */
export function messageIdFor(jobId: number): string {
  return `keel-mail-${jobId}`;
}

/**
 * Classify a thrown delivery error into a stable code for {@link OnFailed}.
 *
 * A coded {@link MailError} (empty body, no renderer, header injection, the
 * exhausted unknown-mailer) surfaces its own `code`; anything else — a transport
 * reject, a thrown builder — collapses to `"MAIL_TRANSPORT_ERROR"`. The hook can
 * thus branch on a closed set without ever parsing a message string.
 */
export function failureCode(error: unknown): MailErrorCode | "MAIL_TRANSPORT_ERROR" {
  return error instanceof MailError ? error.code : "MAIL_TRANSPORT_ERROR";
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
