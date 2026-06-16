/**
 * @keel/mail's SMTP transport, end-to-end over a real socket.
 *
 * The unit tests drive `createSmtpTransport` against a *mocked* socket — they
 * prove the protocol bytes are correct but never leave the process. This suite
 * stands up a throwaway in-process SMTP catcher ({@link SmtpSink}) on a
 * loopback TCP port and delivers a real message through it: the bytes cross the
 * socket, the handshake completes, and the catcher parses the envelope + DATA
 * block back out. That closes web-primitives item 1's "deliver through a local
 * SMTP sink" acceptance.
 *
 * The body under test is the real one: a `multipart/alternative` html+text
 * pair rendered from a react-email template (the same shape estate's verify
 * email ships), so we prove the rendered multipart lands intact on the wire.
 */

import { render } from "@react-email/render";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createSmtpTransport, messageIdFor, SmtpTransportError } from "@keel/mail";
import type { RenderedEmail } from "@keel/mail";

import { SmtpSink } from "./smtp-sink";
import { VerifyEmail } from "./email-templates";

/** SMTP forces CRLF on the wire; compare bodies on a newline-agnostic basis. */
function unixNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

let sink: SmtpSink;

beforeEach(async () => {
  sink = await SmtpSink.listen();
});

afterEach(async () => {
  await sink.close();
});

describe("createSmtpTransport over a real SMTP sink", () => {
  it("completes the EHLO handshake and delivers a multipart message intact", async () => {
    // Render the real react-email template to its html + text alternatives.
    const link = "https://app.test/auth/verify?token=signed.verify.token";
    const html = await render(VerifyEmail({ url: link }));
    const text = await render(VerifyEmail({ url: link }), { plainText: true });

    // Sanity: the renderer produced two genuinely different representations.
    expect(html).toContain("<");
    expect(text).not.toContain("<html");
    expect(text).toContain(link);

    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: sink.port,
      // No STARTTLS / AUTH: the sink speaks plaintext SMTP. The transport's
      // STARTTLS + AUTH paths are exercised by the mocked-socket unit tests; here
      // we prove the real plaintext delivery dialogue end-to-end.
      secure: false,
      ehloName: "keel.test",
    });

    const email: RenderedEmail = {
      to: "ada@example.com",
      from: "Estate <no-reply@estate.test>",
      subject: "Confirm your email",
      html,
      text,
      headers: { "Reply-To": "support@estate.test" },
      messageId: messageIdFor(4242),
    };

    await transport.send(email);

    const message = await sink.waitForMessage();

    // ---- the handshake actually happened ----
    expect(message.commands.some((c) => c === "EHLO keel.test")).toBe(true);
    expect(message.commands.some((c) => c.startsWith("MAIL FROM:<no-reply@estate.test>"))).toBe(
      true,
    );
    expect(message.commands.some((c) => c.startsWith("RCPT TO:<ada@example.com>"))).toBe(true);
    expect(message.commands).toContain("DATA");
    expect(message.commands).toContain("QUIT");

    // ---- the envelope the sink parsed off the wire ----
    expect(message.mailFrom).toBe("no-reply@estate.test");
    expect(message.rcptTo).toEqual(["ada@example.com"]);

    // ---- the message headers survived intact ----
    expect(message.data).toContain("To: ada@example.com");
    expect(message.data).toContain("Subject: Confirm your email");
    expect(message.data).toContain(`Message-ID: <${messageIdFor(4242)}>`);
    expect(message.data).toContain("Reply-To: support@estate.test");
    expect(message.data).toContain("MIME-Version: 1.0");

    // ---- the multipart/alternative body landed with BOTH parts ----
    const boundaryMatch = /boundary="([^"]+)"/.exec(message.data);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1]!;

    expect(message.data).toContain("Content-Type: multipart/alternative");
    expect(message.data).toContain("Content-Type: text/plain; charset=utf-8");
    expect(message.data).toContain("Content-Type: text/html; charset=utf-8");
    // The closing boundary proves the whole multipart envelope arrived, not a truncation.
    expect(message.data).toContain(`--${boundary}--`);

    // ---- both rendered bodies survived the wire byte-for-byte (modulo CRLF) ----
    // SMTP normalizes line endings to CRLF; compare on a newline-agnostic basis.
    expect(unixNewlines(message.data)).toContain(unixNewlines(text));
    // The html body's signed link is present and unescaped-as-rendered.
    expect(message.data).toContain(link);
  });

  it("surfaces a coded connection error when nothing is listening", async () => {
    // Snapshot the port, then close the sink so the address is dead: a transport
    // pointed at it can't connect — a real, observable failure surfaced as a
    // coded SmtpTransportError, not a raw socket error.
    const deadPort = sink.port;
    await sink.close();

    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: deadPort,
      secure: false,
    });

    await expect(
      transport.send({
        to: "ada@example.com",
        from: "no-reply@estate.test",
        subject: "Hi",
        html: "<p>hi</p>",
        messageId: messageIdFor(1),
      }),
    ).rejects.toBeInstanceOf(SmtpTransportError);

    // Re-open a sink so afterEach's close() has a live server to tear down.
    sink = await SmtpSink.listen();
  });
});
