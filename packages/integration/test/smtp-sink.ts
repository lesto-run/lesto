/**
 * A throwaway, in-process SMTP catcher for integration tests.
 *
 * Speaks just enough of RFC 5321 to receive one message from a real SMTP
 * client (here, `@volo/mail`'s {@link createSmtpTransport}): greeting → `EHLO`
 * → `MAIL FROM` → `RCPT TO` → `DATA` … `.` → `QUIT`. It binds a localhost TCP
 * socket via `node:net`, records the full dialogue, and resolves a promise with
 * the captured envelope + raw message the moment a `.`-terminated `DATA` block
 * lands. Tear it down with {@link SmtpSink.close}; it tracks live sockets and
 * destroys them so no handle or port leaks between tests.
 *
 * This is the real-socket counterpart to the mailer's mocked-socket unit tests:
 * the bytes leave the process, cross the loopback, and come back parsed.
 */

import { createServer, type Server, type Socket } from "node:net";

/** A single message the sink received, as the wire delivered it. */
export interface CapturedMessage {
  /** The address from `MAIL FROM:<…>`. */
  readonly mailFrom: string;
  /** Every address from `RCPT TO:<…>` (one for a single-recipient send). */
  readonly rcptTo: readonly string[];
  /** The raw `DATA` block — headers + blank line + body — minus the trailing `.`. */
  readonly data: string;
  /** Every command line the client sent, in order (handshake assertions). */
  readonly commands: readonly string[];
}

const CRLF = "\r\n";

/** An in-process SMTP server that captures exactly one delivered message. */
export class SmtpSink {
  private readonly server: Server;

  private readonly sockets = new Set<Socket>();

  private readonly received: CapturedMessage[] = [];

  private resolveFirst: ((message: CapturedMessage) => void) | undefined;

  private firstMessage: Promise<CapturedMessage>;

  private constructor(server: Server) {
    this.server = server;
    this.firstMessage = new Promise<CapturedMessage>((resolve) => {
      this.resolveFirst = resolve;
    });
  }

  /** Bind on an ephemeral localhost port and start accepting connections. */
  static async listen(): Promise<SmtpSink> {
    const server = createServer();
    const sink = new SmtpSink(server);

    server.on("connection", (socket) => sink.handle(socket));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    return sink;
  }

  /** The ephemeral port the sink is listening on. */
  get port(): number {
    const address = this.server.address();

    if (address === null || typeof address === "string") {
      throw new Error("SMTP sink is not listening on a TCP port.");
    }

    return address.port;
  }

  /** Resolves with the first message delivered through `DATA`. */
  waitForMessage(): Promise<CapturedMessage> {
    return this.firstMessage;
  }

  /** Every message captured so far. */
  get messages(): readonly CapturedMessage[] {
    return this.received;
  }

  /** Destroy every live socket and close the listener — no leaked handles. */
  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();

    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);

          return;
        }

        resolve();
      });
    });
  }

  /** Drive one client connection through the minimal SMTP state machine. */
  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");

    // `commands` is shared by reference into the CapturedMessage so a command
    // sent AFTER `DATA` completes (notably `QUIT`) is still recorded against the
    // message the test inspects.
    const commands: string[] = [];
    let mailFrom = "";
    const rcptTo: string[] = [];
    let buffer = "";
    let inData = false;
    let dataLines: string[] = [];
    let data = "";
    /** Set once the `.` after DATA lands; the message is complete then. */
    let captured = false;
    /** Guards `settle` so a message is recorded/resolved at most once. */
    let settled = false;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      const message: CapturedMessage = { mailFrom, rcptTo, data, commands };
      this.received.push(message);
      this.resolveFirst?.(message);
      this.resolveFirst = undefined;
    };

    const write = (line: string): void => {
      socket.write(`${line}${CRLF}`);
    };

    // 220 greeting the moment the client connects.
    write("220 volo-smtp-sink ready");

    socket.on("data", (chunk: string) => {
      buffer += chunk;

      let newline = buffer.indexOf(CRLF);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + CRLF.length);

        if (inData) {
          if (line === ".") {
            // End of DATA: undo dot-stuffing and stash the raw message.
            inData = false;
            captured = true;
            data = dataLines.map((l) => (l.startsWith("..") ? l.slice(1) : l)).join(CRLF);
            write("250 OK: queued");
          } else {
            dataLines.push(line);
          }
        } else {
          commands.push(line);
          this.respond(line, write, {
            setMailFrom: (value) => {
              mailFrom = value;
            },
            addRcpt: (value) => rcptTo.push(value),
            beginData: () => {
              inData = true;
              dataLines = [];
            },
            // QUIT arrives after DATA; resolve here so the captured message's
            // command list includes the full handshake through QUIT.
            end: () => {
              if (captured) settle();
              socket.end();
            },
          });
        }

        newline = buffer.indexOf(CRLF);
      }
    });

    socket.on("close", () => {
      // A client that captured a message then dropped without QUIT still counts.
      if (captured) settle();
      this.sockets.delete(socket);
    });

    // A reset connection is normal at teardown; swallow it so a test never sees
    // a stray unhandled-error event from the loopback socket.
    socket.on("error", () => {
      this.sockets.delete(socket);
    });
  }

  /** Reply to one (non-DATA) command, honoring EHLO multi-line replies. */
  private respond(
    line: string,
    write: (line: string) => void,
    actions: {
      setMailFrom: (value: string) => void;
      addRcpt: (value: string) => void;
      beginData: () => void;
      end: () => void;
    },
  ): void {
    const verb = line.slice(0, 4).trim().toUpperCase();

    switch (verb) {
      case "EHLO":
      case "HELO":
        // Multi-line 250 reply; SMTP marks the final line with a space (not `-`).
        write("250-volo-smtp-sink greets you");
        write("250 SIZE 10485760");

        return;
      case "MAIL":
        actions.setMailFrom(extractAddress(line));
        write("250 OK");

        return;
      case "RCPT":
        actions.addRcpt(extractAddress(line));
        write("250 OK");

        return;
      case "DATA":
        actions.beginData();
        write("354 End data with <CR><LF>.<CR><LF>");

        return;
      case "QUIT":
        write("221 Bye");
        actions.end();

        return;
      default:
        write("250 OK");

        return;
    }
  }
}

/** Pull the address out of `MAIL FROM:<addr>` / `RCPT TO:<addr>`. */
function extractAddress(line: string): string {
  const match = /<([^>]*)>/.exec(line);

  return match ? match[1]! : "";
}
