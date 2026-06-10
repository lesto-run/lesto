import { KeelError } from "@keel/errors";
import type { JsonValue, Queue } from "@keel/queue";

/**
 * Mailers — define an email as a function of its params; send it by name.
 *
 * Delivery rides on @keel/queue: `send` enqueues a job, and a worker renders the
 * template and hands it to the transport. So retries, backoff, and deploy-safe
 * reclaim come for free, and the request path never blocks on SMTP.
 *
 * The template body is either a ready `html` string or a `react` element paired
 * with a `render` function — wire react-email's `render` and your components
 * become typed, prop-driven emails.
 */

const DELIVER_JOB = "keel.mail.deliver";

export type MailErrorCode = "MAIL_UNKNOWN_MAILER" | "MAIL_EMPTY_BODY" | "MAIL_NO_RENDERER";

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
  readonly html?: string;
  readonly react?: unknown;
}

export interface RenderedEmail {
  readonly to: string;
  readonly subject: string;
  readonly from?: string;
  readonly html: string;
}

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
}

export class Mailer {
  private readonly queue: Queue;

  private readonly transport: MailTransport;

  private readonly render: EmailRenderer | undefined;

  private readonly defaultFrom: string | undefined;

  private readonly builders = new Map<string, Builder>();

  constructor(options: MailerOptions) {
    this.queue = options.queue;
    this.transport = options.transport;
    this.render = options.render;
    this.defaultFrom = options.defaultFrom;

    this.queue.define(DELIVER_JOB, (payload) => this.deliver(payload as unknown as DeliverPayload));
  }

  /** Define an email template by name. */
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

  // Runs inside the worker: build → render → hand to the transport.
  private async deliver(payload: DeliverPayload): Promise<void> {
    const build = this.builders.get(payload.mailer);

    if (!build) {
      throw new MailError("MAIL_UNKNOWN_MAILER", `No mailer named "${payload.mailer}".`, {
        mailer: payload.mailer,
      });
    }

    const email = await build(payload.params);
    const html = await this.renderBody(email);
    const from = email.from ?? this.defaultFrom;

    await this.transport.send({
      to: email.to,
      subject: email.subject,
      html,
      ...(from === undefined ? {} : { from }),
    });
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

interface DeliverPayload {
  readonly mailer: string;
  readonly params: JsonValue;
}
