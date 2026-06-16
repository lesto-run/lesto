/**
 * Estate's `IdentityMailer` — renders the react-email templates to real HTML.
 *
 * A public demo has no SMTP server, so instead of putting bytes on the wire this
 * records every rendered message in an in-memory `outbox` (and logs a one-line
 * preview). The RENDER path is the production one: `@react-email/render` turns
 * the `.tsx` templates into cross-client HTML exactly as a deployed app would.
 * Swapping this recorder for a `@keel/mail` transport (SMTP or fetch-provider) is
 * all that stands between the demo and really sending — the templates and the
 * render call do not change.
 */

import { render } from "@react-email/render";

import type { IdentityMailer } from "@keel/identity";
import type { ReactElement } from "react";

import { ResetPasswordEmail, VerifyEmail } from "./templates";

/** One rendered message the demo "sent" — the HTML is the real react-email output. */
export interface SentEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
}

export interface DemoMailer extends IdentityMailer {
  /** Every message rendered so far, newest last — for preview and tests. */
  readonly outbox: readonly SentEmail[];
}

/**
 * Build the demo's mailer. `log` defaults to a no-op so tests and the static
 * build stay quiet; the serve path can pass `console.log` to narrate deliveries.
 */
export function createDemoMailer(log: (line: string) => void = () => {}): DemoMailer {
  const outbox: SentEmail[] = [];

  const deliver = async (to: string, subject: string, message: ReactElement): Promise<void> => {
    const html = await render(message);
    outbox.push({ to, subject, html });
    log(`mail → ${to}: ${subject}`);
  };

  return {
    outbox,
    sendVerificationEmail: ({ to, url }) =>
      deliver(to, "Confirm your email", <VerifyEmail url={url} />),
    sendPasswordResetEmail: ({ to, url }) =>
      deliver(to, "Reset your password", <ResetPasswordEmail url={url} />),
  };
}
