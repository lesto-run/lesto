/**
 * The one email this app sends, registered on a {@link Mailer}.
 *
 * `@lesto/mail` never sends inline — `template` registers a named builder and
 * returns a typed sender whose `.send(params)` enqueues a `@lesto/queue` job; a
 * worker (or, on the edge, an in-request drain) renders it and hands the result
 * to the transport. The template supplies `html` AND `text` so the transport
 * emits a `multipart/alternative` — the deliverability default.
 */

import type { Mailer, MailTemplate } from "@lesto/mail";

// A `type` (not `interface`) so it satisfies `mailer.template`'s `JsonValue`
// constraint: an interface has no implicit index signature (it could be
// declaration-merged), so `{ [key: string]: JsonValue }` rejects it; a type
// literal with all-JSON properties is accepted.
export type WelcomeParams = {
  readonly to: string;
};

/** Register the `welcome` template and return its typed sender. Called once at boot. */
export function defineWelcome(mailer: Mailer): MailTemplate<WelcomeParams> {
  return mailer.template<WelcomeParams>("welcome", ({ to }) => ({
    to,
    subject: "Welcome to Lesto",
    html:
      `<h1>Welcome to Lesto</h1>` +
      `<p>This email was sent from a Cloudflare Worker via Cloudflare Email Sending.</p>`,
    text: "Welcome to Lesto\n\nThis email was sent from a Cloudflare Worker via Cloudflare Email Sending.",
  }));
}
