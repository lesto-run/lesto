/**
 * The reusable email base — shell + styled primitives every estate email shares.
 *
 * The point: an app shouldn't re-hand-roll the table-based, inline-styled chrome
 * that survives Gmail/Outlook/Apple Mail for every message. Compose a template
 * from `<EmailLayout>` + `<EmailHeading>`/`<EmailText>`/`<EmailAction>` and it
 * inherits one consistent look with one place to restyle. These are ordinary
 * `@react-email/components` under the hood, so anything react-email offers still
 * drops in alongside them.
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

/** The outer shell: `<head>`, inbox preview text, and a centered card. */
export function EmailLayout({
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

/** The message title. */
export function EmailHeading({ children }: { children: ReactNode }): ReactElement {
  return <Heading style={heading}>{children}</Heading>;
}

/** A body paragraph. */
export function EmailText({ children }: { children: ReactNode }): ReactElement {
  return <Text style={text}>{children}</Text>;
}

/** A call-to-action button, with the link spelled out for clients that strip buttons. */
export function EmailAction({ href, label }: { href: string; label: string }): ReactElement {
  return (
    <Section style={center}>
      <Button href={href} style={button}>
        {label}
      </Button>
      <Hr style={hr} />
      <EmailText>Or paste this link into your browser:</EmailText>
      <Text style={link}>{href}</Text>
    </Section>
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

const link: CSSProperties = { fontSize: "13px", color: "#2563eb", wordBreak: "break-all" };
