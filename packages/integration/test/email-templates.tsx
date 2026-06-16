/**
 * react-email templates for the mail integration suite.
 *
 * These mirror estate's verify/reset templates ({@link
 * examples/estate/src/emails/templates.tsx}) but live here so the integration
 * package is self-contained and never imports from an example app. They render
 * through the real `@react-email/render`, so the suite exercises the production
 * render path (html + plain-text alternative) rather than a string stub.
 */

import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";
import type { CSSProperties, ReactElement, ReactNode } from "react";

interface EmailProps {
  /** The signed, single-use link the recipient clicks. */
  readonly url: string;
}

/** A minimal shared shell — head, inbox preview text, a centered card + CTA. */
function Shell({
  preview,
  heading,
  body,
  action,
  url,
}: {
  preview: string;
  heading: string;
  body: ReactNode;
  action: string;
  url: string;
}): ReactElement {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={page}>
        <Container style={card}>
          <Heading style={title}>{heading}</Heading>
          <Text style={text}>{body}</Text>
          <Button href={url} style={button}>
            {action}
          </Button>
          <Text style={text}>Or paste this link into your browser:</Text>
          <Text style={linkText}>{url}</Text>
        </Container>
      </Body>
    </Html>
  );
}

/** Sent when a new account must confirm its email address. */
export function VerifyEmail({ url }: EmailProps): ReactElement {
  return (
    <Shell
      preview="Confirm your email to finish setting up your account"
      heading="Confirm your email"
      body="Welcome. Confirm this address to activate your account."
      action="Verify email"
      url={url}
    />
  );
}

/** Sent when someone asks to reset a forgotten password. */
export function ResetPasswordEmail({ url }: EmailProps): ReactElement {
  return (
    <Shell
      preview="Reset your password"
      heading="Reset your password"
      body="We received a request to reset your password. This link expires in an hour."
      action="Reset password"
      url={url}
    />
  );
}

const page: CSSProperties = {
  backgroundColor: "#f4f4f5",
  fontFamily: "-apple-system, Segoe UI, Helvetica, Arial, sans-serif",
};

const card: CSSProperties = {
  margin: "0 auto",
  padding: "32px",
  maxWidth: "480px",
  backgroundColor: "#ffffff",
  borderRadius: "8px",
};

const title: CSSProperties = { fontSize: "20px", fontWeight: 600, color: "#18181b" };

const text: CSSProperties = { fontSize: "15px", lineHeight: "24px", color: "#3f3f46" };

const button: CSSProperties = {
  backgroundColor: "#18181b",
  color: "#ffffff",
  borderRadius: "6px",
  padding: "12px 20px",
  fontSize: "14px",
  textDecoration: "none",
};

const linkText: CSSProperties = { fontSize: "13px", color: "#2563eb", wordBreak: "break-all" };
