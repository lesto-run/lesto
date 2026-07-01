import { Readable, type Transform } from "node:stream";
import {
  brotliCompressSync,
  createBrotliCompress,
  createGzip,
  gzipSync,
  constants as zlibConstants,
} from "node:zlib";

import type { AnyLestoResponse, LestoBody } from "@lesto/web";

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
 *
 * `writeHead`'s header value widens to `string | string[]`: a `Set-Cookie`
 * carrying several cookies arrives as a list, and node's real `writeHead` accepts
 * a string-array value natively, emitting one header line per element — exactly
 * the per-cookie framing RFC 6265 requires (a comma-joined `Set-Cookie` is
 * ambiguous and dropped by browsers). A single-valued header stays a bare string.
 */
export interface WritableResponse {
  writeHead(status: number, headers: Record<string, string | string[]>): void;

  end(body?: string | Uint8Array): void;

  on(event: "error", listener: (error: Error) => void): unknown;

  destroy(error?: Error): void;

  /**
   * Flush the response head to the socket now, ahead of any body byte — node
   * otherwise buffers the head until the first `write`/`end`. Optional: only the
   * stream arm calls it (see {@link applyResponse}), so a fake exercising the
   * buffered arms need not provide it, and the call is a no-op when absent.
   */
  flushHeaders?(): void;
}

/** A `LestoBody` that is the Web/global `ReadableStream` — the stream arm. */
function isReadableStream(body: LestoBody): body is ReadableStream {
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
 *
 * `transform`, when supplied, is a node `Transform` (a zlib compressor) inserted
 * between the source and the socket: `source -> transform -> res`. It is part of
 * the tear-down chain — a source/transform error or a client disconnect destroys
 * the WHOLE chain (so a resource-backed body and the compressor's buffers are
 * freed) and reports the truncation, exactly as the no-transform path does.
 */
export function pipeStream(
  res: WritableResponse,
  body: ReadableStream,
  options: {
    onTruncated?: (reason: unknown) => void;
    bridge?: FromWeb;
    transform?: Transform;
  } = {},
): Promise<void> {
  const bridge = options.bridge ?? fromWeb;
  const transform = options.transform;

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

    // Tear down every stage we have: the source (freeing what backs it) and the
    // compressor (freeing its buffers). `pipe` does not propagate a destination
    // failure upstream, so we do it ourselves — the leak fix, now covering the
    // optional transform too.
    const destroyUpstream = (): void => {
      source?.destroy();
      transform?.destroy();
    };

    // A write-side failure (client gone) must not escape as an uncaught throw,
    // and `pipe` leaves the source running when the destination dies — so we
    // tear the upstream down ourselves, freeing whatever backs it. Registered
    // first so it also covers the `error` a `destroy(error)` below emits — every
    // tear-down path has a listener before it can fire. `source` is read through
    // the closure, so it sees whichever value `bridge` later assigned (or stays
    // `undefined` on the synchronous-throw path, where there is nothing to free).
    res.on("error", (error: Error) => {
      // The client went away mid-body: the response is truncated. The destination
      // error is the honest reason for the report.
      reportTruncated(error);

      destroyUpstream();

      resolve();
    });

    try {
      source = bridge(body);
    } catch (error) {
      // No stream to pipe: headers are already on the wire, so the only honest
      // signal is to destroy the socket — same as a mid-stream read failure —
      // and the body is truncated.
      reportTruncated(error);

      transform?.destroy();

      res.destroy(error as Error);

      resolve();

      return;
    }

    // A read-side failure can't reach the socket through `pipe`; tear it down
    // ourselves so the client sees a reset rather than a silently-truncated body.
    source.on("error", (error: Error) => {
      reportTruncated(error);

      transform?.destroy();

      res.destroy(error);

      resolve();
    });

    // A compressor fault (a malformed input it cannot encode) is just as
    // truncating: the bytes downstream are incomplete, so we tear the socket down
    // and report it, the same as a source error.
    transform?.on("error", (error: Error) => {
      reportTruncated(error);

      source?.destroy();

      res.destroy(error);

      resolve();
    });

    // Insert the compressor between source and socket when present:
    // `source -> transform -> res`. Without one, the source pipes straight to res
    // exactly as before — byte-for-byte the original path.
    const piped =
      transform === undefined
        ? source.pipe(res as unknown as NodeJS.WritableStream)
        : source.pipe(transform).pipe(res as unknown as NodeJS.WritableStream);

    piped.on("finish", () => resolve());
  });
}

/**
 * A content encoding the server may negotiate for a response body.
 *
 * `"br"` (Brotli) and `"gzip"` are the two the web converged on; `"identity"` is
 * the no-op — the body goes out as-is. We deliberately do NOT offer `deflate`
 * (its raw-vs-zlib ambiguity has burned enough clients) or `zstd` (not yet
 * universal in browsers as of v1).
 */
export type ContentEncoding = "br" | "gzip" | "identity";

/**
 * The content-type prefixes whose bodies are worth compressing.
 *
 * Text-shaped payloads (HTML, JSON, JS, CSS, SVG, plain text) shrink a lot and
 * dominate a dynamic app's bytes; everything else is either already compressed
 * (a PNG, a woff2, a video — see {@link isAlreadyEncoded}) or too small to pay
 * for the CPU. An allowlist (not a denylist) is the safe default: an unknown
 * type is left uncompressed rather than spending CPU on a body that won't shrink.
 */
const COMPRESSIBLE_TYPES: readonly string[] = [
  "text/",
  "application/json",
  "application/javascript",
  "application/manifest+json",
  "application/xml",
  "image/svg+xml",
];

/**
 * Parse an `Accept-Encoding` request header into the best encoding we offer.
 *
 * We prefer Brotli over gzip (smaller for the same text) and fall back to
 * `identity` when the client accepts neither — honoring an explicit `q=0` that
 * forbids an encoding, so a client that sent `gzip;q=0` never receives gzip. A
 * missing header is `identity`: an absent `Accept-Encoding` means "send me what
 * you have", not "compress freely". Pure over the raw header string so every
 * row of the negotiation matrix is unit-testable without a socket.
 */
export function negotiateEncoding(acceptEncoding: string | undefined): ContentEncoding {
  if (acceptEncoding === undefined) return "identity";

  // Map each offered token to its q-value (default 1), so a `;q=0` forbids it
  // and a higher q is preferred — though for our two codings the fixed br > gzip
  // order already decides ties, the q-parse is what lets a client OPT OUT.
  const accepted = new Map<string, number>();

  for (const part of acceptEncoding.split(",")) {
    const [rawToken, ...params] = part.trim().split(";");
    const token = rawToken?.trim().toLowerCase();

    if (token === undefined || token === "") continue;

    const q = qValueOf(params);

    accepted.set(token, q);
  }

  // A wildcard sets the floor for anything not named explicitly.
  const star = accepted.get("*");

  const allows = (token: string): boolean => {
    const q = accepted.get(token) ?? star;

    return q !== undefined && q > 0;
  };

  if (allows("br")) return "br";

  if (allows("gzip")) return "gzip";

  return "identity";
}

/** The `q=` weight of an `Accept-Encoding` token's params; defaults to 1 (accepted). */
function qValueOf(params: string[]): number {
  for (const param of params) {
    const eq = param.indexOf("=");

    if (eq === -1) continue;

    if (param.slice(0, eq).trim().toLowerCase() === "q") {
      const q = Number(param.slice(eq + 1));

      return Number.isNaN(q) ? 1 : q;
    }
  }

  return 1;
}

/** Read a header value (single or multi) by case-insensitive name as one string. */
function headerValue(headers: Record<string, string | string[]>, name: string): string | undefined {
  const lower = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return Array.isArray(value) ? value.join(", ") : value;
    }
  }

  return undefined;
}

/** Whether a response already carries a `Content-Encoding` (we never double-encode). */
function isAlreadyEncoded(headers: Record<string, string | string[]>): boolean {
  const encoding = headerValue(headers, "content-encoding");

  // An explicit `identity` is "not encoded"; any real coding means hands-off.
  return encoding !== undefined && encoding.toLowerCase() !== "identity";
}

/**
 * Whether a response body is worth compressing: a text-shaped content-type that
 * is not already encoded.
 *
 * The content-type allowlist ({@link COMPRESSIBLE_TYPES}) keeps us off bodies
 * that won't shrink — an image, a font, a video are already compressed, and
 * spending CPU to gzip them only makes them bigger. A response the app already
 * encoded is left untouched. Pure over the header map so the allow / skip /
 * already-encoded branches are unit-testable.
 */
export function isCompressibleType(headers: Record<string, string | string[]>): boolean {
  if (isAlreadyEncoded(headers)) return false;

  const contentType = headerValue(headers, "content-type");

  if (contentType === undefined) return false;

  const type = contentType.toLowerCase();

  // `text/event-stream` (SSE — ADR 0040's realtime fan-out) matches the `text/`
  // prefix but must NEVER be compressed: the on-the-fly zlib transform buffers
  // without a per-frame `Z_SYNC_FLUSH`, so frames are held back and never reach
  // `EventSource` — SSE is broken out of the box under the default-on compression.
  // The frames are tiny anyway, so there is nothing to gain. Excluded explicitly
  // here (route-independent), before the allowlist check.
  if (type.startsWith("text/event-stream")) return false;

  return COMPRESSIBLE_TYPES.some((prefix) => type.startsWith(prefix));
}

/** Drop any entry matching `name` case-insensitively, returning a fresh map. */
function withoutHeader(
  headers: Record<string, string | string[]>,
  name: string,
): Record<string, string | string[]> {
  const lower = name.toLowerCase();

  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== lower));
}

/**
 * Append a token to a comma-separated header (e.g. `Vary`), without duplicating
 * it.
 *
 * `Vary: Accept-Encoding` is the contract that a compressed response demands: a
 * shared cache MUST key on the request's `Accept-Encoding`, or it would serve a
 * brotli body to a client that only speaks gzip. We add the token to whatever
 * `Vary` the app already set (case-insensitively de-duped) rather than clobber
 * it, so an app varying on, say, `Cookie` keeps that.
 */
function appendVary(
  headers: Record<string, string | string[]>,
  token: string,
): Record<string, string | string[]> {
  const existing = headerValue(headers, "vary");

  const tokens = existing === undefined ? [] : existing.split(",").map((t) => t.trim());

  const present = tokens.some((t) => t.toLowerCase() === token.toLowerCase());

  const next = present ? tokens.join(", ") : [...tokens, token].join(", ");

  return { ...withoutHeader(headers, "vary"), Vary: next };
}

/** Brotli quality 5 — the practical sweet spot for on-the-fly text (good ratio, low latency). */
const BROTLI_QUALITY = 5;

/** Compress a buffered body with the chosen real coding (the caller handles `identity`). */
function compressBytes(bytes: Buffer, encoding: "br" | "gzip"): Buffer {
  if (encoding === "br") {
    return brotliCompressSync(bytes, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
    });
  }

  return gzipSync(bytes);
}

/**
 * Apply the negotiated content encoding to a BUFFERED response (string or bytes),
 * always setting an accurate `Content-Length`.
 *
 * Two jobs, both about getting the framing right:
 *
 *   - When `encoding` is `br`/`gzip`, the body is compressed to bytes, and the
 *     response gains `Content-Encoding`, a `Vary: Accept-Encoding`, and a
 *     `Content-Length` of the COMPRESSED size — so the wire framing matches the
 *     bytes that actually go out.
 *   - When `encoding` is `identity` (the client took nothing, or the type isn't
 *     compressible), the body is untouched but we still set `Content-Length` to
 *     its byte length — closing the gap where a buffered response went out with
 *     no declared length and forced chunked encoding for a body we knew in full.
 *
 * Pure and exported: it returns a fresh response (the input is never mutated, per
 * the per-response-object invariant), so the compressed-vs-identity and the
 * length-accounting branches are unit-testable without a socket. The caller has
 * already decided the body is buffered and the type compressible; this just
 * executes the chosen plan.
 */
export function encodeBuffered(
  response: AnyLestoResponse,
  body: string | Uint8Array,
  encoding: ContentEncoding,
): AnyLestoResponse {
  const raw = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);

  if (encoding === "identity") {
    return {
      ...response,
      headers: { ...response.headers, "Content-Length": String(raw.byteLength) },
      body: raw,
    };
  }

  const compressed = compressBytes(raw, encoding);

  return {
    ...response,
    headers: {
      ...appendVary(response.headers, "Accept-Encoding"),
      "Content-Encoding": encoding,
      "Content-Length": String(compressed.byteLength),
    },
    body: compressed,
  };
}

/**
 * The zlib transform that compresses a STREAMED body on the fly, or `undefined`
 * for `identity`.
 *
 * A stream cannot be length-prefixed (its size is unknown until it ends), so —
 * unlike the buffered arm — there is no `Content-Length` to set; the encoding is
 * declared by `Content-Encoding`/`Vary` (added by {@link encodeStreamHeaders})
 * and the bytes are chunked. The transform is piped between the source and the
 * socket in {@link applyResponse}.
 */
function streamCompressor(encoding: ContentEncoding): Transform | undefined {
  if (encoding === "br") {
    return createBrotliCompress({
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
    });
  }

  if (encoding === "gzip") return createGzip();

  return undefined;
}

/**
 * Add the `Content-Encoding`/`Vary` framing a compressed STREAM declares.
 *
 * The stream body itself is encoded by the {@link streamCompressor} transform in
 * {@link applyResponse}; this just stamps the headers that tell the client (and
 * any shared cache) how to read it. `identity` returns the headers untouched.
 */
export function encodeStreamHeaders(
  response: AnyLestoResponse,
  encoding: ContentEncoding,
): AnyLestoResponse {
  if (encoding === "identity") return response;

  return {
    ...response,
    headers: {
      ...appendVary(response.headers, "Accept-Encoding"),
      "Content-Encoding": encoding,
    },
  };
}

/**
 * Write a {@link LestoResponse} onto the socket: status line, headers, then body.
 *
 * The body has three arms (see `LestoBody`), each written the way its kind
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
 *
 * `options.streamEncoding`, when `br`/`gzip`, inserts a zlib transform between
 * the source stream and the socket so a streamed body is compressed on the fly;
 * the caller has already stamped the `Content-Encoding`/`Vary` framing (see
 * {@link encodeStreamHeaders}). It is ignored on the buffered arms — those are
 * compressed up front (see {@link encodeBuffered}), so a buffered body never
 * reaches the transform path. Truncation is still reported through the transform:
 * a source error or a client disconnect tears the whole chain down and fires
 * `onTruncated`, preserving the item-4 behavior.
 */
export function applyResponse(
  res: WritableResponse,
  response: AnyLestoResponse,
  options: {
    onTruncated?: (reason: unknown) => void;
    streamEncoding?: ContentEncoding;
  } = {},
): void | Promise<void> {
  res.writeHead(response.status, response.headers);

  const { body } = response;

  if (typeof body === "string") {
    res.end(body);

    return;
  }

  if (isReadableStream(body)) {
    // Flush the head to the socket immediately, before the first frame. A held
    // stream (SSE, ADR 0040) may emit NOTHING until its first real event or the
    // heartbeat seconds later; without this, node buffers the head until then and
    // the client's `EventSource`/`fetch` hangs "connecting" the whole time. A
    // buffered response never needs it — `end` flushes the head with the body.
    res.flushHeaders?.();

    const compressor =
      options.streamEncoding === undefined ? undefined : streamCompressor(options.streamEncoding);

    return pipeStream(res, body, {
      ...(options.onTruncated === undefined ? {} : { onTruncated: options.onTruncated }),
      ...(compressor === undefined ? {} : { transform: compressor }),
    });
  }

  // The remaining arm is `Uint8Array`: copy into a Buffer the socket can flush.
  res.end(Buffer.from(body));
}
