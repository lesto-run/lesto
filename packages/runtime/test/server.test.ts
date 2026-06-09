import { request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serve } from "../src/index";
import { installProcessSafetyNet, readBody, requestLineOf, respondWithError } from "../src/server";

import type { BodyStream } from "../src/server";

import type { Server } from "../src/index";
import type { App } from "@keel/kernel";

// Track the live server so each test tears its socket down, even on failure.
let server: Server | undefined;

afterEach(async () => {
  if (server !== undefined) {
    await server.close();
    server = undefined;
  }
});

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Make a real socket request to the running server and read the full response. */
function makeRequest(
  port: number,
  options: { method: string; path: string; body?: string; contentType?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};

    if (options.contentType !== undefined) {
      headers["content-type"] = options.contentType;
    }

    const req = httpRequest(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => chunks.push(chunk));

        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );

    req.on("error", reject);

    if (options.body !== undefined) {
      req.write(options.body);
    }

    req.end();
  });
}

describe("serve", () => {
  it("answers a real GET request through the socket, echoing path and query", async () => {
    // A stub App typed as the real interface — enough to exercise the full
    // socket -> toKeelRequest -> handle -> applyResponse path live.
    const app: App = {
      migrationsApplied: [],

      handle: async (method, path, options) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, path, query: options?.query, body: options?.body }),
      }),
    };

    server = await serve(app, { port: 0 });

    expect(server.port).toBeGreaterThan(0);

    const response = await makeRequest(server.port, {
      method: "GET",
      path: "/posts?tag=math",
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(response.body)).toEqual({
      method: "GET",
      path: "/posts",
      query: { tag: "math" },
    });
  });

  it("reads a JSON POST body off the socket and hands it to the app", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async (_method, _path, options) => ({
        status: 201,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ received: options?.body }),
      }),
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequest(server.port, {
      method: "POST",
      path: "/posts",
      contentType: "application/json",
      body: '{"title":"Hello"}',
    });

    expect(response.status).toBe(201);
    expect(JSON.parse(response.body)).toEqual({ received: { title: "Hello" } });
  });

  it("defaults to an ephemeral port and the loopback host when no options are given", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async () => ({ status: 200, headers: {}, body: "ok" }),
    };

    server = await serve(app);

    expect(server.port).toBeGreaterThan(0);

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.body).toBe("ok");
  });

  it("binds the host when one is given", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async () => ({ status: 204, headers: {}, body: "" }),
    };

    server = await serve(app, { port: 0, host: "127.0.0.1" });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.status).toBe(204);
  });

  it("answers a malformed JSON body with 400 and keeps serving (no crash)", async () => {
    // The app must never be reached: the body fails to decode first.
    const app: App = {
      migrationsApplied: [],

      handle: async () => ({ status: 200, headers: {}, body: "should not run" }),
    };

    server = await serve(app, { port: 0 });

    const bad = await makeRequest(server.port, {
      method: "POST",
      path: "/posts",
      contentType: "application/json",
      body: "{not json",
    });

    expect(bad.status).toBe(400);
    expect(bad.body).toBe("Bad Request");
    expect(bad.body).not.toContain("SyntaxError");

    // The process survived: a following request is still served.
    const ok = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(ok.status).toBe(200);
  });

  it("turns a handler that throws into a 500 with a safe body, then ends the socket", async () => {
    const logged: unknown[] = [];

    const app: App = {
      migrationsApplied: [],

      handle: async () => {
        throw new Error("boom: db password is hunter2");
      },
    };

    // An injected logError proves the throw was caught here, not as an
    // unhandled rejection escaping the `void handle(...)`.
    server = await serve(app, {
      port: 0,
      logError: (_message, error) => logged.push(error),
    });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.status).toBe(500);
    expect(response.body).toBe("Internal Server Error");
    // The secret in the thrown message never reaches the wire.
    expect(response.body).not.toContain("hunter2");

    expect(logged).toHaveLength(1);
    expect(logged[0]).toBeInstanceOf(Error);
  });

  it("logs a 500 through the default sink when no logError is injected", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const app: App = {
      migrationsApplied: [],

      handle: async () => {
        throw new Error("boom");
      },
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith("unhandled error serving request", expect.any(Error));

    errorSpy.mockRestore();
  });

  it("refuses an oversized body with 413 and reads no more of it", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async () => ({ status: 200, headers: {}, body: "unreached" }),
    };

    server = await serve(app, { port: 0, maxBodyBytes: 8 });

    const response = await makeRequest(server.port, {
      method: "POST",
      path: "/upload",
      contentType: "text/plain",
      body: "x".repeat(64),
    });

    expect(response.status).toBe(413);
    expect(response.body).toBe("Payload Too Large");
  });

  it("still parses a valid JSON body within the limit", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async (_method, _path, options) => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ echoed: options?.body }),
      }),
    };

    server = await serve(app, { port: 0, maxBodyBytes: 1024 });

    const response = await makeRequest(server.port, {
      method: "POST",
      path: "/posts",
      contentType: "application/json",
      body: '{"title":"Hello"}',
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ echoed: { title: "Hello" } });
  });
});

/** A fake body stream: a bare EventEmitter satisfies the narrow BodyStream shape. */
function fakeStream(): BodyStream & { emitter: EventEmitter } {
  const emitter = new EventEmitter();

  const stream = {
    emitter,
    on: (event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return stream;
    },
  };

  return stream as unknown as BodyStream & { emitter: EventEmitter };
}

describe("readBody", () => {
  it("concatenates chunks within the limit into a UTF-8 string", async () => {
    const stream = fakeStream();

    const read = readBody(stream, 1024);

    stream.emitter.emit("data", Buffer.from("ab"));
    stream.emitter.emit("data", Buffer.from("cd"));
    stream.emitter.emit("end");

    expect(await read).toBe("abcd");
  });

  it("rejects with RUNTIME_BODY_TOO_LARGE and buffers no more once past the limit", async () => {
    const stream = fakeStream();

    const read = readBody(stream, 3);

    stream.emitter.emit("data", Buffer.from("abcd"));

    // Late chunks and a late end arrive after the abort: they must be ignored,
    // not buffered, and must not resolve the already-rejected promise.
    stream.emitter.emit("data", Buffer.from("more"));
    stream.emitter.emit("end");

    await expect(read).rejects.toMatchObject({ code: "RUNTIME_BODY_TOO_LARGE" });
  });

  it("rejects when the underlying stream errors mid-body", async () => {
    const stream = fakeStream();

    const read = readBody(stream, 1024);

    const failure = new Error("socket reset");

    stream.emitter.emit("error", failure);

    await expect(read).rejects.toBe(failure);
  });
});

describe("respondWithError", () => {
  it("writes a fresh status and safe body when headers have not been sent", () => {
    const calls: Array<{ status: number; headers: Record<string, string> }> = [];

    let ended: string | undefined;

    respondWithError(
      {
        headersSent: false,
        writeHead: (status, headers) => calls.push({ status, headers }),
        end: (body) => {
          ended = body;
        },
      },
      413,
    );

    expect(calls).toEqual([
      { status: 413, headers: { "content-type": "text/plain; charset=utf-8" } },
    ]);
    expect(ended).toBe("Payload Too Large");
  });

  it("only ends the socket — never re-heads — once headers are already sent", () => {
    let wroteHead = false;

    let endedArg: string | undefined = "untouched";

    respondWithError(
      {
        headersSent: true,
        writeHead: () => {
          wroteHead = true;
        },
        end: (body) => {
          endedArg = body;
        },
      },
      500,
    );

    expect(wroteHead).toBe(false);
    // end() is called with no body, so the socket closes without a second write.
    expect(endedArg).toBeUndefined();
  });
});

describe("installProcessSafetyNet", () => {
  it("registers a single unhandledRejection listener that logs and keeps serving", () => {
    const listeners: Array<(reason: unknown) => void> = [];

    const target = {
      on: (_event: "unhandledRejection", listener: (reason: unknown) => void) => {
        listeners.push(listener);
      },
    };

    const logged: Array<{ message: string; error: unknown }> = [];

    const log = (message: string, error: unknown) => logged.push({ message, error });

    installProcessSafetyNet(log, target);

    // Idempotent: a second install on the same target adds no second listener.
    installProcessSafetyNet(log, target);

    expect(listeners).toHaveLength(1);

    const reason = new Error("stray rejection");

    listeners[0]?.(reason);

    expect(logged).toEqual([{ message: "unhandled rejection (kept serving)", error: reason }]);
  });
});

describe("requestLineOf", () => {
  it("passes through the method and url of a real server request", () => {
    expect(requestLineOf({ method: "POST", url: "/x" })).toEqual({ method: "POST", url: "/x" });
  });

  it("defaults a missing method and url defensively", () => {
    expect(requestLineOf({ method: undefined, url: undefined })).toEqual({
      method: "GET",
      url: "/",
    });
  });
});
