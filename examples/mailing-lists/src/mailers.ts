/**
 * The two mailer templates this app sends, registered on a {@link Mailer}.
 *
 * `@volo/mailing-lists` never renders email itself — it hands a job to a NAMED
 * mailer template and lets `@volo/mail` render + deliver it. So the names here
 * are a contract with the service wiring in `app.ts`:
 *
 *   - `"confirm"` is the `confirmationMailer.name` — the service enqueues it on
 *     `subscribe` with `{ to, confirmUrl }`, where `confirmUrl` is built from the
 *     pending subscriber's confirm token.
 *   - `"digest"` is the broadcast template — `broadcast(listId, "digest", { issue })`
 *     fans it out to every subscribed recipient. The service merges each
 *     recipient's `to` and (because `unsubscribeUrl` is configured) the
 *     `List-Unsubscribe` / `List-Unsubscribe-Post` `headers` into the params, so
 *     the template MUST spread `params.headers` into the email it returns — that
 *     is the documented contract that carries one-click unsubscribe through.
 *
 * Both templates supply `html` AND `text`: a multipart alternative is the
 * deliverability default (and exercises @volo/mail's CRLF-normalized multipart
 * body path), and the plain-text part is what a terminal mail client renders.
 */

import type { Mailer } from "@volo/mail";

/** Register this app's templates on the mailer. Called once at boot. */
export function defineMailers(mailer: Mailer): void {
  mailer.define<{ to: string; confirmUrl: string }>("confirm", ({ to, confirmUrl }) => ({
    to,
    subject: "Confirm your subscription",
    html:
      `<p>Thanks for signing up for the Weekly Digest.</p>` +
      `<p><a href="${confirmUrl}">Confirm your subscription</a> to start receiving it.</p>`,
    text: `Thanks for signing up. Confirm your subscription:\n${confirmUrl}`,
  }));

  mailer.define<{ to: string; issue: number; headers?: Record<string, string> }>(
    "digest",
    ({ to, issue, headers }) => ({
      to,
      subject: `Weekly Digest — Issue #${issue}`,
      html: `<h1>Issue #${issue}</h1><p>Thanks for reading the Weekly Digest.</p>`,
      text: `Weekly Digest — Issue #${issue}\n\nThanks for reading.`,
      // The List-Unsubscribe headers the service injected per recipient. Spread
      // verbatim — dropping them costs Gmail/Yahoo bulk-sender deliverability.
      ...(headers === undefined ? {} : { headers }),
    }),
  );
}
