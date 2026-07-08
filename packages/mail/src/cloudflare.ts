import { LestoError } from "@lesto/errors";

import { assertHeaders, assertNoInjection, type MailTransport, type RenderedEmail } from "./mailer";

/**
 * A transport that delivers through Cloudflare's Email Sending `send_email`
 * Worker binding.
 *
 * **Workers-only** — it drives the platform's `env.EMAIL` binding, which exists
 * only inside a Cloudflare Worker. Use this on the edge; use
 * {@link import("./provider").createFetchProviderTransport} when you want an
 * HTTP provider (Resend / SES) that also runs on the edge, and
 * {@link import("./smtp").createSmtpTransport} when you must speak SMTP from a
 * Node server. Delivery is at-least-once (see {@link MailTransport}); the
 * structured Email Sending API assigns its own Message-ID and exposes no
 * idempotency key, so a retried job may deliver twice — the same at-least-once
 * floor the SMTP transport has, and acceptable for transactional mail.
 *
 * The `from` domain must be **onboarded** to Cloudflare Email Sending first
 * (`wrangler email sending enable <domain>` + the SPF/DKIM/DMARC DNS records);
 * until then the binding rejects the send and this transport surfaces it as a
 * coded {@link CloudflareEmailError} so the queue retries per the transport
 * contract rather than silently dropping the mail.
 */

export type CloudflareEmailErrorCode =
  /** The binding rejected the send — includes "sender domain not onboarded". */
  | "MAIL_TRANSPORT_CF_REJECTED"
  /** Neither the email nor the transport supplied a `from` address. */
  | "MAIL_TRANSPORT_CF_NO_SENDER";

export class CloudflareEmailError extends LestoError<CloudflareEmailErrorCode> {
  constructor(code: CloudflareEmailErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "CloudflareEmailError";
  }
}

/** A sender/recipient the `send_email` binding accepts, as `{ email, name? }`. */
export interface CloudflareEmailAddress {
  readonly email: string;
  readonly name?: string;
}

/**
 * The structured message the Email Sending binding's `send` accepts
 * (developers.cloudflare.com/email-service/api/send-emails/workers-api).
 */
export interface CloudflareEmailMessage {
  readonly to: string;
  readonly from: CloudflareEmailAddress;
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
  readonly headers?: Record<string, string>;
}

/**
 * The slice of Cloudflare's `send_email` binding this transport drives.
 *
 * Declared here rather than depending on `@cloudflare/workers-types` so
 * `@lesto/mail` stays dependency-light and node-buildable (the same local-slice
 * convention `@lesto/cloudflare`'s `d1.ts` uses for the D1 binding). This matches
 * the CURRENT Cloudflare Email Sending Workers API
 * (`env.EMAIL.send({ to, from, subject, html?, text?, headers? })`); note the
 * installed `@cloudflare/workers-types` may still type `send_email` as the older
 * raw-MIME `SendEmail` shape, which is exactly why depending on it is avoided.
 */
export interface CloudflareEmailBinding {
  send(message: CloudflareEmailMessage): Promise<unknown>;
}

export interface CloudflareEmailConfig {
  /** The Worker's `send_email` binding, typically `env.EMAIL`. */
  readonly binding: CloudflareEmailBinding;

  /** Fallback sender when an email omits `from` (e.g. `"App <hi@app.com>"`). */
  readonly defaultFrom?: string;
}

/** Create a Cloudflare-Email-Sending {@link MailTransport}. */
export function createCloudflareEmailTransport(config: CloudflareEmailConfig): MailTransport {
  return {
    async send(email: RenderedEmail): Promise<void> {
      validate(email);

      const fromRaw = email.from ?? config.defaultFrom;

      if (fromRaw === undefined) {
        throw new CloudflareEmailError(
          "MAIL_TRANSPORT_CF_NO_SENDER",
          "No `from` address: set the email's `from` or the transport `defaultFrom`.",
        );
      }

      // Validate the RESOLVED sender, so `config.defaultFrom` is injection-checked
      // too — not just an explicit `email.from`.
      assertNoInjection("from", fromRaw, "MAIL_INVALID_ADDRESS");

      const message: CloudflareEmailMessage = {
        to: email.to,
        from: parseAddress(fromRaw),
        subject: email.subject,
        html: email.html,
        ...(email.text === undefined ? {} : { text: email.text }),
        ...(email.headers === undefined ? {} : { headers: email.headers }),
      };

      try {
        await config.binding.send(message);
      } catch (error) {
        throw new CloudflareEmailError(
          "MAIL_TRANSPORT_CF_REJECTED",
          "Cloudflare Email Sending rejected the message (is the sender domain onboarded?).",
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    },
  };
}

function validate(email: RenderedEmail): void {
  assertNoInjection("to", email.to, "MAIL_INVALID_ADDRESS");
  assertNoInjection("subject", email.subject, "MAIL_INVALID_HEADER");

  // `from` is validated after it is resolved against `config.defaultFrom` (see
  // `send`), so it is deliberately not checked here.
  if (email.headers !== undefined) {
    assertHeaders(email.headers);
  }
}

/**
 * Bridge Lesto's string `from` to the binding's `{ email, name? }` shape.
 *
 * `"Ada Lovelace <ada@example.com>"` → `{ email, name }`; a bare
 * `"ada@example.com"` (or an empty-name `"<ada@example.com>"`) → `{ email }`.
 */
function parseAddress(raw: string): CloudflareEmailAddress {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(raw);

  if (match === null) {
    return { email: raw.trim() };
  }

  // A successful match always captures both groups — group 2 (`[^>]+`) requires
  // at least one char and group 1 (`.*?`) is non-optional — so this cast is a
  // fact of the regex, not a hope (and avoids `?? ""` dead branches).
  const [, name, email] = match as unknown as [string, string, string];

  return name.trim().length > 0
    ? { email: email.trim(), name: name.trim() }
    : { email: email.trim() };
}
