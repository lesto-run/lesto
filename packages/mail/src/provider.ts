import { VoloError } from "@volo/errors";

import { assertHeaders, assertNoInjection, type MailTransport, type RenderedEmail } from "./mailer";

/**
 * A fetch-based HTTP-provider transport (Resend / SES-HTTP-API-shaped).
 *
 * **Workers-compatible** — it uses only the global `fetch` and no Node builtins,
 * so the same code delivers on Cloudflare Workers and on Node. Use this on the
 * edge; use {@link createSmtpTransport} when you must speak SMTP from a Node
 * server.
 *
 * Delivery is at-least-once (see {@link MailTransport}). The job-derived
 * `messageId` is sent as an `Idempotency-Key` header (and in the JSON body) so
 * an idempotent provider collapses retried sends into a single delivered
 * message. The request shape is intentionally generic and mappable: a
 * `mapRequest` hook lets you reshape the body for a specific provider.
 */

export type FetchProviderErrorCode =
  | "MAIL_TRANSPORT_PROVIDER_REJECTED"
  | "MAIL_TRANSPORT_PROVIDER_UNREACHABLE";

export class FetchProviderError extends VoloError<FetchProviderErrorCode> {
  constructor(code: FetchProviderErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "FetchProviderError";
  }
}

/** The default JSON body shape (Resend-compatible). */
export interface ProviderRequestBody {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly headers?: Record<string, string>;
  readonly messageId: string;
}

export interface FetchProviderConfig {
  /** Full URL of the provider's send endpoint (e.g. `https://api.resend.com/emails`). */
  readonly endpoint: string;

  /** Bearer token. Sent as `Authorization: Bearer <apiKey>`. */
  readonly apiKey: string;

  /** Fallback sender when an email omits `from`. */
  readonly defaultFrom?: string;

  /** Reshape the default body for a specific provider's API. */
  readonly mapRequest?: (body: ProviderRequestBody) => unknown;

  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

/** Create a Workers-compatible fetch-provider {@link MailTransport}. */
export function createFetchProviderTransport(config: FetchProviderConfig): MailTransport {
  const doFetch = config.fetch ?? globalThis.fetch;

  return {
    async send(email: RenderedEmail): Promise<void> {
      validate(email);

      const from = email.from ?? config.defaultFrom;

      if (from === undefined) {
        throw new FetchProviderError(
          "MAIL_TRANSPORT_PROVIDER_REJECTED",
          "No `from` address: set the email's `from` or the transport `defaultFrom`.",
        );
      }

      const body: ProviderRequestBody = {
        from,
        to: email.to,
        subject: email.subject,
        html: email.html,
        messageId: email.messageId,
        ...(email.text === undefined ? {} : { text: email.text }),
        ...(email.headers === undefined ? {} : { headers: email.headers }),
      };

      const payload = config.mapRequest ? config.mapRequest(body) : body;

      let response: Response;

      try {
        response = await doFetch(config.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
            "idempotency-key": email.messageId,
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        throw new FetchProviderError(
          "MAIL_TRANSPORT_PROVIDER_UNREACHABLE",
          "The mail provider could not be reached.",
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }

      if (!response.ok) {
        const detail = await safeText(response);

        throw new FetchProviderError(
          "MAIL_TRANSPORT_PROVIDER_REJECTED",
          `The mail provider rejected the message (HTTP ${response.status}).`,
          { status: response.status, body: detail },
        );
      }
    },
  };
}

function validate(email: RenderedEmail): void {
  assertNoInjection("to", email.to, "MAIL_INVALID_ADDRESS");
  assertNoInjection("subject", email.subject, "MAIL_INVALID_HEADER");

  if (email.from !== undefined) {
    assertNoInjection("from", email.from, "MAIL_INVALID_ADDRESS");
  }

  if (email.headers !== undefined) {
    assertHeaders(email.headers);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}
