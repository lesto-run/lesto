import { LestoError } from "@lesto/errors";

import {
  assertHeaders,
  assertMessageId,
  assertNoInjection,
  type MailTransport,
  type RenderedEmail,
} from "./mailer";

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
  /**
   * Detach a previously-added `data` listener by reference — used by
   * {@link SmtpConnection.rebind} to drop the pre-upgrade socket's `data` handler
   * across a STARTTLS swap WITHOUT the blanket {@link removeAllListeners} that
   * would also strip the still-live socket's own (and the TLS transport's)
   * handlers. Both `net.Socket` and `tls.TLSSocket` expose it (EventEmitter#off).
   */
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
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
   * Fail the send if the WHOLE server dialogue does not complete within this
   * many ms. Defaults to 20_000.
   *
   * This is a single whole-dialogue budget, not a per-step timeout: the clock
   * starts when the connection opens and every reply-wait is capped to the time
   * still left (see {@link SmtpConnection.readLine}). A per-step timer only
   * bounds each step, so a server that answers just under the limit on step
   * after step — the SMTP greylisting/tarpitting profile — could accumulate
   * unbounded total time with no single step ever tripping; the budget closes
   * that hole.
   *
   * Keep it comfortably below the queue's job visibility window (30_000ms by
   * default in `@lesto/queue`): a stalled — or merely slow-but-progressing —
   * server must fail the send, and release the worker, BEFORE the visibility
   * deadline lapses, or the queue reclaims the still-"running" job and delivers
   * it a SECOND time. The budget is what turns an at-least-once stall into a
   * clean retry instead of a guaranteed duplicate send.
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

      // Fix the whole-dialogue deadline HERE — before the dial — then thread the
      // same instant through connect, STARTTLS, and every reply-wait. The TCP
      // dial and the STARTTLS handshake are the two network ops on the default
      // send path that the read loop cannot time (neither is an SMTP reply), and
      // left unbounded a SYN black-hole blocks on the OS TCP timeout (~75-127s)
      // and a hung handshake never returns. Either one alone drags the send past
      // the queue's job-visibility window (30_000ms in `@lesto/queue`), so the
      // queue reclaims the still-"running" job and delivers it a SECOND time —
      // the exact duplicate-send hazard this budget exists to close. One deadline
      // spanning connect + STARTTLS + the dialogue is what guarantees the send
      // fails and releases the worker before visibility lapses: a clean retry,
      // never a duplicate. (Starting it before the dial is why the ctor takes the
      // deadline rather than computing its own from the moment the socket opens.)
      const deadline = Date.now() + timeoutMs;

      let socket = await openWithinDeadline(connect(config.host, config.port), deadline, timeoutMs);
      const conn = new SmtpConnection(socket, timeoutMs, deadline);

      try {
        await conn.expect(220);
        await conn.command(`EHLO ${ehloName}`, 250);

        if (secure) {
          await conn.command("STARTTLS", 220);
          socket = await openWithinDeadline(upgrade(socket, config.host), deadline, timeoutMs);
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

        // The DATA-body 250 COMMITS the message (RFC 5321 §4.2): the receiver has
        // accepted responsibility, so the send has ALREADY succeeded. QUIT is now
        // a courtesy — issue it best-effort and SWALLOW whatever happens to the
        // 221 (a withheld or slow reply, a socket error, or a relay that drops the
        // connection the instant it accepts — all common). Gating success on the
        // 221, as this once did, turned a post-commit hiccup into a REJECTED send,
        // and the at-least-once queue then re-delivers an already-accepted message:
        // a guaranteed DUPLICATE. Note a deadline that fires BEFORE this point
        // still rejects (nothing delivered → a clean retry) — only the post-commit
        // QUIT/221 is forgiven, and a post-250 connection close likewise resolves
        // as success here rather than surfacing as a reject.
        try {
          await conn.command("QUIT", 221);
        } catch {
          // Committed already — the QUIT/221 outcome must never fail the send.
        }
      } finally {
        socket.removeAllListeners();
        socket.end();
      }
    },
  };
}

/**
 * Bound a socket-opening network op — the TCP dial or the STARTTLS upgrade —
 * against the WHOLE-dialogue deadline the read loop already enforces, using a
 * PORTABLE promise-race rather than `socket.setTimeout`. {@link SmtpSocket}
 * deliberately exposes no `setTimeout`: a socket opened over the Cloudflare
 * sockets API (the edge shape this interface stays honest for) has no
 * node-style per-socket timer, so only a race over the op's OWN promise bounds
 * every transport the same way.
 *
 * Racing connect and STARTTLS against the same `deadline` is what keeps the
 * budget honest. It is the accumulated time across connect + upgrade + the
 * reply dialogue — not any single step — that has to stay under `timeoutMs`, so
 * a stall ANYWHERE fails the send and releases the queue worker before the
 * job's visibility window lapses. Bound only the reply-waits (as the first cut
 * did) and a hung dial or handshake still outlives the window, the queue
 * reclaims the still-"running" job, and it is delivered a second time.
 *
 * On a lost race the op is still in flight, so a socket it opens LATE would leak
 * — close it the moment it lands. A late op *rejection* needs no handling here:
 * it carries no socket, and `Promise.race` has already surfaced the timeout (and
 * kept the losing arm from becoming an unhandled rejection).
 */
async function openWithinDeadline(
  op: Promise<SmtpSocket>,
  deadline: number,
  timeoutMs: number,
): Promise<SmtpSocket> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        reject(
          new SmtpTransportError(
            "MAIL_TRANSPORT_SMTP_TIMEOUT",
            `SMTP dialogue did not complete within ${timeoutMs}ms.`,
            { timeoutMs },
          ),
        );
      },
      // Never negative: an op that starts with the budget already spent trips on
      // the next tick, exactly as a spent read-wait does.
      Math.max(0, deadline - Date.now()),
    );
  });

  const guarded = op.then((socket) => {
    if (timedOut) {
      socket.end();
    }

    return socket;
  });

  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    clearTimeout(timer);
  }
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

  // messageId is spliced raw into `Message-ID: <…>` AND the multipart boundary
  // (`boundary="lesto-<messageId>"`), so it must be a single injection-safe token.
  assertMessageId(email.messageId);
}

async function authenticate(conn: SmtpConnection, auth: SmtpAuth): Promise<void> {
  try {
    await conn.command("AUTH LOGIN", 334);
    await conn.command(base64(auth.user), 334);
    await conn.command(base64(auth.pass), 235);
  } catch (error) {
    // A TRANSIENT stall (the whole-dialogue deadline) or a dropped connection
    // during an AUTH step is NOT a credential failure — re-throw those UNCHANGED
    // so the queue treats them as retryable. Flattening a timeout into a
    // permanent MAIL_TRANSPORT_SMTP_AUTH lets a queue that drops "auth failed"
    // jobs DROP a deliverable message → a lost email. Only a genuine protocol /
    // credential rejection (e.g. a 535) is wrapped as a permanent auth error.
    if (
      error instanceof SmtpTransportError &&
      (error.code === "MAIL_TRANSPORT_SMTP_TIMEOUT" ||
        error.code === "MAIL_TRANSPORT_SMTP_CONNECTION")
    ) {
      throw error;
    }

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

  /**
   * The absolute deadline for the ENTIRE dialogue. It is computed in `send()`
   * BEFORE the dial and passed in (not derived here from the moment the socket
   * opens), so the one budget spans connect + STARTTLS + every reply-wait rather
   * than the replies alone — see {@link openWithinDeadline} for why the two
   * pre-dialogue network ops must share it. It is deliberately NOT reset on
   * {@link rebind}, so the STARTTLS upgrade spends the same budget. Each
   * reply-wait is capped to the time still left before this instant — see
   * {@link readLine} for why one whole-dialogue budget, not a fresh per-step
   * timer, is what keeps a slow server from outliving the queue's job-visibility
   * window.
   */
  private readonly deadline: number;

  constructor(socket: SmtpSocket, timeoutMs: number, deadline: number) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.deadline = deadline;
    this.bind();
  }

  /**
   * Swap in the upgraded (TLS) socket after STARTTLS.
   *
   * Detach ONLY our `data` handler from the pre-upgrade socket first. That socket
   * does not disappear — it becomes the TLS transport's underlying stream — so a
   * lingering `data` handler on it would append post-upgrade bytes (ciphertext, or
   * a late plaintext frame) into the SAME `this.buffer` the new socket feeds, and
   * mis-settle a waiting reply: a listener leak on every STARTTLS send at best, a
   * protocol mis-settle at worst.
   *
   * We deliberately leave `error`/`close` attached and NEVER `removeAllListeners()`.
   * Stripping the still-live underlying socket's `error` handler would turn any
   * later socket error into an unhandled `'error'` event — an uncaught exception
   * (process crash) that `send()`'s try/catch cannot catch — and a blanket
   * `removeAllListeners()` would additionally tear off the TLS transport's own
   * listeners on that socket. A stale `close`/`error` from the old socket is
   * instead neutralized by clearing `this.failure` below, so it can never make the
   * first post-upgrade read throw spuriously.
   */
  rebind(socket: SmtpSocket): void {
    this.socket.off("data", this.onData);
    this.socket = socket;
    this.buffer = "";
    this.failure = undefined;
    this.bind();
  }

  private bind(): void {
    this.socket.on("data", this.onData);
    this.socket.on("error", this.onError);
    this.socket.on("close", this.onClose);
  }

  /**
   * Consume arriving bytes and, once a full reply has landed AND a reader is
   * parked, settle it. SMTP is strictly request-response, so with no reader
   * pending the bytes stay buffered for the next `readLine` to drain — never
   * dropped (that is what makes the lost-wakeup guard in `readLine` sound).
   *
   * Stored as ONE stable reference (not a fresh closure per {@link bind}) so
   * {@link rebind} can `off()` exactly this handler off the pre-upgrade socket.
   */
  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString();

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
  };

  /** Record a socket error and wake any parked reader with it. */
  private readonly onError = (error: Error): void => {
    this.failure = error;
    this.wakePending(error);
  };

  /**
   * Settle a parked reader when the socket closes. A graceful FIN (the peer calls
   * `end()`) closes the connection WITHOUT an 'error' — e.g. a relay that hangs up
   * the instant it accepts the DATA body, withholding its 221. With only the
   * 'error' handler, the pending reply-wait would then sit idle until the
   * whole-dialogue deadline fires (a needless multi-second stall on a send that has
   * ALREADY committed). Settle it the moment the socket closes, using the same
   * `_CONNECTION` signal the RST path already produces: `send()`'s post-commit
   * QUIT/221 catch swallows it and resolves at once, and a close mid-dialogue fails
   * fast into a clean retry instead of waiting out the budget. Ordering is benign
   * in both races: an RST fires 'error' first (recording that more-specific
   * failure, which `??=` keeps), and a normal QUIT/221 close cannot reach here at
   * all — `send()`'s finally removes these listeners before it ends the socket.
   */
  private readonly onClose = (): void => {
    this.failure ??= new SmtpTransportError(
      "MAIL_TRANSPORT_SMTP_CONNECTION",
      "SMTP connection closed before the dialogue completed.",
    );
    this.wakePending(this.failure);
  };

  /**
   * Wake a parked {@link readLine} with a transport failure — a no-op when none
   * is parked (a close/error that lands between reads; the recorded `failure`
   * then fails the NEXT read fast). Shared by the 'error' and 'close' handlers so
   * the settle path is written, and covered, once.
   */
  private wakePending(error: Error): void {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
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
      // Bound the wait against ONE whole-dialogue deadline, not this step alone.
      // A send runs ~7 sequential reads (220/EHLO/MAIL/RCPT/DATA/body/QUIT, more
      // with AUTH). Arming a fresh full-length timer per read bounds each STEP
      // but leaves the TOTAL unbounded: a server that answers just under the
      // limit every time — precisely the SMTP greylisting/tarpitting profile —
      // drags the dialogue on for step * timeoutMs while no single step ever
      // trips. That accumulated total is the hazard: a queued send runs inside
      // the worker's visibility window, and a dialogue that outlives it gets
      // reclaimed and delivered a SECOND time. So cap each wait to the budget
      // still REMAINING before `deadline` (0 once it is spent, firing on the
      // next tick) — the whole dialogue can never outlast `timeoutMs`, and the
      // send fails and releases the worker before the visibility deadline,
      // turning a stall into a clean retry, never a duplicate send.
      const remaining = Math.max(0, Math.min(this.timeoutMs, this.deadline - Date.now()));
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(
          new SmtpTransportError(
            "MAIL_TRANSPORT_SMTP_TIMEOUT",
            `SMTP dialogue did not complete within ${this.timeoutMs}ms.`,
            { timeoutMs: this.timeoutMs },
          ),
        );
      }, remaining);

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
