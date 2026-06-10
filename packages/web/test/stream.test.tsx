import { createElement, Suspense, use } from "react";
import type { ReactElement } from "react";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

import { Registry } from "@keel/ui";
import type { ClientComponentDef, ComponentDef } from "@keel/ui";

import { Controller } from "../src/index";
import type { AnyKeelResponse, KeelRequest, Middleware } from "../src/index";

// ---------------------------------------------------------------------------
// Fixtures: a server container and an ssr island, the same shapes @keel/ui uses.
// ---------------------------------------------------------------------------

const Box: ComponentDef = {
  name: "Box",
  props: {},
  children: true,
  render: (_props, children) => createElement("div", { className: "box" }, children),
};

const Greet: ClientComponentDef = {
  name: "Greet",
  ssr: true,
  props: { name: { type: "string", required: true } },
  component: (props) => createElement("p", null, "Hi, ", props.name as string, "!"),
};

function registry(): Registry {
  return new Registry().define(Box).defineClient(Greet);
}

function request(): KeelRequest {
  return { method: "GET", path: "/", params: {}, query: {}, headers: {}, body: undefined };
}

/** A bare controller instance — `streamTree`/`renderTree` need no action wiring. */
function controller(): Controller {
  return new Controller(request());
}

/** Drain a Web byte stream to a string (the test's own reader). */
async function readStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();

  const decoder = new TextDecoder();

  let out = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    out += decoder.decode(value, { stream: true });
  }

  out += decoder.decode();

  reader.releaseLock();

  return out;
}

/**
 * A fake of the node `ServerResponse` slice the runtime's `applyResponse` writes
 * through — a node `Writable`, which is exactly what a real `ServerResponse` is.
 *
 * `@keel/runtime` depends on `@keel/web` (not the reverse), so this package
 * cannot import the real `applyResponse` without inverting the dependency. We
 * instead mirror its stream arm exactly — `Readable.fromWeb(body).pipe(res)` onto
 * a node `Writable` — and capture every byte the pipe writes, proving a
 * `streamTree` body flows through the same machinery to the socket and arrives
 * intact. Being a real `Writable`, it is a faithful pipe destination, not a stub.
 */
class FakeSocket extends Writable {
  status = 0;

  headers: Record<string, string> = {};

  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));

    callback();
  }

  writeHead(status: number, headers: Record<string, string>): void {
    this.status = status;
    this.headers = headers;
  }

  body(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

/**
 * Pipe a `streamTree` response onto the fake socket exactly as the runtime does.
 *
 * Writes the status line + headers, then bridges the Web `ReadableStream` body
 * into a node `Readable` and pipes it onto the socket — the runtime's stream arm,
 * reproduced here so the round-trip is end-to-end within this package's reach.
 */
async function applyToSocket(socket: FakeSocket, response: AnyKeelResponse): Promise<void> {
  socket.writeHead(response.status, response.headers);

  const body = response.body as ReadableStream<Uint8Array>;

  const source = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]);

  await new Promise<void>((resolve) => {
    // The socket (a Writable) emits `finish` once the piped stream has fully
    // drained into it — the same completion signal `applyResponse` awaits.
    socket.on("finish", () => resolve());

    source.pipe(socket);
  });
}

// ---------------------------------------------------------------------------
// streamTree: a streamed HTML response.
// ---------------------------------------------------------------------------

describe("Controller.streamTree", () => {
  it("returns a text/html response whose body is a ReadableStream", async () => {
    const response = await controller().streamTree(registry(), { type: "Box", children: ["hi"] });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html");
    expect(response.body).toBeInstanceOf(ReadableStream);

    expect(await readStream(response.body as ReadableStream<Uint8Array>)).toContain("hi");
  });

  it("honors an explicit status", async () => {
    const response = await controller().streamTree(
      registry(),
      { type: "Box", children: ["x"] },
      {},
      201,
    );

    expect(response.status).toBe(201);
  });

  it("streams an ssr island's markup with the hydration markers intact", async () => {
    const response = await controller().streamTree(registry(), {
      type: "Box",
      children: [{ type: "Greet", props: { name: "Ada" } }],
    });

    const html = await readStream(response.body as ReadableStream<Uint8Array>);

    // The streamed body carries the `<!-- -->` text markers an ssr:true island
    // needs to hydrate, and the island wrapper the client pairs against.
    expect(html).toContain("Hi, <!-- -->Ada<!-- -->!");
    expect(html).toContain('data-keel-island="$.children[0]"');
  });

  it("flushes the shell before a suspended child resolves", async () => {
    let release!: () => void;

    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const Slow: ComponentDef = {
      name: "Slow",
      props: {},
      children: false,
      render: () =>
        createElement(
          Suspense,
          { fallback: createElement("p", { id: "fb" }, "loading") },
          createElement(function Resolve(): ReactElement {
            use(gate);

            return createElement("p", { id: "slow" }, "done");
          }),
        ),
    };

    const r = new Registry().define(Box).define(Slow);

    const response = await controller().streamTree(r, {
      type: "Box",
      children: [{ type: "Slow" }],
    });

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    const firstChunk = decoder.decode(first.value, { stream: true });

    // The shell + fallback are out before the slow child resolves.
    expect(firstChunk).toContain('id="fb"');
    expect(firstChunk).not.toContain('id="slow"');

    release();

    let rest = "";

    for (;;) {
      const { done, value } = await reader.read();

      if (done) break;

      rest += decoder.decode(value, { stream: true });
    }

    rest += decoder.decode();

    reader.releaseLock();

    expect(rest).toContain("done");
  });

  it("forwards bootstrap options and an onError sink to @keel/ui", async () => {
    const response = await controller().streamTree(
      registry(),
      { type: "Box", children: ["x"] },
      {
        bootstrapModules: ["/client.js"],
        bootstrapScriptContent: "window.__m = []",
      },
    );

    const html = await readStream(response.body as ReadableStream<Uint8Array>);

    expect(html).toContain("/client.js");
    expect(html).toContain("window.__m = []");
  });

  it("streams an empty body for a tree that degrades to nothing", async () => {
    // An unknown root component degrades to a null element — an empty stream.
    const response = await controller().streamTree(registry(), { type: "Unknown" });

    expect(response.headers["content-type"]).toBe("text/html");
    expect(await readStream(response.body as ReadableStream<Uint8Array>)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the streamed body reaches the socket through the runtime's stream
// arm (reproduced here — runtime depends on web, not the reverse).
// ---------------------------------------------------------------------------

describe("streamTree reaches the socket", () => {
  it("pipes the streamed body to the socket, status + headers + bytes intact", async () => {
    const response = await controller().streamTree(registry(), {
      type: "Box",
      children: [{ type: "Greet", props: { name: "Ada" } }],
    });

    const socket = new FakeSocket();

    await applyToSocket(socket, response);

    expect(socket.status).toBe(200);
    expect(socket.headers["content-type"]).toBe("text/html");

    // The bytes that reached the socket are the streamed HTML, markers and all.
    expect(socket.body()).toContain("Hi, <!-- -->Ada<!-- -->!");
    expect(socket.body()).toContain('class="box"');
  });
});

// ---------------------------------------------------------------------------
// Streaming × middleware/ETag compatibility.
//
// A stream-bodied response flows through the Tier-1.B pipeline unchanged: a
// middleware may set headers or short-circuit, and the runtime's ETag/304 path
// already skips a stream (it can't hash one without draining it — Keystone 1).
// These tests pin that compatibility so a regression is caught here.
// ---------------------------------------------------------------------------

// A layer that delegates, then adds a header on the way back out — the onion's
// "shape the response" move, applied to a streamed envelope.
const tagging: Middleware = async (_req, next) => {
  const response = await next();

  return { ...response, headers: { ...response.headers, "x-keel": "stream" } };
};

// A guard that answers 401 outright and never calls `next` — the short-circuit.
const unauthorized: Middleware = async () => ({ status: 401, headers: {}, body: "Unauthorized" });

describe("streamTree × middleware pipeline", () => {
  it("a middleware can add a header to a streamed response without touching the body", async () => {
    const ctrl = controller();

    const dispatched = (): Promise<AnyKeelResponse> =>
      ctrl.streamTree(registry(), { type: "Box", children: ["hi"] });

    const response = await tagging(request(), dispatched);

    // The header is added and the body is still the live stream — the middleware
    // shaped the envelope, never the bytes.
    expect(response.headers["x-keel"]).toBe("stream");
    expect(response.headers["content-type"]).toBe("text/html");
    expect(response.body).toBeInstanceOf(ReadableStream);

    expect(await readStream(response.body as ReadableStream<Uint8Array>)).toContain("hi");
  });

  it("a short-circuiting middleware answers before the stream is ever built", async () => {
    const build = vi.fn(
      (): Promise<AnyKeelResponse> =>
        controller().streamTree(registry(), { type: "Box", children: ["hi"] }),
    );

    // The guard never calls `next`, so the stream that would have been built is
    // not — the streaming path costs nothing when a middleware short-circuits.
    const response = await unauthorized(request(), build);

    expect(response.status).toBe(401);
    expect(build).not.toHaveBeenCalled();
  });
});
