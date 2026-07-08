import { describe, expect, it } from "vitest";

import { CloudflareEmailError, createCloudflareEmailTransport, MailError } from "../src/index";

import type { CloudflareEmailBinding, CloudflareEmailMessage, RenderedEmail } from "../src/index";

const base = (): RenderedEmail => ({
  to: "ada@example.com",
  subject: "Hello",
  html: "<p>Hi</p>",
  from: "hi@app.com",
  messageId: "lesto-mail-9",
});

/** A binding that records the last message it was asked to send. */
function recordingBinding(): CloudflareEmailBinding & { readonly sent: CloudflareEmailMessage[] } {
  const sent: CloudflareEmailMessage[] = [];

  return {
    sent,
    send: async (message: CloudflareEmailMessage): Promise<unknown> => {
      sent.push(message);

      return { messageId: "cf-generated" };
    },
  };
}

/** A binding that rejects every send with `error`. */
function throwingBinding(error: unknown): CloudflareEmailBinding {
  return {
    send: async (): Promise<unknown> => {
      throw error;
    },
  };
}

describe("createCloudflareEmailTransport", () => {
  it("sends the structured message through the binding, bridging a bare `from`", async () => {
    const binding = recordingBinding();
    const transport = createCloudflareEmailTransport({ binding });

    await transport.send({ ...base(), text: "Hi", headers: { "List-Unsubscribe": "<u>" } });

    expect(binding.sent).toEqual([
      {
        to: "ada@example.com",
        from: { email: "hi@app.com" },
        subject: "Hello",
        html: "<p>Hi</p>",
        text: "Hi",
        headers: { "List-Unsubscribe": "<u>" },
      },
    ]);
  });

  it('bridges a `"Name <addr>"` from into `{ email, name }`', async () => {
    const binding = recordingBinding();
    const transport = createCloudflareEmailTransport({ binding });

    await transport.send({ ...base(), from: "Ada Lovelace <ada@example.com>" });

    expect(binding.sent[0]?.from).toEqual({ email: "ada@example.com", name: "Ada Lovelace" });
  });

  it('treats an empty-name `"<addr>"` as a bare address (no name)', async () => {
    const binding = recordingBinding();
    const transport = createCloudflareEmailTransport({ binding });

    await transport.send({ ...base(), from: "<ada@example.com>" });

    expect(binding.sent[0]?.from).toEqual({ email: "ada@example.com" });
  });

  it("omits text and headers when absent", async () => {
    const binding = recordingBinding();
    const transport = createCloudflareEmailTransport({ binding });

    await transport.send(base());

    const sent = binding.sent[0]!;
    expect(sent).not.toHaveProperty("text");
    expect(sent).not.toHaveProperty("headers");
  });

  it("falls back to `defaultFrom` when the email omits `from`", async () => {
    const binding = recordingBinding();
    const transport = createCloudflareEmailTransport({
      binding,
      defaultFrom: "App <hi@app.com>",
    });

    const { from: _dropped, ...withoutFrom } = base();
    await transport.send(withoutFrom);

    expect(binding.sent[0]?.from).toEqual({ email: "hi@app.com", name: "App" });
  });

  it("throws MAIL_TRANSPORT_CF_NO_SENDER when neither email nor config supplies a from", async () => {
    const binding = recordingBinding();
    const transport = createCloudflareEmailTransport({ binding });

    const { from: _dropped, ...withoutFrom } = base();
    await expect(transport.send(withoutFrom)).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_CF_NO_SENDER",
    });
    // fail-closed: nothing was handed to the binding.
    expect(binding.sent).toEqual([]);
  });

  it("wraps a binding rejection (Error) as MAIL_TRANSPORT_CF_REJECTED with the cause", async () => {
    const transport = createCloudflareEmailTransport({
      binding: throwingBinding(new Error("domain not onboarded")),
    });

    await expect(transport.send(base())).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_CF_REJECTED",
      details: { cause: "domain not onboarded" },
    });
  });

  it("stringifies a non-Error binding rejection into the cause", async () => {
    const transport = createCloudflareEmailTransport({ binding: throwingBinding("nope") });

    const error = await transport.send(base()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudflareEmailError);
    expect((error as CloudflareEmailError).details).toEqual({ cause: "nope" });
  });

  it("refuses header injection in `to` (CRLF) before touching the binding", async () => {
    const binding = recordingBinding();
    const transport = createCloudflareEmailTransport({ binding });

    await expect(transport.send({ ...base(), to: "a@b\r\nbcc: c@d" })).rejects.toBeInstanceOf(
      MailError,
    );
    expect(binding.sent).toEqual([]);
  });

  it("refuses injection in `subject`, `from`, and header values", async () => {
    const transport = createCloudflareEmailTransport({ binding: recordingBinding() });

    await expect(transport.send({ ...base(), subject: "x\ny" })).rejects.toMatchObject({
      code: "MAIL_INVALID_HEADER",
    });
    await expect(transport.send({ ...base(), from: "x\ny <a@b>" })).rejects.toMatchObject({
      code: "MAIL_INVALID_ADDRESS",
    });
    await expect(
      transport.send({ ...base(), headers: { "X-Bad": "line1\r\nline2" } }),
    ).rejects.toMatchObject({ code: "MAIL_INVALID_HEADER" });
  });
});
