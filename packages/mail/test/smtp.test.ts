import { describe, expect, it } from "vitest";

import {
  createSmtpTransport,
  loadNet,
  loadTls,
  nodeConnect,
  nodeUpgrade,
  SmtpTransportError,
} from "../src/index";

import type { NetModule, RenderedEmail, SmtpSocket, TlsModule } from "../src/index";

/**
 * A scripted fake SMTP server socket. For each command the client writes, it
 * replies with the next line in `replies`. The greeting (220) is delivered on
 * the next microtask after a reader attaches, mimicking a server banner.
 */
class FakeSocket implements SmtpSocket {
  written: string[] = [];

  ended = false;

  private dataListener: ((chunk: string) => void) | undefined;

  private errorListener: ((error: Error) => void) | undefined;

  private queue: string[];

  private readonly greets: boolean;

  /**
   * @param replies one server reply per client command, in order.
   * @param greets  whether the socket emits its first reply (a banner) as soon
   *                as a reader attaches, before any write. The initial plaintext
   *                socket greets; a STARTTLS-upgraded socket does not.
   */
  constructor(replies: string[], greets = true) {
    this.queue = [...replies];
    this.greets = greets;
  }

  write(data: string): void {
    this.written.push(data);
    this.emitNext();
  }

  on(event: "data" | "error" | "close", listener: (arg: never) => void): void {
    if (event === "data") {
      this.dataListener = listener as (chunk: string) => void;

      if (this.greets) {
        queueMicrotask(() => this.emitNext());
      }
    } else if (event === "error") {
      this.errorListener = listener as (error: Error) => void;
    }
  }

  removeAllListeners(): void {
    this.dataListener = undefined;
    this.errorListener = undefined;
  }

  end(): void {
    this.ended = true;
  }

  fail(error: Error): void {
    this.errorListener?.(error);
  }

  private emitNext(): void {
    const next = this.queue.shift();

    if (next !== undefined && this.dataListener) {
      queueMicrotask(() => this.dataListener?.(next));
    }
  }
}

const base = (): Omit<RenderedEmail, "from"> => ({
  to: "ada@example.com",
  subject: "Hello",
  html: "<p>Hi</p>",
  messageId: "lesto-mail-7",
});

// A reply per command, delivered as Buffers and optionally split into partial
// chunks. Exposes hooks to inject an unsolicited line (no pending reader).
function scriptedSocket(options: { split?: boolean; strayBefore?: boolean }): {
  socket: SmtpSocket;
} {
  let dataListener: ((chunk: Buffer | string) => void) | undefined;
  const replies = [
    "250 ok\r\n", // EHLO
    "250 ok\r\n", // MAIL FROM
    "250 ok\r\n", // RCPT TO
    "354 go\r\n", // DATA
    "250 queued\r\n", // body
    "221 bye\r\n", // QUIT
  ];
  let writes = 0;

  const deliver = (reply: string): void => {
    if (options.split && reply.length > 4) {
      // Two chunks: the first lacks a complete status line (regex-false branch).
      dataListener?.(Buffer.from(reply.slice(0, 4)));
      dataListener?.(Buffer.from(reply.slice(4)));
    } else {
      dataListener?.(Buffer.from(reply));
    }
  };

  const socket = {
    write(): void {
      const reply = replies[writes] ?? "250 ok\r\n";
      writes += 1;
      queueMicrotask(() => {
        deliver(reply);

        // After the first command's reply resolved (pending now cleared), fire
        // an unsolicited complete line synchronously — exercises the
        // `!pending` early-return without corrupting the next read.
        if (options.strayBefore && writes === 1) {
          dataListener?.(Buffer.from("250 unsolicited\r\n"));
        }
      });
    },
    on(event: string, listener: (arg: never) => void): void {
      if (event === "data") {
        dataListener = listener as (chunk: Buffer | string) => void;
        queueMicrotask(() => deliver("220 ready\r\n"));
      }
    },
    removeAllListeners(): void {},
    end(): void {},
  } as unknown as SmtpSocket;

  return { socket };
}

describe("createSmtpTransport", () => {
  it("delivers over a plaintext (non-secure) connection without auth", async () => {
    const fake = new FakeSocket([
      "220 ready\r\n",
      "250 ok\r\n", // EHLO
      "250 ok\r\n", // MAIL FROM
      "250 ok\r\n", // RCPT TO
      "354 go\r\n", // DATA
      "250 queued\r\n", // body
      "221 bye\r\n", // QUIT
    ]);

    const transport = createSmtpTransport({
      host: "mail.test",
      port: 25,
      secure: false,
      ehloName: "client.test",
      connect: async () => fake,
    });

    await transport.send({ ...base(), from: "from@app.com" });

    expect(fake.written.some((line) => line.startsWith("EHLO client.test"))).toBe(true);
    expect(fake.written.some((line) => line.startsWith("MAIL FROM:<from@app.com>"))).toBe(true);
    expect(fake.written.some((line) => line.startsWith("RCPT TO:<ada@example.com>"))).toBe(true);
    expect(fake.written.some((line) => line.includes("Message-ID: <lesto-mail-7>"))).toBe(true);
    expect(fake.ended).toBe(true);
  });

  it("separates the header block from the body with a blank line (RFC 5322 §2.1)", async () => {
    const fake = new FakeSocket([
      "220 ready\r\n",
      "250 ok\r\n", // EHLO
      "250 ok\r\n", // MAIL FROM
      "250 ok\r\n", // RCPT TO
      "354 go\r\n", // DATA
      "250 queued\r\n", // body
      "221 bye\r\n", // QUIT
    ]);

    const transport = createSmtpTransport({
      host: "mail.test",
      port: 25,
      secure: false,
      connect: async () => fake,
    });

    await transport.send({ ...base(), from: "from@app.com" });

    // The DATA payload is the one write carrying the HTML body. The last header
    // must be followed by a blank line (CRLF CRLF) before the body — a single
    // CRLF folds the body into the headers and clients mis-parse the message.
    const message = fake.written.find((line) => line.includes("<p>Hi</p>"));
    expect(message).toContain('Content-Type: text/html; charset="utf-8"\r\n\r\n<p>Hi</p>');
  });

  it("performs STARTTLS and AUTH LOGIN, and a multipart body for text+html", async () => {
    const plain = new FakeSocket([
      "220 ready\r\n",
      "250 ok\r\n", // EHLO
      "220 go-tls\r\n", // STARTTLS
    ]);
    const secure = new FakeSocket(
      [
        "250 ok\r\n", // EHLO (post-TLS)
        "334 user\r\n", // AUTH LOGIN
        "334 pass\r\n", // username
        "235 authed\r\n", // password
        "250 ok\r\n", // MAIL FROM
        "250 ok\r\n", // RCPT TO
        "354 go\r\n", // DATA
        "250 queued\r\n", // body
        "221 bye\r\n", // QUIT
      ],
      false,
    );

    const transport = createSmtpTransport({
      host: "mail.test",
      port: 587,
      auth: { user: "u@app.com", pass: "secret" },
      connect: async () => plain,
      upgrade: async () => secure,
    });

    await transport.send({ ...base(), text: "Hi", from: "u@app.com" });

    expect(plain.written.some((l) => l.startsWith("STARTTLS"))).toBe(true);
    expect(secure.written.some((l) => l.startsWith("AUTH LOGIN"))).toBe(true);
    // base64("u@app.com") and base64("secret") sent on the wire.
    expect(secure.written).toContain(`${Buffer.from("u@app.com").toString("base64")}\r\n`);
    const body = secure.written.find((l) => l.includes("multipart/alternative"));
    expect(body).toBeDefined();
    expect(body).toContain("text/plain");
    expect(body).toContain("text/html");
    // A blank line ends the header block before the first MIME boundary.
    expect(body).toContain('boundary="lesto-lesto-mail-7"\r\n\r\n--lesto-lesto-mail-7');
  });

  it("falls back to the auth user as From when none is given", async () => {
    const fake = new FakeSocket([
      "220 ready\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);

    const transport = createSmtpTransport({
      host: "mail.test",
      port: 25,
      secure: false,
      connect: async () => fake,
    });
    // No auth and no from → falls back to ehloName ("localhost").
    await transport.send(base());

    expect(fake.written.some((l) => l.startsWith("MAIL FROM:<localhost>"))).toBe(true);
  });

  it("dot-stuffs a body line that is only a dot", async () => {
    const fake = new FakeSocket([
      "220 ready\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => fake,
    });

    await transport.send({ ...base(), from: "f@app.com", html: "line1\n.\nline2" });
    const dataPayload = fake.written.find((l) => l.includes("line1"));
    // The lone-dot line is escaped to "..", CRLF-framed like every other line.
    expect(dataPayload).toContain("\r\n..\r\n");
  });

  it("normalizes bare-LF body lines to CRLF on the wire (RFC 5321 §2.3.8)", async () => {
    const fake = new FakeSocket([
      "220 ready\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => fake,
    });

    // react-email's plain-text render emits LF-only line breaks; they must reach
    // the relay as CRLF, with no bare LF surviving anywhere in the message.
    await transport.send({
      ...base(),
      from: "f@app.com",
      text: "one\ntwo",
      html: "<p>a</p>\n<p>b</p>",
    });
    const data = fake.written.find((l) => l.includes("one"));
    expect(data).toBeDefined();
    expect(/[^\r]\n/.test(data!)).toBe(false);
    expect(data).toContain("one\r\ntwo");
    expect(data).toContain("<p>a</p>\r\n<p>b</p>");
  });

  it("extracts the bare address from an angle-bracketed From", async () => {
    const fake = new FakeSocket([
      "220 ready\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => fake,
    });

    await transport.send({ ...base(), from: "App <app@x.com>" });
    expect(fake.written.some((l) => l.startsWith("MAIL FROM:<app@x.com>"))).toBe(true);
  });

  it("writes configured extra headers into the message", async () => {
    const fake = new FakeSocket([
      "220 ready\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ]);
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => fake,
    });

    await transport.send({
      ...base(),
      from: "f@app.com",
      headers: { "List-Unsubscribe": "<https://x/u>" },
    });
    expect(fake.written.some((l) => l.includes("List-Unsubscribe: <https://x/u>"))).toBe(true);
  });

  it("raises a coded protocol error on an unexpected reply code", async () => {
    const fake = new FakeSocket(["220 ready\r\n", "500 nope\r\n"]);
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => fake,
    });

    await expect(transport.send({ ...base(), from: "f@app.com" })).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_PROTOCOL",
    });
  });

  it("wraps an auth failure in a coded auth error", async () => {
    const plain = new FakeSocket(["220 ready\r\n", "250 ok\r\n", "220 go-tls\r\n"]);
    const secure = new FakeSocket(
      [
        "250 ok\r\n", // EHLO
        "334 user\r\n", // AUTH LOGIN
        "334 pass\r\n",
        "535 bad creds\r\n", // password rejected
      ],
      false,
    );
    const transport = createSmtpTransport({
      host: "h",
      port: 587,
      auth: { user: "u", pass: "bad" },
      connect: async () => plain,
      upgrade: async () => secure,
    });

    await expect(transport.send({ ...base(), from: "u@app.com" })).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_AUTH",
    });
  });

  it("surfaces a socket error as a coded connection error", async () => {
    // A socket that errors instead of greeting: the error listener (bound by the
    // connection) rejects the in-flight readLine.
    const failing: SmtpSocket = {
      write(): void {},
      on(event, listener): void {
        if (event === "error") {
          queueMicrotask(() => (listener as (e: Error) => void)(new Error("ECONNRESET")));
        }
      },
      removeAllListeners(): void {},
      end(): void {},
    };
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => failing,
    });

    await expect(transport.send({ ...base(), from: "f@app.com" })).rejects.toThrow("ECONNRESET");
  });

  it("readLine throws coded when the socket already failed before reading", async () => {
    // Error arrives, then a fresh readLine is attempted (no pending promise to
    // reject) — the stored failure surfaces as a coded connection error.
    let errorListener: ((e: Error) => void) | undefined;
    const failing: SmtpSocket = {
      write(): void {
        errorListener?.(new Error("late reset"));
      },
      on(event, listener): void {
        if (event === "data") {
          // Greet so expect(220) resolves, letting the next command write & fail.
          queueMicrotask(() => (listener as (c: string) => void)("220 ready\r\n"));
        } else if (event === "error") {
          errorListener = listener as (e: Error) => void;
        }
      },
      removeAllListeners(): void {},
      end(): void {},
    };
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => failing,
    });

    await expect(transport.send({ ...base(), from: "f@app.com" })).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_CONNECTION",
    });
  });

  it("re-validates header injection at the transport edge", async () => {
    const fake = new FakeSocket(["220 ready\r\n"]);
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => fake,
    });

    await expect(
      transport.send({ ...base(), to: "a@x.com\r\nBcc: evil@x.com", from: "f@app.com" }),
    ).rejects.toMatchObject({ code: "MAIL_INVALID_ADDRESS" });
  });

  it("re-validates a bad from and bad headers at the transport edge", async () => {
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => new FakeSocket(["220 ready\r\n"]),
    });

    await expect(transport.send({ ...base(), from: "f@app.com\r\nEvil: 1" })).rejects.toMatchObject(
      { code: "MAIL_INVALID_ADDRESS" },
    );

    await expect(
      transport.send({ ...base(), from: "f@app.com", headers: { X: "bad\r\nY: 1" } }),
    ).rejects.toMatchObject({ code: "MAIL_INVALID_HEADER" });
  });
});

describe("createSmtpTransport — node default fallbacks", () => {
  it("falls back to the real nodeConnect when no connect is injected", async () => {
    const transport = createSmtpTransport({ host: "0.0.0.0", port: 1, secure: false });

    await expect(transport.send({ ...base(), from: "f@app.com" })).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_CONNECTION",
    });
  });

  it("falls back to the real nodeUpgrade for STARTTLS when no upgrade is injected", async () => {
    // A fake plaintext socket gets through STARTTLS; the default nodeUpgrade then
    // tries to TLS-wrap a non-socket and fails with a coded connection error.
    const plain = new FakeSocket(["220 ready\r\n", "250 ok\r\n", "220 go-tls\r\n"]);
    const transport = createSmtpTransport({
      host: "mail.test",
      port: 587,
      connect: async () => plain,
    });

    await expect(transport.send({ ...base(), from: "f@app.com" })).rejects.toBeDefined();
  });
});

describe("SmtpConnection data handling", () => {
  it("decodes Buffer chunks and reassembles a reply split across chunks", async () => {
    const { socket } = scriptedSocket({ split: true });
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => socket,
    });

    await transport.send({ ...base(), from: "f@app.com" });
  });

  it("discards a complete line that arrives with no reader pending", async () => {
    const { socket } = scriptedSocket({ strayBefore: true });
    const transport = createSmtpTransport({
      host: "h",
      port: 25,
      secure: false,
      connect: async () => socket,
    });

    await transport.send({ ...base(), from: "f@app.com" });
  });
});

describe("SmtpTransportError", () => {
  it("is coded and frozen", () => {
    const error = new SmtpTransportError("MAIL_TRANSPORT_SMTP_PROTOCOL", "boom", { a: 1 });
    expect(error.code).toBe("MAIL_TRANSPORT_SMTP_PROTOCOL");
    expect(error.name).toBe("SmtpTransportError");
    expect(Object.isFrozen(error.details)).toBe(true);
  });
});

describe("node socket factory defaults", () => {
  it("nodeConnect resolves a configured socket via an injected net module", async () => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const socket = {
      once(event: string, listener: (arg?: unknown) => void): void {
        handlers[event] = listener;
      },
      removeListener(): void {},
      setEncoding(): void {},
    };
    const net = {
      createConnection(): typeof socket {
        queueMicrotask(() => handlers.connect?.());

        return socket;
      },
    };

    const result = await nodeConnect("h", 25, async () => net as unknown as NetModule);
    expect(result).toBeDefined();
  });

  it("nodeConnect rejects with a coded connection error", async () => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const socket = {
      once(event: string, listener: (arg?: unknown) => void): void {
        handlers[event] = listener;
      },
      removeListener(): void {},
      setEncoding(): void {},
    };
    const net = {
      createConnection(): typeof socket {
        queueMicrotask(() => handlers.error?.(new Error("refused")));

        return socket;
      },
    };

    await expect(
      nodeConnect("h", 25, async () => net as unknown as NetModule),
    ).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_CONNECTION",
    });
  });

  it("nodeUpgrade resolves a TLS socket via an injected tls module", async () => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const secure = {
      once(event: string, listener: (arg?: unknown) => void): void {
        handlers[event] = listener;
      },
      removeListener(): void {},
      setEncoding(): void {},
    };
    const tls = {
      connect(): typeof secure {
        queueMicrotask(() => handlers.secureConnect?.());

        return secure;
      },
    };

    const result = await nodeUpgrade(
      {} as SmtpSocket,
      "h",
      async () => tls as unknown as TlsModule,
    );
    expect(result).toBeDefined();
  });

  it("loadNet and loadTls import the real node modules without opening a socket", async () => {
    const net = await loadNet();
    const tls = await loadTls();
    expect(typeof net.createConnection).toBe("function");
    expect(typeof tls.connect).toBe("function");
  });

  it("nodeConnect uses loadNet by default (no injected loader)", async () => {
    // Force the real default path; an unroutable port errors fast and is caught
    // as a coded connection error — no data leaves the host.
    await expect(nodeConnect("0.0.0.0", 1)).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_CONNECTION",
    });
  });

  it("nodeUpgrade rejects with a coded connection error", async () => {
    const handlers: Record<string, (arg?: unknown) => void> = {};
    const secure = {
      once(event: string, listener: (arg?: unknown) => void): void {
        handlers[event] = listener;
      },
      removeListener(): void {},
      setEncoding(): void {},
    };
    const tls = {
      connect(): typeof secure {
        queueMicrotask(() => handlers.error?.(new Error("tls fail")));

        return secure;
      },
    };

    await expect(
      nodeUpgrade({} as SmtpSocket, "h", async () => tls as unknown as TlsModule),
    ).rejects.toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_CONNECTION",
    });
  });
});
