import { describe, expect, it } from "vitest";

import { Readable, Writable } from "node:stream";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { applyResponse } from "../src/index";

import type { WritableResponse } from "../src/index";

import {
  encodeBuffered,
  encodeStreamHeaders,
  isCompressibleType,
  negotiateEncoding,
  pipeStream,
} from "../src/response";

import type { AnyKeelResponse } from "@keel/web";

/**
 * A plain-object `WritableResponse` for the buffered arms (string, bytes).
 *
 * It records `writeHead` and every `end` payload — the only effects those arms
 * produce. `on`/`destroy` are present to satisfy the interface but never called
 * by a buffered body, so they record nothing.
 */
function bufferedResponse(): {
  res: WritableResponse;
  calls: Array<
    | { kind: "writeHead"; status: number; headers: Record<string, string | string[]> }
    | { kind: "end"; body: string | Uint8Array | undefined }
  >;
} {
  const calls: ReturnType<typeof bufferedResponse>["calls"] = [];

  const res: WritableResponse = {
    writeHead: (status, headers) => calls.push({ kind: "writeHead", status, headers }),
    end: (body) => calls.push({ kind: "end", body }),
    on: () => res,
    destroy: () => {},
  };

  return { res, calls };
}

/**
 * A real node `Writable` that also satisfies `WritableResponse`, for the stream
 * arm — which pipes through node's real stream machinery and so needs a genuine
 * destination, not a plain object.
 *
 * It collects every written chunk (so a test can assert the streamed bytes),
 * records the `writeHead` status/headers, and tracks whether `destroy` ran and
 * with what error.
 */
class StreamSink extends Writable implements WritableResponse {
  readonly chunks: Buffer[] = [];

  status: number | undefined;

  headers: Record<string, string | string[]> | undefined;

  destroyedWith: Error | undefined;

  destroyCalled = false;

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.from(chunk));

    callback();
  }

  writeHead(status: number, headers: Record<string, string | string[]>): void {
    this.status = status;
    this.headers = headers;
  }

  override destroy(error?: Error): this {
    this.destroyCalled = true;
    this.destroyedWith = error;

    return super.destroy(error);
  }

  body(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** A Web `ReadableStream` over a fixed list of byte chunks. */
function streamOf(...chunks: Uint8Array[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }

      controller.close();
    },
  });
}

/** A Web `ReadableStream` that errors immediately, emitting nothing. */
function failingStream(error: Error): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.error(error);
    },
  });
}

describe("applyResponse", () => {
  it("writes the status and headers, then ends with a string body", () => {
    const { res, calls } = bufferedResponse();

    const result = applyResponse(res, {
      status: 201,
      headers: { "content-type": "application/json" },
      body: '{"id":1}',
    });

    // A buffered body has nothing to await: it returns void, not a promise.
    expect(result).toBeUndefined();

    expect(calls).toEqual([
      { kind: "writeHead", status: 201, headers: { "content-type": "application/json" } },
      { kind: "end", body: '{"id":1}' },
    ]);
  });

  it("ends a Uint8Array body as a Buffer, byte-for-byte intact", () => {
    const { res, calls } = bufferedResponse();

    // Bytes a UTF-8 round trip would mangle: a lone 0xFF is not valid UTF-8.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);

    const result = applyResponse(res, {
      status: 200,
      headers: { "content-type": "image/png" },
      body: bytes,
    });

    expect(result).toBeUndefined();

    expect(calls[0]).toEqual({
      kind: "writeHead",
      status: 200,
      headers: { "content-type": "image/png" },
    });

    const ended = calls[1];

    expect(ended?.kind).toBe("end");

    // The flushed body is a Buffer carrying exactly the input bytes.
    expect(Buffer.isBuffer((ended as { body: unknown }).body)).toBe(true);
    expect(Array.from((ended as { body: Uint8Array }).body)).toEqual(Array.from(bytes));
  });

  it("streams a ReadableStream body to the socket and resolves when flushed", async () => {
    const sink = new StreamSink();

    const result = applyResponse(sink, {
      status: 200,
      headers: { "content-type": "text/html" },
      body: streamOf(new Uint8Array([1, 2]), new Uint8Array([3])),
    });

    // The stream arm returns a promise the caller may await for full delivery.
    expect(result).toBeInstanceOf(Promise);

    await result;

    // Headers go out first; then the bytes arrive in order through the pipe.
    expect(sink.status).toBe(200);
    expect(sink.headers).toEqual({ "content-type": "text/html" });
    expect(Array.from(sink.body())).toEqual([1, 2, 3]);

    // A clean, fully-delivered stream is never torn down *with an error* — node
    // may auto-destroy the finished writable, but never carrying a failure.
    expect(sink.destroyedWith).toBeUndefined();
  });

  it("destroys the socket when the stream source errors, never crashing", async () => {
    const sink = new StreamSink();

    const failure = new Error("producer blew up mid-stream");

    const result = applyResponse(sink, {
      status: 200,
      headers: { "content-type": "text/html" },
      body: failingStream(failure),
    });

    // Resolves rather than rejecting: a stream error is handled, not thrown.
    await expect(result).resolves.toBeUndefined();

    // Headers were already sent, so the only honest signal of a truncated body
    // is tearing the socket down — which we did, carrying the underlying error.
    expect(sink.destroyCalled).toBe(true);
    expect(sink.destroyedWith).toBe(failure);
  });

  it("destroys the socket when the stream bridge throws synchronously", async () => {
    const sink = new StreamSink();

    // The real `Readable.fromWeb` throws synchronously on a body that is already
    // locked or disturbed (someone read it first). We inject a bridge that throws
    // the same way: there is no node `Readable` to pipe, so the executor must tear
    // the socket down and resolve — keeping the never-rejects invariant total
    // rather than leaning on the process safety net.
    const failure = new TypeError("Invalid state: ReadableStream is locked");

    const result = pipeStream(sink, streamOf(new Uint8Array([1])), {
      bridge: () => {
        throw failure;
      },
    });

    // Resolves rather than rejecting: even a synchronous construction failure is
    // handled in-band, not left to surface as an unhandled rejection.
    await expect(result).resolves.toBeUndefined();

    // Headers are already on the wire by the time the bridge runs, so tearing the
    // socket down — carrying the construction error — is the only honest signal of
    // a body that never flowed.
    expect(sink.destroyCalled).toBe(true);
    expect(sink.destroyedWith).toBe(failure);
  });

  it("resolves without throwing when the destination (the client) errors", async () => {
    const sink = new StreamSink();

    // A stream that never settles on its own: only the destination error ends it.
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        // Enqueue nothing and never close — the body stays "in flight".
      },
    });

    const result = applyResponse(sink, {
      status: 200,
      headers: { "content-type": "text/html" },
      body: stalled,
    });

    // The client hangs up: emitting `error` on the destination must not surface
    // as an uncaught throw — `applyResponse` swallows it and resolves.
    sink.emit("error", new Error("client went away"));

    await expect(result).resolves.toBeUndefined();
  });

  it("destroys the source when the destination errors, so its resource is freed", async () => {
    const sink = new StreamSink();

    // A real readable that never ends on its own — only the destination error
    // ends the pipe. `pipe` alone would leave it (and whatever backs it: a file
    // descriptor, a db cursor, an upstream fetch) running for the life of the
    // process; pipeStream must tear it down. We inject it via the bridge so the
    // pipe runs over this exact source and we can assert it was destroyed.
    const source = new Readable({ read() {} });

    const result = pipeStream(sink, streamOf(new Uint8Array([1])), { bridge: () => source });

    sink.emit("error", new Error("client went away"));

    await expect(result).resolves.toBeUndefined();

    // The leak fix: the source is destroyed, not left running after the client left.
    expect(source.destroyed).toBe(true);
  });

  it("forwards a truncation through applyResponse's onTruncated sink on a source error", async () => {
    const sink = new StreamSink();

    const failure = new Error("producer blew up mid-stream");

    const reasons: unknown[] = [];

    // applyResponse threads its onTruncated down to pipeStream for the stream arm.
    const result = applyResponse(
      sink,
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: failingStream(failure),
      },
      { onTruncated: (reason) => reasons.push(reason) },
    );

    await expect(result).resolves.toBeUndefined();

    // The producer's error is the honest truncation reason, reported exactly once.
    expect(reasons).toEqual([failure]);
  });

  it("reports a client-disconnect truncation with the destination error", async () => {
    const sink = new StreamSink();

    const stalled = new ReadableStream<Uint8Array>({
      start() {
        // Never closes — only the destination error ends it.
      },
    });

    const reasons: unknown[] = [];

    const disconnect = new Error("client went away");

    const result = pipeStream(sink, stalled, { onTruncated: (reason) => reasons.push(reason) });

    sink.emit("error", disconnect);

    await expect(result).resolves.toBeUndefined();

    expect(reasons).toEqual([disconnect]);
  });

  it("reports a bridge-throw truncation with the construction error", async () => {
    const sink = new StreamSink();

    const failure = new TypeError("Invalid state: ReadableStream is locked");

    const reasons: unknown[] = [];

    const result = pipeStream(sink, streamOf(new Uint8Array([1])), {
      onTruncated: (reason) => reasons.push(reason),
      bridge: () => {
        throw failure;
      },
    });

    await expect(result).resolves.toBeUndefined();

    expect(reasons).toEqual([failure]);
  });

  it("does not report a truncation for a clean, fully-flushed stream", async () => {
    const sink = new StreamSink();

    const reasons: unknown[] = [];

    const result = applyResponse(
      sink,
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: streamOf(new Uint8Array([1, 2, 3])),
      },
      { onTruncated: (reason) => reasons.push(reason) },
    );

    await result;

    // A clean delivery never fires the sink — the field stays quiet.
    expect(reasons).toEqual([]);
  });

  it("fires the truncation sink at most once even if the source and destination both error", async () => {
    const sink = new StreamSink();

    // A source that errors AND a destination error: only one truncation report.
    const source = new Readable({ read() {} });

    const reasons: unknown[] = [];

    const result = pipeStream(sink, streamOf(new Uint8Array([1])), {
      onTruncated: (reason) => reasons.push(reason),
      bridge: () => source,
    });

    // Destination error first (the client hung up), then the source errors too.
    sink.emit("error", new Error("client went away"));
    source.emit("error", new Error("source also blew up"));

    await expect(result).resolves.toBeUndefined();

    // The guard collapses the two tear-down paths into a single report.
    expect(reasons.length).toBe(1);
  });
});

/** Read a header value (single or list) by case-insensitive name as one string. */
function header(
  headers: Record<string, string | string[]>,
  name: string,
): string | string[] | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }

  return undefined;
}

describe("negotiateEncoding", () => {
  it("prefers brotli, then gzip, then identity", () => {
    expect(negotiateEncoding("br, gzip")).toBe("br");
    expect(negotiateEncoding("gzip, deflate")).toBe("gzip");
    expect(negotiateEncoding("deflate")).toBe("identity");
  });

  it("treats a missing Accept-Encoding as identity", () => {
    expect(negotiateEncoding(undefined)).toBe("identity");
  });

  it("honors an explicit q=0 that forbids an encoding", () => {
    // The client allows gzip but forbids brotli — gzip wins despite the br preference.
    expect(negotiateEncoding("br;q=0, gzip")).toBe("gzip");
    // Everything forbidden → identity.
    expect(negotiateEncoding("br;q=0, gzip;q=0")).toBe("identity");
  });

  it("falls back to identity on a wildcard that forbids everything", () => {
    expect(negotiateEncoding("*;q=0")).toBe("identity");
    // A positive wildcard offers br (the top preference).
    expect(negotiateEncoding("*")).toBe("br");
  });

  it("ignores an empty token and a malformed q value", () => {
    // A trailing comma yields an empty token; a non-numeric q falls back to 1.
    expect(negotiateEncoding("gzip;q=oops, ")).toBe("gzip");
  });

  it("skips parameters that are not a q-value (no '=', or a different key)", () => {
    // `foo` has no `=`; `level=2` has `=` but is not `q`. Neither forbids gzip.
    expect(negotiateEncoding("gzip;foo;level=2")).toBe("gzip");
  });
});

describe("isCompressibleType", () => {
  it("accepts text-shaped content types", () => {
    expect(isCompressibleType({ "content-type": "text/html; charset=utf-8" })).toBe(true);
    expect(isCompressibleType({ "content-type": "application/json" })).toBe(true);
    expect(isCompressibleType({ "Content-Type": "image/svg+xml" })).toBe(true);
  });

  it("rejects an already-compressed binary type", () => {
    expect(isCompressibleType({ "content-type": "image/png" })).toBe(false);
  });

  it("rejects a response that is already content-encoded", () => {
    expect(isCompressibleType({ "content-type": "text/html", "content-encoding": "gzip" })).toBe(
      false,
    );
    // An explicit `identity` encoding is treated as not-encoded.
    expect(
      isCompressibleType({ "content-type": "text/html", "content-encoding": "identity" }),
    ).toBe(true);
  });

  it("rejects a response with no content-type", () => {
    expect(isCompressibleType({})).toBe(false);
  });

  it("reads a multi-valued content-type by joining it", () => {
    // A (degenerate) list content-type is collapsed before the prefix check.
    expect(isCompressibleType({ "content-type": ["text/html"] })).toBe(true);
  });
});

const htmlResponse = (body: string | Uint8Array): AnyKeelResponse => ({
  status: 200,
  headers: { "content-type": "text/html" },
  body,
});

describe("encodeBuffered", () => {
  it("sets Content-Length on an identity (uncompressed) body", () => {
    const response = htmlResponse("hello");

    const encoded = encodeBuffered(response, "hello", "identity");

    expect(header(encoded.headers, "content-length")).toBe("5");
    expect(header(encoded.headers, "content-encoding")).toBeUndefined();
    // The body is the raw bytes, unchanged.
    expect(Buffer.isBuffer(encoded.body)).toBe(true);
    expect((encoded.body as Buffer).toString("utf8")).toBe("hello");
  });

  it("gzip-compresses a buffered body, with framing and a compressed length", () => {
    const text = "the quick brown fox ".repeat(50);
    const response = htmlResponse(text);

    const encoded = encodeBuffered(response, text, "gzip");

    expect(header(encoded.headers, "content-encoding")).toBe("gzip");
    expect(header(encoded.headers, "vary")).toBe("Accept-Encoding");

    const compressed = encoded.body as Buffer;

    // The declared length matches the compressed bytes, which decompress back.
    expect(header(encoded.headers, "content-length")).toBe(String(compressed.byteLength));
    expect(gunzipSync(compressed).toString("utf8")).toBe(text);
  });

  it("brotli-compresses a buffered body and round-trips", () => {
    const text = "lorem ipsum dolor sit amet ".repeat(40);

    const encoded = encodeBuffered(htmlResponse(text), text, "br");

    expect(header(encoded.headers, "content-encoding")).toBe("br");
    expect(brotliDecompressSync(encoded.body as Buffer).toString("utf8")).toBe(text);
  });

  it("compresses a Uint8Array body too, byte-accurately", () => {
    const bytes = new TextEncoder().encode("payload ".repeat(30));

    const encoded = encodeBuffered(
      { status: 200, headers: { "content-type": "application/json" }, body: bytes },
      bytes,
      "gzip",
    );

    expect(gunzipSync(encoded.body as Buffer)).toEqual(Buffer.from(bytes));
  });

  it("appends Accept-Encoding to an existing Vary without clobbering it", () => {
    const response: AnyKeelResponse = {
      status: 200,
      headers: { "content-type": "text/html", Vary: "Cookie" },
      body: "x".repeat(100),
    };

    const encoded = encodeBuffered(response, "x".repeat(100), "gzip");

    expect(header(encoded.headers, "vary")).toBe("Cookie, Accept-Encoding");
  });

  it("does not duplicate Accept-Encoding when Vary already lists it", () => {
    const response: AnyKeelResponse = {
      status: 200,
      headers: { "content-type": "text/html", vary: "accept-encoding" },
      body: "y".repeat(100),
    };

    const encoded = encodeBuffered(response, "y".repeat(100), "gzip");

    expect(header(encoded.headers, "vary")).toBe("accept-encoding");
  });
});

describe("encodeStreamHeaders", () => {
  it("stamps Content-Encoding and Vary for a compressed stream", () => {
    const response = htmlResponse("ignored");

    const encoded = encodeStreamHeaders(response, "br");

    expect(header(encoded.headers, "content-encoding")).toBe("br");
    expect(header(encoded.headers, "vary")).toBe("Accept-Encoding");
    // No Content-Length: a stream's size is unknown until it ends.
    expect(header(encoded.headers, "content-length")).toBeUndefined();
  });

  it("returns the response untouched for identity", () => {
    const response = htmlResponse("ignored");

    expect(encodeStreamHeaders(response, "identity")).toBe(response);
  });
});

describe("applyResponse — stream compression", () => {
  it("compresses a streamed body through the zlib transform (gzip)", async () => {
    const sink = new StreamSink();

    const text = "streamed html ".repeat(40);

    const result = applyResponse(
      sink,
      {
        status: 200,
        headers: { "content-type": "text/html", "content-encoding": "gzip" },
        body: streamOf(new TextEncoder().encode(text)),
      },
      { streamEncoding: "gzip" },
    );

    expect(result).toBeInstanceOf(Promise);

    await result;

    // The bytes on the wire are gzip — decompressing them yields the source text.
    expect(gunzipSync(sink.body()).toString("utf8")).toBe(text);
  });

  it("compresses a streamed body through the zlib transform (brotli)", async () => {
    const sink = new StreamSink();

    const text = "streamed brotli ".repeat(40);

    await applyResponse(
      sink,
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: streamOf(new TextEncoder().encode(text)),
      },
      { streamEncoding: "br" },
    );

    expect(brotliDecompressSync(sink.body()).toString("utf8")).toBe(text);
  });

  it("leaves a streamed body uncompressed when streamEncoding is identity", async () => {
    const sink = new StreamSink();

    await applyResponse(
      sink,
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: streamOf(new TextEncoder().encode("plain")),
      },
      { streamEncoding: "identity" },
    );

    // No transform inserted: the raw bytes reach the socket verbatim.
    expect(sink.body().toString("utf8")).toBe("plain");
  });

  it("reports truncation through the compressor when the source errors", async () => {
    const sink = new StreamSink();

    const failure = new Error("producer blew up");
    const reasons: unknown[] = [];

    const result = applyResponse(
      sink,
      {
        status: 200,
        headers: { "content-type": "text/html" },
        body: failingStream(failure),
      },
      { streamEncoding: "gzip", onTruncated: (reason) => reasons.push(reason) },
    );

    await expect(result).resolves.toBeUndefined();

    // The source error tears the whole chain down and is reported once.
    expect(reasons).toEqual([failure]);
    expect(sink.destroyCalled).toBe(true);
  });

  it("tears the compressor down when the destination (client) errors", async () => {
    const sink = new StreamSink();

    const stalled = new ReadableStream<Uint8Array>({
      start() {
        // Never closes — only the destination error ends it.
      },
    });

    const reasons: unknown[] = [];

    const result = applyResponse(
      sink,
      { status: 200, headers: { "content-type": "text/html" }, body: stalled },
      { streamEncoding: "gzip", onTruncated: (reason) => reasons.push(reason) },
    );

    const disconnect = new Error("client went away");
    sink.emit("error", disconnect);

    await expect(result).resolves.toBeUndefined();

    expect(reasons).toEqual([disconnect]);
  });

  it("reports truncation when the compressor itself errors", async () => {
    const sink = new StreamSink();

    const reasons: unknown[] = [];

    // Drive pipeStream with a transform that errors after the pipe is wired, so
    // the transform's own error path tears the socket down and reports.
    const { createGzip } = await import("node:zlib");
    const transform = createGzip();

    const result = pipeStream(sink, streamOf(new Uint8Array([1, 2, 3])), {
      transform,
      onTruncated: (reason) => reasons.push(reason),
    });

    const boom = new Error("compressor fault");
    transform.emit("error", boom);

    await expect(result).resolves.toBeUndefined();

    expect(reasons).toEqual([boom]);
    expect(sink.destroyCalled).toBe(true);
  });

  it("frees the compressor when the bridge throws synchronously", async () => {
    const sink = new StreamSink();

    const { createGzip } = await import("node:zlib");
    const transform = createGzip();

    const failure = new TypeError("locked stream");

    const result = pipeStream(sink, streamOf(new Uint8Array([1])), {
      transform,
      bridge: () => {
        throw failure;
      },
    });

    await expect(result).resolves.toBeUndefined();

    // The compressor is torn down on the synchronous-throw path too.
    expect(transform.destroyed).toBe(true);
    expect(sink.destroyedWith).toBe(failure);
  });
});
