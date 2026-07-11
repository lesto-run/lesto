import { LestoError } from "@lesto/errors";

import { assertHeaders, assertNoInjection, type MailTransport, type RenderedEmail } from "./mailer";

/**
 * A minimal, dependency-light SMTP transport.
 *
 * **Node-only** — it speaks raw TCP/TLS over `node:net` / `node:tls`. It does
 * NOT run on Cloudflare Workers (no raw sockets there); use
 * {@link createFetchProviderTransport} on the edge.
 *
 * Implements just enough of RFC 5321 to deliver one message: `EHLO`,
 * optional `STARTTLS`, optional `AUTH LOGIN`, then `MAIL FROM` / `RCPT TO` /
 * `DATA`. Delivery is at-least-once (see {@link MailTransport}); the message
 * carries the job-derived `messageId` as its `Message-ID` header so a relay or
 * downstream provider can dedupe retries.
 */

export type SmtpErrorCode =
  | "MAIL_TRANSPORT_SMTP_PROTOCOL"
  | "MAIL_TRANSPORT_SMTP_AUTH"
  | "MAIL_TRANSPORT_SMTP_CONNECTION"
  | "MAIL_TRANSPORT_SMTP_TIMEOUT";

export class SmtpTransportError extends LestoError<SmtpErrorCode> {
  constructor(code: SmtpErrorCode, message: string, details?: Record<string, unknown>) {
    super(code, message, details);

    this.name = "SmtpTransportError";
  }
}

/** The slice of a socket the SMTP client drives — satisfied by net/tls sockets. */
export interface SmtpSocket {
  write(data: string): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "close", listener: () => void): void;
  removeAllListeners(): void;
  end(): void;
}

export interface SmtpAuth {
  readonly user: string;
  readonly pass: string;
}

export interface SmtpTransportConfig {
  readonly host: string;
  readonly port: number;

  /** Upgrade the plaintext connection with STARTTLS before AUTH. Default true. */
  readonly secure?: boolean;

  readonly auth?: SmtpAuth;

  /** Hostname announced in EHLO. Defaults to "localhost". */
  readonly ehloName?: string;

  /**
   * Fail the send if the server does not reply to a step of the dialogue within
   * this many ms. Defaults to 20_000.
   *
   * Keep it comfortably below the queue's job visibility window (30_000ms by
   * default in `@lesto/queue`): a stalled server must fail the send — and
   * release the worker — BEFORE the visibility deadline lapses, or the queue
   * reclaims the still-"running" job and delivers it a SECOND time. The timeout
   * is what turns an at-least-once stall into a clean retry instead of a
   * guaranteed duplicate send.
   */
  readonly timeoutMs?: number;

  /**
   * Opens the initial (plaintext) connection. Injectable so tests drive a fake
   * socket; defaults to `node:net`.
   */
  readonly connect?: (host: string, port: number) => Promise<SmtpSocket>;

  /**
   * Upgrades an open socket to TLS for STARTTLS. Injectable for tests; defaults
   * to `node:tls`.
   */
  readonly upgrade?: (socket: SmtpSocket, host: string) => Promise<SmtpSocket>;
}

/** Create a Node SMTP {@link MailTransport}. */
export function createSmtpTransport(config: SmtpTransportConfig): MailTransport {
  const secure = config.secure ?? true;
  const ehloName = config.ehloName ?? "localhost";
  const connect = config.connect ?? nodeConnect;
  const upgrade = config.upgrade ?? nodeUpgrade;
  const timeoutMs = config.timeoutMs ?? 20_000;

  return {
    async send(email: RenderedEmail): Promise<void> {
      validate(email);

      let socket = await connect(config.host, config.port);
      const conn = new SmtpConnection(socket, timeoutMs);

      try {
        await conn.expect(220);
        await conn.command(`EHLO ${ehloName}`, 250);

        if (secure) {
          await conn.command("STARTTLS", 220);
          socket = await upgrade(socket, config.host);
          conn.rebind(socket);
          await conn.command(`EHLO ${ehloName}`, 250);
        }

        if (config.auth) {
          await authenticate(conn, config.auth);
        }

        const from = email.from ?? config.auth?.user ?? ehloName;

        await conn.command(`MAIL FROM:<${addressOnly(from)}>`, 250);
        await conn.command(`RCPT TO:<${addressOnly(email.to)}>`, 250);
        await conn.command("DATA", 354);
        await conn.command(buildMessage(email, from), 250);
        await conn.command("QUIT", 221);
      } finally {
        socket.removeAllListeners();
        socket.end();
      }
    },
  };
}

// Re-validate at the transport edge: a transport may be handed a RenderedEmail
// by anything, so it never trusts the mailer to have guarded the headers.
function validate(email: RenderedEmail): void {
  assertNoInjection("to", email.to, "MAIL_INVALID_ADDRESS");
  assertNoInjection("subject", email.subject, "MAIL_INVALID_HEADER");

  if (email.from !== undefined) {
    assertNoInjection("from", email.from, "MAIL_INVALID_ADDRESS");
  }

  if (email.headers !== undefined) {
    assertHeaders(email.headers);
  }
}

async function authenticate(conn: SmtpConnection, auth: SmtpAuth): Promise<void> {
  try {
    await conn.command("AUTH LOGIN", 334);
    await conn.command(base64(auth.user), 334);
    await conn.command(base64(auth.pass), 235);
  } catch (error) {
    // `command` only ever throws SmtpTransportError, so `error` is always an Error.
    throw new SmtpTransportError("MAIL_TRANSPORT_SMTP_AUTH", "SMTP authentication failed.", {
      cause: (error as Error).message,
    });
  }
}

/** One in-flight SMTP dialogue over a single socket. */
class SmtpConnection {
  private socket: SmtpSocket;

  private buffer = "";

  private pending:
    | {
        resolve: (line: string) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  private failure: Error | undefined;

  private readonly timeoutMs: number;

  constructor(socket: SmtpSocket, timeoutMs: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.bind();
  }

  /** Swap in the upgraded (TLS) socket after STARTTLS. */
  rebind(socket: SmtpSocket): void {
    this.socket = socket;
    this.buffer = "";
    this.bind();
  }

  private bind(): void {
    this.socket.on("data", (chunk) => {
      this.buffer += chunk.toString();

      // SMTP is strictly request-response, so a reply is only consumed once a
      // reader is waiting for it. With no reader pending the bytes stay buffered
      // for the next `readLine` to drain — never dropped (that is what makes the
      // lost-wakeup guard in `readLine` sound).
      if (!this.pending) {
        return;
      }

      const line = this.takeReply();

      if (line === undefined) {
        return;
      }

      const settle = this.pending;
      this.pending = undefined;
      clearTimeout(settle.timer);
      settle.resolve(line);
    });

    this.socket.on("error", (error) => {
      this.failure = error;

      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(error);
        this.pending = undefined;
      }
    });
  }

  /**
   * Take a complete reply off the buffer, or `undefined` if one has not fully
   * landed. A reply is complete once a final `NNN <text>` status line ends the
   * buffer; the whole buffer (including any earlier continuation lines of a
   * multiline reply) is returned and cleared.
   */
  private takeReply(): string | undefined {
    if (!/(^|\n)(\d{3}) [^\n]*\r?\n$/.test(this.buffer)) {
      return undefined;
    }

    const line = this.buffer;
    this.buffer = "";

    return line;
  }

  /** Wait for the next complete reply line and return it. */
  async readLine(): Promise<string> {
    if (this.failure) {
      throw new SmtpTransportError("MAIL_TRANSPORT_SMTP_CONNECTION", this.failure.message);
    }

    // A reply may already be sitting in the buffer: a fast server can put its
    // next line on the wire the instant it sees our command, so the `data`
    // event that carried it can fire while no reader is pending (buffered, not
    // dropped). Drain that first — parking a waiter for a reply that has already
    // arrived is the lost-wakeup deadlock, a wait that nothing ever wakes.
    const buffered = this.takeReply();

    if (buffered !== undefined) {
      return buffered;
    }

    return new Promise<string>((resolve, reject) => {
      // Bound the wait. A server that accepts the connection then stalls must
      // not hold us open indefinitely: a queued send runs inside the worker's
      // visibility window, and a dialogue that hangs past it gets reclaimed and
      // delivered a second time. Failing the read with a coded error releases
      // the worker first, so a stall is a clean retry, never a duplicate send.
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(
          new SmtpTransportError(
            "MAIL_TRANSPORT_SMTP_TIMEOUT",
            `SMTP server did not reply within ${this.timeoutMs}ms.`,
            { timeoutMs: this.timeoutMs },
          ),
        );
      }, this.timeoutMs);

      this.pending = { resolve, reject, timer };
    });
  }

  /** Read the next reply and assert its status code. */
  async expect(code: number): Promise<string> {
    const line = await this.readLine();
    const status = Number(line.trimStart().slice(0, 3));

    if (status !== code) {
      throw new SmtpTransportError(
        "MAIL_TRANSPORT_SMTP_PROTOCOL",
        `Expected SMTP ${code}, got: ${line.trim()}`,
        { expected: code, line: line.trim() },
      );
    }

    return line;
  }

  /** Send one command, then assert the reply code. */
  async command(line: string, code: number): Promise<string> {
    this.socket.write(`${line}\r\n`);

    return this.expect(code);
  }
}

// DEFERRED (out of scope for the F15 data-integrity pass; tracked for a
// follow-up — see docs/reviews/2026-07-10-build-vs-buy-portfolio-review.md):
// this builder does not yet do RFC 2047 encoded-words for non-ASCII headers,
// declare a Content-Transfer-Encoding / negotiate 8BITMIME, wrap lines at the
// 998-octet limit (RFC 5321 §4.5.3.1.6), support implicit TLS on :465, or emit
// a Date header. A relay generally supplies its own Date, but the rest are real
// interop gaps that a Nodemailer-backed transport behind this facade would close.
function buildMessage(email: RenderedEmail, from: string): string {
  const headers: string[] = [
    `From: ${from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    `Message-ID: <${email.messageId}>`,
    "MIME-Version: 1.0",
  ];

  for (const [name, value] of Object.entries(email.headers ?? {})) {
    headers.push(`${name}: ${value}`);
  }

  let body: string;

  if (email.text !== undefined) {
    const boundary = `lesto-${email.messageId}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      email.text,
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      email.html,
      `--${boundary}--`,
    ].join("\r\n");
  } else {
    headers.push('Content-Type: text/html; charset="utf-8"');
    body = email.html;
  }

  // Assemble, then fix the body line by line for the wire:
  //   1. A blank line separates the header block from the body (RFC 5322 §2.1) —
  //      without it a client folds the body into the headers.
  //   2. Every line ends with CRLF (RFC 5321 §2.3.8) — a bare LF/CR is illegal in
  //      DATA, and react-email's plain-text render emits LF. Normalize so a
  //      rendered body never reaches a strict relay half-terminated.
  //   3. Dot-stuffing: a body line that is just "." would otherwise end DATA early.
  const message = `${headers.join("\r\n")}\r\n\r\n${body}`
    .replace(/\r\n|\r|\n/g, "\r\n")
    .replace(/\n\./g, "\n..");

  return `${message}\r\n.`;
}

function addressOnly(value: string): string {
  const match = /<([^>]+)>/.exec(value);

  return match ? match[1]! : value.trim();
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

/** The slices of `node:net` / `node:tls` the defaults touch — injectable for tests. */
export interface NetModule {
  createConnection(options: { host: string; port: number }): NodeSocket;
}

export interface TlsModule {
  connect(options: { socket: NodeSocket; servername: string }): NodeSocket;
}

interface NodeSocket {
  once(event: "error", listener: (error: Error) => void): void;
  once(event: string, listener: () => void): void;
  removeListener(event: "error", listener: (error: Error) => void): void;
  setEncoding(encoding: "utf8"): void;
}

/** Load `node:net`. Importing it opens no socket; isolated so tests can cover it. */
export function loadNet(): Promise<NetModule> {
  return import("node:net") as unknown as Promise<NetModule>;
}

/** Load `node:tls`. Importing it opens no socket; isolated so tests can cover it. */
export function loadTls(): Promise<TlsModule> {
  return import("node:tls") as unknown as Promise<TlsModule>;
}

/**
 * Default plaintext connect over `node:net`. The `net` module loader is a
 * parameter so tests inject a fake socket; production uses {@link loadNet}.
 */
export async function nodeConnect(
  host: string,
  port: number,
  load: () => Promise<NetModule> = loadNet,
): Promise<SmtpSocket> {
  const net = await load();

  return new Promise<SmtpSocket>((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const onError = (error: Error): void => {
      reject(new SmtpTransportError("MAIL_TRANSPORT_SMTP_CONNECTION", error.message));
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      socket.setEncoding("utf8");
      resolve(socket as unknown as SmtpSocket);
    });
  });
}

/** Default STARTTLS upgrade over `node:tls`. The `tls` module is injectable for tests. */
export async function nodeUpgrade(
  socket: SmtpSocket,
  host: string,
  load: () => Promise<TlsModule> = loadTls,
): Promise<SmtpSocket> {
  const tls = await load();

  return new Promise<SmtpSocket>((resolve, reject) => {
    const secure = tls.connect({ socket: socket as unknown as NodeSocket, servername: host });
    const onError = (error: Error): void => {
      reject(new SmtpTransportError("MAIL_TRANSPORT_SMTP_CONNECTION", error.message));
    };
    secure.once("error", onError);
    secure.once("secureConnect", () => {
      secure.removeListener("error", onError);
      secure.setEncoding("utf8");
      resolve(secure as unknown as SmtpSocket);
    });
  });
}
