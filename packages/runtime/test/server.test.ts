import { request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serve } from "../src/index";
import {
  applyServerLimits,
  drainServer,
  healthResponse,
  ifNoneMatch,
  installProcessSafetyNet,
  readBody,
  requestAbortSignal,
  requestLineOf,
  respondWithError,
  securityDefaults,
  withEtag,
  withSecurityHeaders,
  withTimeout,
} from "../src/server";
import { etagFor } from "../src/index";
import { RuntimeError } from "../src/errors";

import type {
  AbortableResponse,
  BodyStream,
  ClosableServer,
  DrainTimers,
  ServerLimits,
} from "../src/server";

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
  options: {
    method: string;
    path: string;
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...options.headers };

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

  it("merges default security headers under every response", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: "hi" }),
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    // The extended hardening: a cross-origin opener boundary and a restrictive
    // permissions policy ship by default too.
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );
    // No CSP and no COEP by default — both would break common pages/subresources.
    expect(response.headers["content-security-policy"]).toBeUndefined();
    expect(response.headers["cross-origin-embedder-policy"]).toBeUndefined();
    // The app's own header is untouched by the merge.
    expect(response.headers["content-type"]).toBe("text/html");
  });

  it("emits an enforcing CSP when one is configured", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: "hi" }),
    };

    server = await serve(app, {
      port: 0,
      csp: { policy: "default-src 'self'", mode: "enforce" },
    });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["content-security-policy"]).toBe("default-src 'self'");
    expect(response.headers["content-security-policy-report-only"]).toBeUndefined();
  });

  it("emits a report-only CSP under the report-only header when asked", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: "hi" }),
    };

    server = await serve(app, {
      port: 0,
      csp: { policy: "default-src 'self'", mode: "report-only" },
    });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["content-security-policy-report-only"]).toBe("default-src 'self'");
    expect(response.headers["content-security-policy"]).toBeUndefined();
  });

  it("opts in to COEP only when explicitly enabled", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: { "content-type": "text/html" }, body: "hi" }),
    };

    server = await serve(app, { port: 0, crossOriginEmbedderPolicy: true });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["cross-origin-embedder-policy"]).toBe("require-corp");
  });

  it("omits security headers when they are disabled", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "hi" }),
    };

    server = await serve(app, { port: 0, securityHeaders: false });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["x-content-type-options"]).toBeUndefined();
  });

  it("uses a custom security-header map when one is given", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "hi" }),
    };

    server = await serve(app, { port: 0, securityHeaders: { "X-Custom": "1" } });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["x-custom"]).toBe("1");
    // The replaced map means the defaults are no longer sent.
    expect(response.headers["x-content-type-options"]).toBeUndefined();
  });

  it("answers /health and /readyz before the app, and 503 when not ready", async () => {
    // An app that throws proves the probe answers without ever reaching it.
    const app: App = {
      migrationsApplied: [],
      handle: async () => {
        throw new Error("app must not be reached for a health probe");
      },
    };

    server = await serve(app, { port: 0, logError: () => {} });

    const live = await makeRequest(server.port, { method: "GET", path: "/health" });
    expect(live.status).toBe(200);
    expect(live.body).toBe("ok");

    const ready = await makeRequest(server.port, { method: "GET", path: "/readyz" });
    expect(ready.status).toBe(200);
    expect(ready.body).toBe("ready");

    // A POST to a health path is not a probe — it falls through to the (throwing) app.
    const posted = await makeRequest(server.port, { method: "POST", path: "/health" });
    expect(posted.status).toBe(500);
  });

  it("reports 503 from /readyz when the readiness probe is false", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "unreached" }),
    };

    server = await serve(app, { port: 0, health: { isReady: () => false } });

    const response = await makeRequest(server.port, { method: "GET", path: "/readyz" });

    expect(response.status).toBe(503);
    expect(response.body).toBe("not ready");
  });

  it("lets the app own health paths when health is disabled", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async (_method, path) => ({ status: 200, headers: {}, body: `app:${path}` }),
    };

    server = await serve(app, { port: 0, health: false });

    const response = await makeRequest(server.port, { method: "GET", path: "/health" });

    expect(response.body).toBe("app:/health");
  });

  it("answers 503 when a handler overruns its timeout, and keeps serving", async () => {
    let resolved = false;

    const app: App = {
      migrationsApplied: [],
      handle: (_method, path) =>
        path === "/slow"
          ? new Promise(() => {
              // Never resolves: the timeout must free the socket.
            })
          : Promise.resolve({ status: 200, headers: {}, body: "fast" }).then((r) => {
              resolved = true;
              return r;
            }),
    };

    server = await serve(app, { port: 0, handlerTimeoutMs: 20 });

    const slow = await makeRequest(server.port, { method: "GET", path: "/slow" });
    expect(slow.status).toBe(503);
    expect(slow.body).toBe("Service Unavailable");

    // The process survived the abandoned handler: a following request still serves.
    const ok = await makeRequest(server.port, { method: "GET", path: "/" });
    expect(ok.status).toBe(200);
    expect(resolved).toBe(true);
  });

  it("access-logs every request with method, path, status, and latency", async () => {
    const entries: Array<{ method: string; path: string; status: number; ms: number }> = [];

    const ticks = [1000, 1042];
    let i = 0;

    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 201, headers: {}, body: "made" }),
    };

    server = await serve(app, {
      port: 0,
      logRequest: (entry) => entries.push(entry),
      now: () => ticks[i++] ?? 0,
      // A stable id so the access entry asserts byte-for-byte.
      newRequestId: () => "req-1",
    });

    await makeRequest(server.port, { method: "POST", path: "/posts" });

    expect(entries).toEqual([
      { method: "POST", path: "/posts", status: 201, ms: 42, requestId: "req-1" },
    ]);
  });

  it("mints one span per request when a tracer is wired — the trace twin of the access line", async () => {
    // A recording tracer satisfying the structural RequestTracer seam, standing
    // in for @keel/observability's Tracer.
    const spans: Array<{
      name: string;
      attributes: Record<string, unknown>;
      status?: string;
      ended: boolean;
    }> = [];

    const tracer = {
      startSpan: (name: string) => {
        const record: (typeof spans)[number] = { name, attributes: {}, ended: false };

        spans.push(record);

        return {
          setAttribute: (key: string, value: unknown) => (record.attributes[key] = value),
          setStatus: (status: "ok" | "error") => (record.status = status),
          end: () => (record.ended = true),
        };
      },
    };

    const app: App = {
      migrationsApplied: [],
      handle: async (_method, path) => {
        if (path === "/boom") throw new Error("kaboom");

        return { status: 201, headers: {}, body: "made" };
      },
    };

    server = await serve(app, {
      port: 0,
      tracer,
      logError: () => {},
      newRequestId: () => "req-9",
    });

    await makeRequest(server.port, { method: "POST", path: "/posts" });
    await makeRequest(server.port, { method: "GET", path: "/boom" });

    expect(spans).toEqual([
      {
        name: "http.request",
        attributes: {
          "http.method": "POST",
          "http.path": "/posts",
          "http.status_code": 201,
          "keel.request_id": "req-9",
        },
        status: "ok",
        ended: true,
      },
      {
        name: "http.request",
        attributes: {
          "http.method": "GET",
          "http.path": "/boom",
          "http.status_code": 500,
          "keel.request_id": "req-9",
        },
        status: "error",
        ended: true,
      },
    ]);
  });

  it("tags an HTML response with an ETag and 304s a matching conditional GET", async () => {
    const entries: Array<{ method: string; path: string; status: number; ms: number }> = [];

    const app: App = {
      migrationsApplied: [],
      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<h1>Home</h1>",
      }),
    };

    server = await serve(app, { port: 0, logRequest: (entry) => entries.push(entry) });

    // First request: a full body plus the ETag the client should cache against.
    const first = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(first.status).toBe(200);
    expect(first.body).toBe("<h1>Home</h1>");

    const etag = first.headers["etag"];
    expect(typeof etag).toBe("string");

    // Second request echoing that ETag: a bodiless 304, still hardened, still logged.
    const second = await makeRequest(server.port, {
      method: "GET",
      path: "/",
      headers: { "if-none-match": etag as string },
    });

    expect(second.status).toBe(304);
    expect(second.body).toBe("");
    // Security headers still apply to a 304.
    expect(second.headers["x-content-type-options"]).toBe("nosniff");
    // The access log records the 304 like any other status.
    expect(entries.map((entry) => entry.status)).toEqual([200, 304]);
  });

  it("sends a full body when the conditional GET's ETag does not match", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<h1>Home</h1>",
      }),
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequest(server.port, {
      method: "GET",
      path: "/",
      headers: { "if-none-match": '"stale"' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toBe("<h1>Home</h1>");
  });

  it("does not tag a non-HTML response, so a conditional GET gets the full body", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: '{"ok":true}',
      }),
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequest(server.port, { method: "GET", path: "/api" });

    expect(response.status).toBe(200);
    expect(response.headers["etag"]).toBeUndefined();
  });

  it("does not tag when ETag is disabled", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<h1>Home</h1>",
      }),
    };

    server = await serve(app, { port: 0, etag: false });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["etag"]).toBeUndefined();
  });

  it("emits weak validators when configured", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<h1>Home</h1>",
      }),
    };

    server = await serve(app, { port: 0, etag: { weak: true } });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["etag"]).toMatch(/^W\//);
  });

  it("accepts tuned socket limits and serves normally", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "tuned" }),
    };

    server = await serve(app, {
      port: 0,
      requestTimeoutMs: 5_000,
      headersTimeoutMs: 2_000,
      keepAliveTimeoutMs: 1_000,
      maxHeaderBytes: 8 * 1024,
      drainTimeoutMs: 2_000,
    });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.body).toBe("tuned");
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

describe("withTimeout", () => {
  it("resolves with the work's value when it settles before the deadline", async () => {
    expect(await withTimeout(Promise.resolve(7), 1000)).toBe(7);
  });

  it("rejects with a coded timeout when the work overruns the deadline", async () => {
    await expect(withTimeout(new Promise<number>(() => {}), 5)).rejects.toMatchObject({
      code: "RUNTIME_HANDLER_TIMEOUT",
    });
  });

  it("propagates the work's own rejection", async () => {
    const failure = new Error("handler blew up");

    await expect(withTimeout(Promise.reject(failure), 1000)).rejects.toBe(failure);
  });
});

describe("healthResponse", () => {
  it("answers GET and HEAD liveness with 200 ok", async () => {
    expect(await healthResponse("GET", "/health", {})).toMatchObject({ status: 200, body: "ok" });
    expect(await healthResponse("HEAD", "/health", {})).toMatchObject({ status: 200, body: "ok" });
  });

  it("answers readiness 200 by default and 503 when the probe is false", async () => {
    expect(await healthResponse("GET", "/readyz", {})).toMatchObject({
      status: 200,
      body: "ready",
    });

    const notReady = await healthResponse("GET", "/readyz", { isReady: async () => false });
    expect(notReady).toMatchObject({ status: 503, body: "not ready" });
  });

  it("honors custom liveness and readiness paths", async () => {
    const options = { livePath: "/_live", readyPath: "/_ready" };

    expect(await healthResponse("GET", "/_live", options)).toMatchObject({ status: 200 });
    expect(await healthResponse("GET", "/_ready", options)).toMatchObject({ status: 200 });
    // The defaults are no longer matched once overridden.
    expect(await healthResponse("GET", "/health", options)).toBeUndefined();
  });

  it("falls through (undefined) for non-GET/HEAD methods and unknown paths", async () => {
    expect(await healthResponse("POST", "/health", {})).toBeUndefined();
    expect(await healthResponse("GET", "/posts", {})).toBeUndefined();
  });
});

describe("withSecurityHeaders", () => {
  const response = { status: 200, headers: { "content-type": "text/html" }, body: "x" };

  it("returns the response unchanged when defaults are disabled", () => {
    expect(withSecurityHeaders(response, false)).toBe(response);
  });

  it("merges defaults under the response so the response's own headers win", () => {
    const merged = withSecurityHeaders(response, {
      "X-Frame-Options": "DENY",
      "content-type": "ignored",
    });

    expect(merged.headers).toEqual({ "X-Frame-Options": "DENY", "content-type": "text/html" });
  });
});

describe("securityDefaults", () => {
  it("returns false untouched when headers are disabled wholesale", () => {
    expect(securityDefaults(false, { csp: { policy: "x", mode: "enforce" } })).toBe(false);
  });

  it("layers nothing onto the base when neither knob is set", () => {
    const base = { "X-Frame-Options": "DENY" };

    const result = securityDefaults(base, {});

    expect(result).toEqual({ "X-Frame-Options": "DENY" });
    // A fresh object, not the same reference — folding must not mutate the base.
    expect(result).not.toBe(base);
  });

  it("adds an enforcing CSP under the enforce header", () => {
    expect(
      securityDefaults({}, { csp: { policy: "default-src 'self'", mode: "enforce" } }),
    ).toEqual({ "Content-Security-Policy": "default-src 'self'" });
  });

  it("adds a report-only CSP under the report-only header", () => {
    expect(
      securityDefaults({}, { csp: { policy: "default-src 'self'", mode: "report-only" } }),
    ).toEqual({ "Content-Security-Policy-Report-Only": "default-src 'self'" });
  });

  it("adds COEP only when explicitly enabled, never when false", () => {
    expect(securityDefaults({}, { crossOriginEmbedderPolicy: true })).toEqual({
      "Cross-Origin-Embedder-Policy": "require-corp",
    });

    expect(securityDefaults({}, { crossOriginEmbedderPolicy: false })).toEqual({});
  });
});

/** A 200 HTML response carrying the given body — the shape withEtag tags. */
function htmlResponse(body: string): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
  };
}

describe("withEtag", () => {
  it("passes the response through untouched when ETag is disabled", () => {
    const response = htmlResponse("<h1>x</h1>");

    const result = withEtag(response, false);

    expect(result.response).toBe(response);
    expect(result.etag).toBeUndefined();
  });

  it("attaches a strong ETag to a 200 HTML response", () => {
    const result = withEtag(htmlResponse("<h1>Home</h1>"), {});

    expect(result.etag).toBe(etagFor("<h1>Home</h1>"));
    expect(result.response.headers["ETag"]).toBe(result.etag);
  });

  it("attaches a weak ETag when configured", () => {
    const result = withEtag(htmlResponse("<h1>Home</h1>"), { weak: true });

    expect(result.etag).toBe(etagFor("<h1>Home</h1>", { weak: true }));
  });

  it("never overwrites an ETag the app already set, in any header casing", () => {
    const response = {
      status: 200,
      headers: { "content-type": "text/html", etag: '"app-owned"' },
      body: "<h1>x</h1>",
    };

    const result = withEtag(response, {});

    expect(result.etag).toBeUndefined();
    expect(result.response).toBe(response);
  });

  it("does not tag a non-200 response", () => {
    const redirect = { status: 302, headers: { "content-type": "text/html" }, body: "" };

    expect(withEtag(redirect, {}).etag).toBeUndefined();
  });

  it("does not tag a non-HTML response", () => {
    const json = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: "{}",
    };

    expect(withEtag(json, {}).etag).toBeUndefined();
  });

  it("does not tag a 200 with no content-type at all", () => {
    const bare = { status: 200, headers: {}, body: "x" };

    expect(withEtag(bare, {}).etag).toBeUndefined();
  });

  it("skips a streamed HTML body — a stream cannot be hashed without draining it", () => {
    // A 200 with an HTML content-type that would normally be tagged; but its body
    // is a stream, so hashing it would consume the body we still owe the client.
    const streamed = {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));

          controller.close();
        },
      }),
    };

    const result = withEtag(streamed, {});

    expect(result.etag).toBeUndefined();
    // Passed through untouched — no ETag header was added.
    expect(result.response).toBe(streamed);
  });

  it("tags a fully-buffered byte body — bytes are hashable just like a string", () => {
    // Streaming SSR aside, an HTML response may arrive as bytes; those are
    // buffered, so they hash to a stable ETag exactly as a string would.
    const bytes = new Uint8Array(Buffer.from("<h1>Home</h1>", "utf8"));

    const response = {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: bytes,
    };

    const result = withEtag(response, {});

    expect(result.etag).toBe(etagFor(bytes));
    expect(result.response.headers["ETag"]).toBe(result.etag);
  });
});

describe("ifNoneMatch", () => {
  it("returns undefined when the header is absent", () => {
    expect(ifNoneMatch({})).toBeUndefined();
  });

  it("passes a single string value through", () => {
    expect(ifNoneMatch({ "if-none-match": '"abc"' })).toBe('"abc"');
  });

  it("joins a repeated header into the comma-separated form", () => {
    expect(ifNoneMatch({ "if-none-match": ['"a"', '"b"'] })).toBe('"a", "b"');
  });
});

describe("applyServerLimits", () => {
  it("writes the three socket timeouts onto the server", () => {
    const target: ServerLimits = { requestTimeout: 0, headersTimeout: 0, keepAliveTimeout: 0 };

    applyServerLimits(target, {
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 15_000,
      keepAliveTimeoutMs: 5_000,
    });

    expect(target).toEqual({
      requestTimeout: 30_000,
      headersTimeout: 15_000,
      keepAliveTimeout: 5_000,
    });
  });
});

/** A fake server + timer seam that lets a test fire close/grace by hand. */
function drainHarness() {
  const calls = { idle: 0, all: 0, cleared: [] as unknown[] };

  let closeCb: (() => void) | undefined;
  let graceCb: (() => void) | undefined;

  const node: ClosableServer = {
    close: (cb) => {
      closeCb = cb;
    },
    closeIdleConnections: () => {
      calls.idle += 1;
    },
    closeAllConnections: () => {
      calls.all += 1;
    },
  };

  const timers: DrainTimers = {
    set: (cb) => {
      graceCb = cb;
      return "handle";
    },
    clear: (handle) => calls.cleared.push(handle),
  };

  return {
    calls,
    node,
    timers,
    fireClose: () => closeCb?.(),
    fireGrace: () => graceCb?.(),
  };
}

describe("drainServer", () => {
  it("resolves when in-flight requests finish before the grace window, clearing the timer once", async () => {
    const h = drainHarness();

    const drained = drainServer(h.node, 100, h.timers);

    expect(h.calls.idle).toBe(1); // idle keep-alives freed immediately

    h.fireClose();
    h.fireClose(); // idempotent: a second settle is a no-op

    await drained;

    expect(h.calls.all).toBe(0); // grace never expired, so no force-close
    expect(h.calls.cleared).toEqual(["handle"]); // exactly one clear
  });

  it("forces remaining sockets closed when the grace window expires", async () => {
    const h = drainHarness();

    const drained = drainServer(h.node, 100, h.timers);

    h.fireGrace(); // grace expired -> force the stragglers
    expect(h.calls.all).toBe(1);

    h.fireClose(); // close completes after the force
    await drained;

    expect(h.calls.cleared).toEqual(["handle"]);
  });
});

/** A fake response capturing its `close` listener, with a settable `writableFinished`. */
function fakeAbortableRes(writableFinished: boolean): {
  res: AbortableResponse;
  fireClose: () => void;
} {
  let closeListener: (() => void) | undefined;

  const res: AbortableResponse = {
    on: (_event, listener) => {
      closeListener = listener;
      return res;
    },
    writableFinished,
  };

  return { res, fireClose: () => closeListener?.() };
}

describe("requestAbortSignal", () => {
  it("aborts with RUNTIME_CLIENT_DISCONNECTED when the client closed before finishing", () => {
    const { res, fireClose } = fakeAbortableRes(false);

    const signal = requestAbortSignal(res);

    // Quiet inert until the socket actually closes.
    expect(signal.aborted).toBe(false);

    fireClose();

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(RuntimeError);
    expect((signal.reason as RuntimeError).code).toBe("RUNTIME_CLIENT_DISCONNECTED");
  });

  it("does not abort on a clean completion (the response already finished)", () => {
    const { res, fireClose } = fakeAbortableRes(true);

    const signal = requestAbortSignal(res);

    // `close` fires on every response end; a finished write is not a disconnect.
    fireClose();

    expect(signal.aborted).toBe(false);
  });
});
