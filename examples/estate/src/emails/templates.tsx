/**
 * Estate's transactional email templates — pure content over the shared base.
 *
 * The chrome (shell, type, button) lives in {@link ./layout}; a template just
 * supplies its words. These are real `@react-email/components` rendered through
 * `@react-email/render` in the identity mailer ({@link createDemoMailer}), so the
 * demo dogfoods the real email pipeline rather than a string stub.
 */

import type { ReactElement } from "react";

import { EmailAction, EmailHeading, EmailLayout, EmailText } from "./layout";

export interface EmailProps {
  /** The signed, single-use link the recipient clicks. */
  readonly url: string;
}

/** Sent when a new account must confirm its email address. */
export function VerifyEmail({ url }: EmailProps): ReactElement {
  return (
    <EmailLayout preview="Confirm your email to finish setting up your estate account">
      <EmailHeading>Confirm your email</EmailHeading>
      <EmailText>
        Welcome to estate. Confirm this address to activate your account and start touring listings.
      </EmailText>
      <EmailAction href={url} label="Verify email" />
    </EmailLayout>
  );
}

/** Sent when someone asks to reset a forgotten password. */
export function ResetPasswordEmail({ url }: EmailProps): ReactElement {
  return (
    <EmailLayout preview="Reset your estate password">
      <EmailHeading>Reset your password</EmailHeading>
      <EmailText>
        We received a request to reset your password. This link expires in an hour — ignore this
        email if it wasn’t you.
      </EmailText>
      <EmailAction href={url} label="Reset password" />
    </EmailLayout>
  );
}
