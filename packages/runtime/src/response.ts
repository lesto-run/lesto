import { Readable } from "node:stream";

import type { AnyKeelResponse, KeelBody } from "@keel/web";

/**
 * The slice of a node:http `ServerResponse` we write through.
 *
 * Depending on this minimal shape — not on the concrete `ServerResponse` —
 * keeps {@link applyResponse} pure and unit-testable with a fake.
 *
 * `end` widens to `string | Uint8Array` so the bytes arm can flush without a
 * second method; node's real `end` already accepts both. `on`/`destroy` are the
 * stream-piping surface, present only for the {@link ReadableStream} arm: a node
 * `ServerResponse` is a `Writable`, so `Readable.fromWeb(body).pipe(res)` writes
 * the stream to it, and a mid-stream failure `destroy`s the socket. They are
 * required here (not optional) so a fake exercising the string/bytes arms still
 * satisfies the type — those arms simply never call them.
 */
export interface WritableResponse {
  writeHead(status: number, headers: Record<string, string>): void;

  end(body?: string | Uint8Array): void;

  on(event: "error", listener: (error: Error) => void): unknown;

  destroy(error?: Error): void;
}

/** A `KeelBody` that is the Web/global `ReadableStream` — the stream arm. */
function isReadableStream(body: KeelBody): body is ReadableStream {
  return body instanceof ReadableStream;
}

/**
 * Bridge a Web `ReadableStream` into a node `Readable`.
 *
 * This is the one impure seam in {@link pipeStream}: it touches node's stream
 * internals and can *throw synchronously* on a body that is already locked or
 * disturbed. We name it so a test can inject a throwing stand-in and prove the
 * never-rejects invariant without dragging in node's adapter machinery (whose
 * partial teardown is noisy to drive directly).
 */
export type FromWeb = (body: ReadableStream) => Readable;

const fromWeb: FromWeb = (body) =>
  // `as unknown as` bridges the DOM `ReadableStream` lib type to node's
  // `stream/web` `ReadableStream` parameter type: newer `@types/node` narrowed
  // `fromWeb`'s parameter enough that a direct cast no longer overlaps, but the
  // two are structurally the same Web stream at runtime.
  Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]);

/**
 * Pipe a Web `ReadableStream` body onto the node socket, then resolve.
 *
 * `Readable.fromWeb` bridges the Web stream into a node `Readable`, which we
 * `pipe` into the response (a node `Writable`). Two failure modes are handled so
 * a broken stream never crashes the process:
 *
 *   - The *source* errors (the producer threw, or the upstream closed): node's
 *     pipe does not forward a read error to the destination, so we listen on the
 *     node `Readable` and `destroy` the socket ourselves. Headers are already on
 *     the wire by now (`writeHead` ran first), so a clean status is impossible —
 *     destroying the socket is the only honest signal of a truncated body.
 *   - The *destination* errors (the client hung up): the response emits `error`;
 *     we swallow it rather than let it surface as an uncaught exception, and end
 *     the wait. Crucially we also `destroy` the *source* here: `pipe` does NOT
 *     tear the source down when the destination dies, so a resource-backed body
 *     (a file handle, a db cursor, an upstream fetch) would leak for the life of
 *     the process on every client disconnect. Destroying it releases that
 *     resource — the gap `stream.pipeline` exists to close, done explicitly so
 *     the narrow {@link WritableResponse} seam stays fakeable.
 *   - `Readable.fromWeb` itself *throws synchronously* (the Web stream is already
 *     locked or disturbed — e.g. a body someone else read first): there is no
 *     node `Readable` to pipe, so we tear the socket down and resolve right here.
 *     Doing it inside the executor keeps the never-rejects invariant *total* —
 *     it holds by construction, not by leaning on a process-level safety net.
 *
 * Resolves once the body is fully flushed or the socket is torn down — never
 * rejects, so a caller can `void` it without risking an unhandled rejection.
 *
 * A truncated stream — the producer errored, the bridge threw, or the client
 * hung up mid-body — is reported through `options.onTruncated` (when supplied)
 * so the caller can mark its access entry and span: the bytes the client got are
 * incomplete, and an operator should be able to see that. The reason carried to
 * the sink is the underlying error of whichever path tore the body down. It
 * fires at most once per pipe, on the truncation paths only — a clean, fully-
 * flushed stream never calls it.
 *
 * `bridge` defaults to the real {@link fromWeb}; it is a parameter only so a test
 * can drive the synchronous-throw arm deterministically.
 */
export function pipeStream(
  res: WritableResponse,
  body: ReadableStream,
  options: { onTruncated?: (reason: unknown) => void; bridge?: FromWeb } = {},
): Promise<void> {
  const bridge = options.bridge ?? fromWeb;

  return new Promise<void>((resolve) => {
    let source: Readable | undefined;

    // Fire the truncation sink at most once: each tear-down path can be reached
    // exactly once per pipe, but guarding here keeps the report a single event
    // even if two paths ever raced.
    let reported = false;

    const reportTruncated = (reason: unknown): void => {
      if (reported) return;

      reported = true;

      options.onTruncated?.(reason);
    };

    // A write-side failure (client gone) must not escape as an uncaught throw,
    // and `pipe` leaves the source running when the destination dies — so we
    // tear the source down ourselves, freeing whatever backs it. Registered
    // first so it also covers the `error` a `destroy(error)` below emits — every
    // tear-down path has a listener before it can fire. `source` is read through
    // the closure, so it sees whichever value `bridge` later assigned (or stays
    // `undefined` on the synchronous-throw path, where there is nothing to free).
    res.on("error", (error: Error) => {
      // The client went away mid-body: the response is truncated. The destination
      // error is the honest reason for the report.
      reportTruncated(error);

      source?.destroy();

      resolve();
    });

    try {
      source = bridge(body);
    } catch (error) {
      // No stream to pipe: headers are already on the wire, so the only honest
      // signal is to destroy the socket — same as a mid-stream read failure —
      // and the body is truncated.
      reportTruncated(error);

      res.destroy(error as Error);

      resolve();

      return;
    }

    // A read-side failure can't reach the socket through `pipe`; tear it down
    // ourselves so the client sees a reset rather than a silently-truncated body.
    source.on("error", (error: Error) => {
      reportTruncated(error);

      res.destroy(error);

      resolve();
    });

    const piped = source.pipe(res as unknown as NodeJS.WritableStream);

    piped.on("finish", () => resolve());
  });
}

/**
 * Write a {@link KeelResponse} onto the socket: status line, headers, then body.
 *
 * The body has three arms (see `KeelBody`), each written the way its kind
 * demands:
 *
 *   - `string` — `end(string)`, exactly as before: the original path, byte-for-
 *     byte unchanged for every existing response.
 *   - `Uint8Array` — `end(Buffer.from(bytes))`, so the raw bytes go out verbatim
 *     with no UTF-8 re-encoding to corrupt them.
 *   - `ReadableStream` — piped to the socket (see {@link pipeStream}); returns the
 *     in-flight promise so a caller may await full delivery.
 *
 * Returns `void` for the buffered arms (nothing to await) and a `Promise<void>`
 * for the stream arm. The caller (`handle`) treats both uniformly: it does not
 * await the result today, and the per-request access log fires immediately —
 * the stream's completion is the socket's concern, not the log's.
 *
 * `options.onTruncated`, when supplied, is forwarded to {@link pipeStream} for
 * the stream arm so a body torn down mid-flight (producer error, client
 * disconnect) is reported to the caller's access entry/span. The buffered arms
 * never truncate, so they ignore it.
 */
export function applyResponse(
  res: WritableResponse,
  response: AnyKeelResponse,
  options: { onTruncated?: (reason: unknown) => void } = {},
): void | Promise<void> {
  res.writeHead(response.status, response.headers);

  const { body } = response;

  if (typeof body === "string") {
    res.end(body);

    return;
  }

  if (isReadableStream(body)) {
    return pipeStream(
      res,
      body,
      options.onTruncated === undefined ? {} : { onTruncated: options.onTruncated },
    );
  }

  // The remaining arm is `Uint8Array`: copy into a Buffer the socket can flush.
  res.end(Buffer.from(body));
}
