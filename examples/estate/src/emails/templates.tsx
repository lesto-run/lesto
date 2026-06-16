/**
 * Estate's transactional email templates — real react-email components.
 *
 * react-email renders ordinary React components (`<Html>`, `<Button>`, `<Text>`…
 * from `@react-email/components`) into the table-based, inline-styled HTML that
 * survives Gmail, Outlook, and Apple Mail. These are the exact `.tsx` templates a
 * production Keel app ships; estate renders them through `@react-email/render` in
 * its identity mailer ({@link createDemoMailer}) so the demo dogfoods the real
 * email pipeline rather than a string stub.
 */

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactElement, ReactNode } from "react";

/** A shared shell so both emails wear one look (and there is one place to restyle). */
function EmailLayout({
  preview,
  children,
}: {
  preview: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={body}>
        <Container style={container}>{children}</Container>
      </Body>
    </Html>
  );
}

/** A call-to-action button, with the link spelled out for clients that strip buttons. */
function Action({ href, label }: { href: string; label: string }): ReactElement {
  return (
    <Section style={center}>
      <Button href={href} style={button}>
        {label}
      </Button>
      <Hr style={hr} />
      <Text style={muted}>Or paste this link into your browser:</Text>
      <Text style={link}>{href}</Text>
    </Section>
  );
}

export interface EmailProps {
  /** The signed, single-use link the recipient clicks. */
  readonly url: string;
}

/** Sent when a new account must confirm its email address. */
export function VerifyEmail({ url }: EmailProps): ReactElement {
  return (
    <EmailLayout preview="Confirm your email to finish setting up your estate account">
      <Heading style={heading}>Confirm your email</Heading>
      <Text style={text}>
        Welcome to estate. Confirm this address to activate your account and start touring listings.
      </Text>
      <Action href={url} label="Verify email" />
    </EmailLayout>
  );
}

/** Sent when someone asks to reset a forgotten password. */
export function ResetPasswordEmail({ url }: EmailProps): ReactElement {
  return (
    <EmailLayout preview="Reset your estate password">
      <Heading style={heading}>Reset your password</Heading>
      <Text style={text}>
        We received a request to reset your password. This link expires in an hour — ignore this
        email if it wasn’t you.
      </Text>
      <Action href={url} label="Reset password" />
    </EmailLayout>
  );
}

// --- styles: plain objects, the react-email convention (inlined at render) ---

const body: CSSProperties = {
  backgroundColor: "#f4f4f5",
  fontFamily: "-apple-system, Segoe UI, Helvetica, Arial, sans-serif",
};

const container: CSSProperties = {
  margin: "0 auto",
  padding: "32px",
  maxWidth: "480px",
  backgroundColor: "#ffffff",
  borderRadius: "8px",
};

const center: CSSProperties = { textAlign: "center" };

const heading: CSSProperties = { fontSize: "20px", fontWeight: 600, color: "#18181b" };

const text: CSSProperties = { fontSize: "15px", lineHeight: "24px", color: "#3f3f46" };

const button: CSSProperties = {
  backgroundColor: "#18181b",
  color: "#ffffff",
  borderRadius: "6px",
  padding: "12px 20px",
  fontSize: "14px",
  textDecoration: "none",
};

const hr: CSSProperties = { borderColor: "#e4e4e7", margin: "20px 0" };

const muted: CSSProperties = { fontSize: "13px", color: "#71717a", margin: "0" };

const link: CSSProperties = { fontSize: "13px", color: "#2563eb", wordBreak: "break-all" };
