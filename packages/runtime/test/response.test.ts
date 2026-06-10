import { describe, expect, it } from "vitest";

import { Writable } from "node:stream";

import { applyResponse } from "../src/index";

import type { WritableResponse } from "../src/index";

import { pipeStream } from "../src/response";

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
    | { kind: "writeHead"; status: number; headers: Record<string, string> }
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

  headers: Record<string, string> | undefined;

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

  writeHead(status: number, headers: Record<string, string>): void {
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

    const result = pipeStream(sink, streamOf(new Uint8Array([1])), () => {
      throw failure;
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
});
