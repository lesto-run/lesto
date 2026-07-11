import { createServer } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createSmtpTransport, SmtpTransportError } from "../src/index";

import type { Socket } from "node:net";
import type { RenderedEmail } from "../src/index";

/**
 * Real-SMTP end-to-end boundary tests for {@link createSmtpTransport}.
 *
 * The rest of the suite drives a hand-written fake `SmtpSocket`; this file dials
 * a genuine in-process `node:net` server on 127.0.0.1:0 over the transport's
 * DEFAULT `nodeConnect` path (no injected `connect`), so the real socket, the
 * real Buffer/`setEncoding` read path, and the real `openWithinDeadline` dial
 * race are all exercised. The server speaks just enough RFC 5321 to deliver one
 * message and can inject a controllable delay at a chosen phase, so a test can
 * make the whole-dialogue deadline fire at a specific boundary — in particular
 * the window AFTER the server has received the full DATA body + dot but BEFORE
 * it has sent the final 250.
 *
 * What these prove about the boundary (see the red-team table in the task):
 *   - A deadline in the post-dot / pre-250 window surfaces a DETERMINISTIC coded
 *     timeout the caller can act on, and the mailer never silently re-transmits
 *     the body inside a single `send()` — the safe direction (reject → the queue
 *     decides, deduped downstream by the stable `Message-ID`), never a silent
 *     success that would drop the mail.
 *   - A deadline BEFORE `DATA` never puts the body on the wire at all — an
 *     unambiguous clean-retry region.
 *   - Once the body-250 has COMMITTED the message, a withheld/slow 221 to QUIT
 *     resolves the send as success rather than rejecting it into a duplicate
 *     re-delivery (the last test enforces this post-commit contract).
 */

interface ServerBehavior {
  /** ms to wait before sending the 250 that acks the DATA body (the post-dot / pre-250 window). */
  readonly bodyReplyDelayMs?: number;

  /** ms to wait before sending the 250 that acks RCPT TO (a pre-DATA stall). */
  readonly rcptReplyDelayMs?: number;

  /** When true, the server never sends the 221 reply to QUIT — a relay that drops the line post-commit. */
  readonly withholdQuitReply?: boolean;

  /**
   * When true, immediately `end()` (a graceful FIN) the connection right after
   * writing the body-250 — a relay that hangs up the instant it accepts, in the
   * QUIT window. `end()` flushes the 250 before the FIN, so the client always
   * receives the ack first (non-flaky), then the peer closes.
   */
  readonly finAfterBodyReply?: boolean;

  /**
   * When true, hard-RST the connection on receiving QUIT (after a normal
   * body-250) instead of replying 221 — the socket-error / ECONNRESET close
   * path. The RST fires only AFTER the client has sent QUIT, which it only does
   * after receiving the body-250, so the committed ack is guaranteed delivered
   * first: deterministic, never a data-loss race.
   */
  readonly resetOnQuit?: boolean;
}

interface ServerState {
  commands: string[];
  /** How many times the client's `<CRLF>.<CRLF>` end-of-DATA terminator was seen. */
  dataTerminations: number;
  /** How many times a body-acknowledging 250 actually went onto the wire. */
  bodyRepliesSent: number;
  quitReceived: boolean;
  quitReplySent: boolean;
}

interface FakeServer {
  readonly port: number;
  readonly state: ServerState;
  readonly close: () => Promise<void>;
}

/**
 * Start a real loopback SMTP server. It answers a single-recipient plaintext
 * (non-secure) dialogue and injects the configured per-phase delays. Every
 * scheduled reply rides a tracked timer and every accepted socket is tracked so
 * `close()` can tear down deterministically — timers cleared FIRST (so no reply
 * is ever written to a half-closed peer), then a graceful `end()` on each socket
 * (a FIN, never a RST, so the transport's post-send `removeAllListeners()` can
 * never be surprised by a late `error` event), then the listener.
 */
function startSmtpServer(behavior: ServerBehavior = {}): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const state: ServerState = {
    commands: [],
    dataTerminations: 0,
    bodyRepliesSent: 0,
    quitReceived: false,
    quitReplySent: false,
  };

  const server = createServer((socket) => {
    sockets.add(socket);

    let buf = "";
    let inData = false;

    const write = (text: string): void => {
      if (!socket.destroyed && socket.writable) {
        socket.write(text);
      }
    };

    const later = (ms: number, fn: () => void): void => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        fn();
      }, ms);
      timers.add(timer);
    };

    const reply = (ms: number, text: string, after: () => void = (): void => {}): void => {
      if (ms > 0) {
        later(ms, () => {
          write(text);
          after();
        });
      } else {
        write(text);
        after();
      }
    };

    const handleCommand = (line: string): void => {
      state.commands.push(line);
      const upper = line.toUpperCase();

      if (upper.startsWith("EHLO") || upper.startsWith("HELO")) {
        // A realistic multiline EHLO reply also exercises the client's
        // continuation-line (`NNN-...` then `NNN ...`) reply parsing.
        write("250-e2e.test greets you\r\n250 OK\r\n");
      } else if (upper.startsWith("MAIL FROM")) {
        write("250 2.1.0 sender ok\r\n");
      } else if (upper.startsWith("RCPT TO")) {
        reply(behavior.rcptReplyDelayMs ?? 0, "250 2.1.5 recipient ok\r\n");
      } else if (upper.startsWith("DATA")) {
        write("354 end data with <CR><LF>.<CR><LF>\r\n");
        inData = true;
      } else if (upper.startsWith("QUIT")) {
        state.quitReceived = true;

        if (behavior.resetOnQuit) {
          // Hard reset in the QUIT window: the client already holds the body-250
          // (that is why it sent QUIT), so this surfaces a socket error the
          // best-effort QUIT must swallow — never a lost/duplicated commit.
          socket.resetAndDestroy();
        } else if (!behavior.withholdQuitReply) {
          write("221 2.0.0 bye\r\n");
          state.quitReplySent = true;
        }
      } else {
        write("250 OK\r\n");
      }
    };

    const pump = (): void => {
      // Interleave command-line parsing with DATA-mode terminator scanning until
      // neither can make progress on the buffer.
      for (;;) {
        if (inData) {
          const term = buf.indexOf("\r\n.\r\n");

          if (term === -1) {
            return;
          }

          buf = buf.slice(term + 5);
          inData = false;
          state.dataTerminations += 1;
          reply(behavior.bodyReplyDelayMs ?? 0, "250 2.0.0 queued as e2e\r\n", () => {
            state.bodyRepliesSent += 1;

            if (behavior.finAfterBodyReply) {
              // Graceful FIN right after the ack flushes: the message is committed
              // and the peer hangs up in the QUIT window.
              socket.end();
            }
          });

          continue;
        }

        const nl = buf.indexOf("\r\n");

        if (nl === -1) {
          return;
        }

        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        handleCommand(line);
      }
    };

    socket.on("data", (chunk: Buffer | string) => {
      buf += chunk.toString();
      pump();
    });
    // A client reset during teardown is expected noise, never a test failure.
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
    });

    // Banner. Node buffers it until the client attaches its `data` listener.
    write("220 e2e.test ESMTP ready\r\n");
  });

  return new Promise<FakeServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("expected an AddressInfo from listen(0) on 127.0.0.1"));

        return;
      }

      resolve({
        port: address.port,
        state,
        close: () =>
          new Promise<void>((done) => {
            for (const timer of timers) {
              clearTimeout(timer);
            }

            timers.clear();

            for (const socket of sockets) {
              socket.end();
            }

            server.close(() => done());
          }),
      });
    });
  });
}

const baseEmail = (): RenderedEmail => ({
  to: "ada@example.com",
  from: "from@app.com",
  subject: "Hello",
  html: "<p>Hi</p>",
  messageId: "lesto-mail-e2e-1",
});

/** Await a send and return its rejection, failing loudly if it unexpectedly resolves. */
async function rejectionOf(sending: Promise<void>, why: string): Promise<unknown> {
  return sending.then(
    () => {
      throw new Error(`expected send() to reject (${why}), but it resolved`);
    },
    (error: unknown) => error,
  );
}

describe("createSmtpTransport — real loopback SMTP e2e", () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("delivers a full dialogue over a real 127.0.0.1 socket (harness baseline)", async () => {
    // Non-vacuity anchor: with NO injected delay the whole dialogue completes
    // and `send()` resolves. If this ever stopped passing, the timeout tests
    // below would prove nothing — this is what makes their delays load-bearing.
    server = await startSmtpServer();
    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      ehloName: "client.e2e",
      timeoutMs: 2000,
    });

    await expect(transport.send(baseEmail())).resolves.toBeUndefined();

    expect(server.state.dataTerminations).toBe(1);
    expect(server.state.bodyRepliesSent).toBe(1);
    expect(server.state.quitReceived).toBe(true);
    expect(server.state.quitReplySent).toBe(true);
    expect(server.state.commands.some((c) => c.startsWith("MAIL FROM:<from@app.com>"))).toBe(true);
    expect(server.state.commands.some((c) => c.startsWith("RCPT TO:<ada@example.com>"))).toBe(true);
  });

  it("fails with a deterministic coded timeout when the deadline fires in the post-dot / pre-250 window, and never silently re-sends the body", async () => {
    // The server acks everything through DATA promptly, receives the full
    // message AND the `<CRLF>.<CRLF>` terminator, then stalls 5s before the 250.
    // That is exactly the dangerous window the task calls out: the server may be
    // about to commit, but the client cannot yet know. The 500ms whole-dialogue
    // budget must fire FIRST and surface a deterministic, coded, transient error.
    //
    // Proof it can go RED: if the read-wait were not bounded by the deadline
    // (a regression of the F15 fix), `send()` would block until the 5s reply and
    // then RESOLVE — `rejectionOf` throws on that resolution and the test fails.
    // A wrong error code likewise fails the `toMatchObject`.
    server = await startSmtpServer({ bodyReplyDelayMs: 5000 });
    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      timeoutMs: 500,
    });

    const error = await rejectionOf(transport.send(baseEmail()), "pre-250 stall");

    // The caller gets a coded, transient signal it can act on — not a hang, not
    // a silent success.
    expect(error).toBeInstanceOf(SmtpTransportError);
    expect(error).toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_TIMEOUT",
      details: { timeoutMs: 500 },
    });

    // We were genuinely in the post-dot / pre-250 window: the server received
    // the entire message (its DATA terminator) but had NOT yet acked it when the
    // deadline tripped.
    expect(server.state.dataTerminations).toBe(1);
    expect(server.state.bodyRepliesSent).toBe(0);
    // And the message crossed the wire exactly once — the mailer did not quietly
    // double-send the body inside this single `send()` call.
    expect(server.state.commands.filter((c) => c.toUpperCase().startsWith("DATA")).length).toBe(1);
  });

  it("fails a pre-DATA stall without ever putting the message body on the wire (clean-retry region)", async () => {
    // The server stalls on RCPT TO — BEFORE the client would ever transmit the
    // body. The deadline must fail the send with the body still un-sent, so a
    // stall here is an unambiguous clean retry: nothing was delivered, nothing to
    // dedupe. Proof it can go RED: unbounded reads would resolve at the 5s RCPT
    // reply, and `rejectionOf` would throw on the resolution.
    server = await startSmtpServer({ rcptReplyDelayMs: 5000 });
    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      timeoutMs: 500,
    });

    const error = await rejectionOf(transport.send(baseEmail()), "pre-DATA stall");

    expect(error).toMatchObject({
      code: "MAIL_TRANSPORT_SMTP_TIMEOUT",
      details: { timeoutMs: 500 },
    });
    // Progressed deep into the dialogue (past greeting/EHLO/MAIL) — non-vacuous —
    // yet DATA was never issued and no body terminator ever reached the server.
    expect(server.state.commands.some((c) => c.toUpperCase().startsWith("RCPT TO"))).toBe(true);
    expect(server.state.commands.some((c) => c.toUpperCase().startsWith("DATA"))).toBe(false);
    expect(server.state.dataTerminations).toBe(0);
  });

  // QUIT-WINDOW DUPLICATE-SEND — FIXED (this test guards the contract).
  //
  // Phase: the QUIT / final-221 wait, AFTER a successful body-250.
  // Repro:  the server acks the body (250, message COMMITTED per RFC 5321 §4.2 —
  //         the receiver has taken responsibility), then withholds the 221 to
  //         QUIT (a relay that drops the line right after accepting — common) OR
  //         is merely slow past the budget.
  // Old wrong outcome: `send()` gated success on `command("QUIT", 221)`, so the
  //         withheld/slow 221 made `send()` REJECT with
  //         MAIL_TRANSPORT_SMTP_TIMEOUT even though the message was already
  //         accepted. The queue then re-delivered an accepted message → a
  //         guaranteed DUPLICATE send (masked only if a downstream relay dedupes
  //         on Message-ID; a plain relay double-delivers).
  // Fix: the body-250 IS the point of success; QUIT is issued best-effort and any
  //         timeout/error/connection-close on the 221 is swallowed, so a
  //         post-commit hiccup can never turn a delivered message into a retry.
  it("does NOT fail an already-committed send when the QUIT/221 reply is withheld (post-fix contract)", async () => {
    server = await startSmtpServer({ withholdQuitReply: true });
    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      timeoutMs: 500,
    });

    // Post-fix DESIRED behavior: the send RESOLVES because the body was acked.
    await expect(transport.send(baseEmail())).resolves.toBeUndefined();
    // Precondition that makes the assertion meaningful: the server did commit.
    expect(server.state.bodyRepliesSent).toBe(1);
  });

  // Post-250 CONNECTION CLOSE — the graceful-FIN sibling of the withheld-221
  // case. The relay acks the body (250, COMMITTED per RFC 5321 §4.2) and then
  // hangs up (FIN) in the QUIT window rather than merely stalling. The client's
  // QUIT wait sees no 221 and the connection go away; the best-effort QUIT must
  // still resolve the delivered message, never reject it into a duplicate.
  //
  // Also the LATENCY proof for the `close` handler: a graceful FIN emits no
  // 'error' (unlike an RST), so WITHOUT a 'close' listener the pending QUIT/221
  // read had nothing to settle it and sat idle until the whole-dialogue deadline
  // — resolving correctly but only after burning the entire budget. Here the
  // budget is 30s, so if the send resolved by outliving it this test would take
  // ~30s (and trip its own 15s timeout); the `close` handler settles the read the
  // instant the peer FINs, so it resolves in milliseconds. The elapsed ceiling
  // (6× below the deadline, orders of magnitude above the real ~ms close latency)
  // is the non-flaky RED/GREEN witness: drop the 'close' handler and it fails.
  it("resolves an already-committed send PROMPTLY on a post-250 FIN — via close, not the whole-dialogue deadline", async () => {
    server = await startSmtpServer({ finAfterBodyReply: true });
    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      timeoutMs: 30_000,
    });

    const started = Date.now();
    await expect(transport.send(baseEmail())).resolves.toBeUndefined();
    const elapsed = Date.now() - started;

    expect(server.state.bodyRepliesSent).toBe(1);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  // Post-250 HARD RESET — the socket-error close path, distinct from the two
  // deadline-timeout cases above. The relay commits the body-250, then RSTs on
  // QUIT: the client surfaces an ECONNRESET (MAIL_TRANSPORT_SMTP_CONNECTION),
  // NOT a MAIL_TRANSPORT_SMTP_TIMEOUT. The best-effort QUIT swallows THAT too, so
  // the committed message still resolves as success.
  //
  // Non-vacuity: this is the case that fails RED if the QUIT catch is ever
  // narrowed to swallow only _TIMEOUT (e.g. `catch (e) { if (e.code !==
  // "...TIMEOUT") throw e }`) — the _CONNECTION/socket-error branch would then
  // re-throw, the send would reject, and the duplicate-send bug would silently
  // return. The RST fires only after the client sent QUIT (hence after it
  // received the 250), so the ack is guaranteed delivered first — deterministic,
  // no data-loss race. A clean green run also proves the RST raises no unhandled
  // 'error' or crash.
  it("resolves an already-committed send when the peer hard-RSTs in the QUIT window (the _CONNECTION path also resolves)", async () => {
    server = await startSmtpServer({ resetOnQuit: true });
    const transport = createSmtpTransport({
      host: "127.0.0.1",
      port: server.port,
      secure: false,
      timeoutMs: 500,
    });

    await expect(transport.send(baseEmail())).resolves.toBeUndefined();
    expect(server.state.bodyRepliesSent).toBe(1);
    // The client genuinely reached QUIT (so we exercised the post-commit window),
    // and the server reset instead of acking it.
    expect(server.state.quitReceived).toBe(true);
    expect(server.state.quitReplySent).toBe(false);
  });
});
