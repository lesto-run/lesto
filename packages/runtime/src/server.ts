import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { App } from "@keel/kernel";

import { applyResponse } from "./response";
import { toKeelRequest } from "./request";
import { RuntimeError } from "./errors";

/** A running http server bound to a port, with a graceful shutdown. */
export interface Server {
  readonly port: number;

  close(): Promise<void>;
}

export interface ServeOptions {
  readonly port?: number;

  readonly host?: string;

  /**
   * The largest request body we will read off a socket, in bytes.
   *
   * A request that exceeds this is refused with a 413 and its socket torn down,
   * so an unauthenticated client cannot exhaust memory by streaming an
   * unbounded body. Defaults to 1 MiB.
   */
  readonly maxBodyBytes?: number;

  /**
   * Where uncaught server-level failures are reported.
   *
   * Injected so a test can assert the process safety-net logged without writing
   * to the real console. Defaults to `console.error`.
   */
  readonly logError?: (message: string, error: unknown) => void;
}

/** A body we refuse to read past 1 MiB unless the caller raises the bar. */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * The method and path of an incoming request.
 *
 * Node types `method`/`url` as optional, yet a *server* request always carries
 * both. We still default them — defensively, and so the narrowing is honest
 * rather than a cast — and unit-test both branches with a fake message.
 */
export function requestLineOf(req: Pick<IncomingMessage, "method" | "url">): {
  method: string;
  url: string;
} {
  return {
    method: req.method ?? "GET",
    url: req.url ?? "/",
  };
}

/**
 * The slice of an `IncomingMessage` {@link readBody} drives.
 *
 * Narrow on purpose: a fake `EventEmitter`-shaped object satisfies it, so the
 * size-limit and stream-error branches are unit-testable without a live socket.
 */
export interface BodyStream {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;

  on(event: "end", listener: () => void): unknown;

  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * Read the full request body off the socket as a UTF-8 string, bounded.
 *
 * We tally bytes as chunks arrive and reject the moment the running total would
 * exceed `maxBytes` — dropping what we have buffered so memory stays bounded,
 * and ignoring every later chunk so a client streaming gigabytes can never grow
 * our heap. We do NOT destroy the socket here: the caller still needs to flush a
 * 413 back, and tearing the connection down first races that write. A stream
 * `error` (a client that hangs up mid-body, a reset connection) also rejects,
 * rather than leaving the promise to dangle forever.
 *
 * The invariant: this promise always settles, and never holds more than
 * `maxBytes` of body in memory.
 */
export function readBody(req: BodyStream, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];

    let total = 0;

    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      // Already over the limit: discard, do not buffer, do not reject twice.
      if (aborted) {
        return;
      }

      total += chunk.length;

      if (total > maxBytes) {
        aborted = true;

        // Free what we held — the body is refused, the bytes are dead weight.
        chunks = [];

        reject(
          new RuntimeError("RUNTIME_BODY_TOO_LARGE", "Request body exceeds the size limit.", {
            maxBytes,
          }),
        );

        return;
      }

      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) {
        return;
      }

      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", (error) => reject(error));
  });
}

/** Map a known transport-level refusal to its HTTP status; anything else is a 500. */
function statusForError(error: unknown): number {
  if (error instanceof RuntimeError && error.code === "RUNTIME_INVALID_JSON") {
    return 400;
  }

  if (error instanceof RuntimeError && error.code === "RUNTIME_BODY_TOO_LARGE") {
    return 413;
  }

  return 500;
}

/** The safe, internals-free body we send for each error status. */
function bodyForStatus(status: number): string {
  if (status === 400) return "Bad Request";

  if (status === 413) return "Payload Too Large";

  return "Internal Server Error";
}

/**
 * Boot a node:http server that serves a Keel {@link App}.
 *
 * Each request is read in full, normalized into a transport-free `KeelRequest`,
 * dispatched through `app.handle`, and its response written back. The server is
 * stateless: all durable state lives in the app's database, so multiple
 * instances scale horizontally and deploys are rolling restarts.
 *
 * Resolves once the socket is listening, carrying the bound port — so a caller
 * that passed `port: 0` (the default) learns which ephemeral port it got.
 */
export function serve(app: App, options: ServeOptions = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const logError = options.logError ?? defaultLogError;

  installProcessSafetyNet(logError);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // `handle` swallows every throw internally and always answers the socket,
    // so this `void` can never leak a rejected promise into the process.
    void handle(app, req, res, { maxBodyBytes, logError });
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      // listen() resolved, so address() is a bound AddressInfo, not null.
      const address = server.address() as AddressInfo;

      resolve({
        port: address.port,

        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}

interface HandleDeps {
  readonly maxBodyBytes: number;

  readonly logError: (message: string, error: unknown) => void;
}

/**
 * Drive one request through the app and write its response — and never throw.
 *
 * This is the per-request error boundary, the primary defense against an
 * unauthenticated client crashing the server. ANY failure — a malformed body,
 * a controller that throws, a rejected promise deep in the app — is caught
 * here, mapped to a status, and answered with a safe generic body. An attacker
 * can degrade their own request to a 4xx/500; they can never take the process
 * down or hang their socket open.
 */
async function handle(
  app: App,
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  try {
    const body = await readBody(req, deps.maxBodyBytes);

    const line = requestLineOf(req);

    const request = toKeelRequest({
      method: line.method,
      url: line.url,
      headers: req.headers,
      body,
    });

    const response = await app.handle(request.method, request.path, {
      query: request.query,
      headers: request.headers,
      body: request.body,
    });

    applyResponse(res, response);
  } catch (error) {
    const status = statusForError(error);

    // A 500 is ours to explain in the log; client errors (4xx) are not.
    if (status === 500) {
      deps.logError("unhandled error serving request", error);
    }

    respondWithError(res, status);
  }
}

/** The slice of a response the error path needs — narrow, so a test can fake it. */
export interface ErrorResponse {
  readonly headersSent: boolean;

  writeHead(status: number, headers: Record<string, string>): void;

  end(body?: string): void;
}

/**
 * Answer a failed request with a safe, generic body.
 *
 * Best-effort: if the headers already went out (a handler that wrote then
 * threw) we cannot send a fresh status, so we just end the socket — the
 * invariant we protect is that the socket never hangs open, not that every
 * failure becomes a clean status line.
 */
export function respondWithError(res: ErrorResponse, status: number): void {
  if (!res.headersSent) {
    applyResponse(res, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: bodyForStatus(status),
    });

    return;
  }

  res.end();
}

/** The default error sink: structured-enough for a server log. */
function defaultLogError(message: string, error: unknown): void {
  console.error(message, error);
}

/** The slice of `process` the safety net listens on — injectable for tests. */
export interface SafetyNetTarget {
  on(event: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

// Installed at most once per target, no matter how many servers we boot.
const netted = new WeakSet<SafetyNetTarget>();

/**
 * Install a process-level last line of defense.
 *
 * The per-request try/catch in {@link handle} is the real fix; this is
 * defense-in-depth for a stray rejection that somehow escapes it (a timer
 * callback, a background task). We log and keep serving rather than let one bad
 * request exit the process — but we deliberately do NOT touch
 * `uncaughtException`: Node's guidance is that an uncaught *synchronous* throw
 * leaves the process in an unknown state, and swallowing it can corrupt
 * subsequent requests. So we only net the async case.
 *
 * Idempotent: booting many servers in one process registers one listener, not
 * a leaking pile of them.
 */
export function installProcessSafetyNet(
  logError: (message: string, error: unknown) => void,
  target: SafetyNetTarget = process,
): void {
  if (netted.has(target)) {
    return;
  }

  netted.add(target);

  target.on("unhandledRejection", (reason) => {
    logError("unhandled rejection (kept serving)", reason);
  });
}
