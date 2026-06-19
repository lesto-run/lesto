import { request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { serve } from "../src/index";
import {
  adoptRequestId,
  applyConnectionLimit,
  applyServerLimits,
  closeWithDrain,
  concurrencyLimiter,
  compressResponse,
  drainServer,
  establishContext,
  healthResponse,
  ifNoneMatch,
  installProcessSafetyNet,
  probeReady,
  readBody,
  requestAbortSignal,
  requestCancellation,
  requestLineOf,
  respondWithError,
  securityDefaults,
  withEtag,
  withRequestId,
  withSecurityHeaders,
  withTimeout,
} from "../src/server";
import { etagFor } from "../src/index";
import { RuntimeError } from "../src/errors";
import { gunzipSync } from "node:zlib";

import type { AnyLestoResponse } from "@lesto/web";

import type {
  AbortableResponse,
  BodyStream,
  ClosableServer,
  DrainTimers,
  ServerLimits,
} from "../src/server";

import type { AccessEntry, Server } from "../src/index";
import type { App } from "@lesto/kernel";
import { currentContext } from "@lesto/web";
import type { LestoResponse } from "@lesto/web";
import { parseTraceparent } from "@lesto/observability";

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

/** Like {@link makeRequest}, but returns the RAW response bytes (for a compressed body). */
function makeRequestRaw(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string> },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: { ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => chunks.push(chunk));

        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );

    req.on("error", reject);

    req.end();
  });
}

describe("serve", () => {
  it("answers a real GET request through the socket, echoing path and query", async () => {
    // A stub App typed as the real interface — enough to exercise the full
    // socket -> toLestoRequest -> handle -> applyResponse path live.
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

  it("holds a JSON body to the tighter maxJsonBodyBytes, but a non-JSON body to maxBodyBytes", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "ok" }),
    };

    // JSON capped at 10 bytes; the general body cap stays the default 1 MiB.
    server = await serve(app, { port: 0, maxJsonBodyBytes: 10 });

    // A 19-byte application/json body exceeds the JSON cap → 413.
    const json = await makeRequest(server.port, {
      method: "POST",
      path: "/api",
      contentType: "application/json",
      body: '{"x":"0123456789"}',
    });
    expect(json.status).toBe(413);

    // The same-size body under a non-JSON type rides the general cap → served.
    const text = await makeRequest(server.port, {
      method: "POST",
      path: "/api",
      contentType: "text/plain",
      body: "0123456789012345678",
    });
    expect(text.status).toBe(200);
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

  it("sheds a 503 when requests in flight exceed maxInFlightRequests, then recovers", async () => {
    // Definite assignment: the Promise executors below run synchronously.
    let releaseHeld!: () => void;
    let markStarted!: () => void;

    const released = new Promise<void>((resolve) => {
      releaseHeld = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const app: App = {
      migrationsApplied: [],
      handle: async (_method, path) => {
        if (path === "/hold") {
          markStarted(); // signal that the only slot is now occupied
          await released; // block until the test frees it
        }

        return { status: 200, headers: {}, body: "ok" };
      },
    };

    server = await serve(app, { port: 0, maxInFlightRequests: 1 });

    const held = makeRequest(server.port, { method: "GET", path: "/hold" });
    await started;

    // The one slot is taken, so a concurrent request is shed without running.
    const shed = await makeRequest(server.port, { method: "GET", path: "/" });
    expect(shed.status).toBe(503);
    expect(shed.body).toBe("Service Unavailable");

    releaseHeld();
    expect((await held).status).toBe(200);

    // The slot was freed in `finally`, so the node serves again.
    const recovered = await makeRequest(server.port, { method: "GET", path: "/" });
    expect(recovered.status).toBe(200);
  });

  it("aborts the wedged handler's context signal after answering 503", async () => {
    // The handler reads its own abort signal; on timeout the runtime must fire it,
    // so a cooperative handler stops rather than accumulating as a zombie.
    let abortReason: unknown;

    let resolveAborted: () => void;
    const aborted = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });

    const app: App = {
      migrationsApplied: [],
      handle: () =>
        new Promise(() => {
          const signal = currentContext()?.signal;

          signal?.addEventListener("abort", () => {
            abortReason = signal.reason;
            resolveAborted();
          });
        }),
    };

    server = await serve(app, { port: 0, handlerTimeoutMs: 20 });

    const slow = await makeRequest(server.port, { method: "GET", path: "/slow" });

    expect(slow.status).toBe(503);

    // The wedged handler's signal fired with the timeout reason — proof the
    // runtime cancelled it rather than merely freeing the socket.
    await aborted;

    expect(abortReason).toBeInstanceOf(RuntimeError);
    expect((abortReason as RuntimeError).code).toBe("RUNTIME_HANDLER_TIMEOUT");
  });

  it("echoes a minted X-Request-Id on every response", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "ok" }),
    };

    server = await serve(app, { port: 0, newRequestId: () => "minted-77" });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.headers["x-request-id"]).toBe("minted-77");
  });

  it("ignores a client-sent X-Request-Id when the proxy is untrusted (forgeable)", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "ok" }),
    };

    // Default trustProxy is false: an inbound id is a forgery, never adopted.
    server = await serve(app, { port: 0, newRequestId: () => "minted-88" });

    const response = await makeRequest(server.port, {
      method: "GET",
      path: "/",
      headers: { "x-request-id": "forged-id" },
    });

    expect(response.headers["x-request-id"]).toBe("minted-88");
  });

  it("adopts a well-formed inbound X-Request-Id behind the trustProxy gate", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "ok" }),
    };

    // trustProxy true: the loopback peer is trusted, so its id is the upstream's.
    server = await serve(app, { port: 0, trustProxy: true, newRequestId: () => "minted-99" });

    const response = await makeRequest(server.port, {
      method: "GET",
      path: "/",
      headers: { "x-request-id": "upstream-trace-1" },
    });

    expect(response.headers["x-request-id"]).toBe("upstream-trace-1");
  });

  it("echoes the request id even on a 500 error response", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => {
        throw new Error("boom");
      },
    };

    server = await serve(app, {
      port: 0,
      logError: () => {},
      newRequestId: () => "err-id-1",
    });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    expect(response.status).toBe(500);
    expect(response.headers["x-request-id"]).toBe("err-id-1");
  });

  it("attributes a 413 to the right method and path (request line read before the body)", async () => {
    const entries: AccessEntry[] = [];

    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "unreached" }),
    };

    server = await serve(app, {
      port: 0,
      maxBodyBytes: 8,
      logRequest: (entry) => entries.push(entry),
    });

    const response = await makeRequest(server.port, {
      method: "POST",
      path: "/upload",
      body: "this body is well over eight bytes",
      contentType: "text/plain",
    });

    expect(response.status).toBe(413);

    // The 413 is attributed to POST /upload, not the GET / default — the request
    // line was computed before readBody rejected.
    expect(entries[0]).toMatchObject({ method: "POST", path: "/upload", status: 413 });
  });

  it("defaults the access log to a structured JSON line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "ok" }),
    };

    // No logRequest injected: the default structured-JSON sink runs.
    server = await serve(app, { port: 0, newRequestId: () => "json-id-1" });

    await makeRequest(server.port, { method: "GET", path: "/x" });

    const line = JSON.parse(logSpy.mock.calls[0]?.[0] as string);

    expect(line).toMatchObject({
      level: "info",
      event: "http.access",
      method: "GET",
      path: "/x",
      status: 200,
      request_id: "json-id-1",
    });
    // A clean response carries no `truncated` field.
    expect(line.truncated).toBeUndefined();

    logSpy.mockRestore();
  });

  it("bounds the readiness probe: a wedged probe answers 503 rather than hanging", async () => {
    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "unreached" }),
    };

    server = await serve(app, {
      port: 0,
      // A probe that never settles; the bound must turn it into a prompt 503.
      health: { isReady: () => new Promise<boolean>(() => {}), readyTimeoutMs: 20 },
    });

    const response = await makeRequest(server.port, { method: "GET", path: "/readyz" });

    expect(response.status).toBe(503);
    expect(response.body).toBe("not ready");
  });

  it("reports a stream truncation in the access entry and through logError", async () => {
    const entries: AccessEntry[] = [];

    const errors: Array<{ message: string; error: unknown }> = [];

    const app: App = {
      migrationsApplied: [],
      // A stream body the transport pipes; the dispatch contract types `body` as a
      // string, but the runtime widens it for the stream arm — cast at this seam,
      // exactly where a page render hands the transport its streamed HTML.
      handle: async () =>
        ({
          status: 200,
          headers: { "content-type": "text/html" },
          // A stream that errors mid-flight: the body is truncated after the shell.
          body: new ReadableStream({
            start(controller) {
              controller.error(new Error("producer blew up"));
            },
          }),
        }) as unknown as LestoResponse,
    };

    server = await serve(app, {
      port: 0,
      logRequest: (entry) => entries.push(entry),
      logError: (message, error) => errors.push({ message, error }),
    });

    await makeRequest(server.port, { method: "GET", path: "/stream" }).catch(() => {});

    // The access entry flags the truncation, and the fault is surfaced via logError.
    expect(entries[0]?.truncated).toBe(true);
    expect(errors.some((e) => e.message === "response body truncated mid-stream")).toBe(true);
  });

  it("flags a truncation on the span attribute and the default JSON access line", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const spans: Array<{ attributes: Record<string, unknown>; status?: string }> = [];

    const tracer = {
      startSpan: () => {
        const record: (typeof spans)[number] = { attributes: {} };

        spans.push(record);

        return {
          data: { traceId: "t".repeat(32), spanId: "s".repeat(32) },
          setAttribute: (key: string, value: unknown) => (record.attributes[key] = value),
          setStatus: (status: "ok" | "error") => (record.status = status),
          end: () => {},
        };
      },
    };

    const app: App = {
      migrationsApplied: [],
      handle: async () =>
        ({
          status: 200,
          headers: { "content-type": "text/html" },
          body: new ReadableStream({
            start(controller) {
              controller.error(new Error("producer blew up"));
            },
          }),
        }) as unknown as LestoResponse,
    };

    // No logRequest injected: the default JSON sink runs, so its truncated branch
    // is exercised; the tracer is wired so the span attribute branch runs too.
    server = await serve(app, {
      port: 0,
      tracer,
      logError: () => {},
      newRequestId: () => "trunc-id",
    });

    await makeRequest(server.port, { method: "GET", path: "/stream" }).catch(() => {});

    // The span carries the truncation attribute.
    expect(spans[0]?.attributes["lesto.response.truncated"]).toBe(true);

    // The default structured line carries `truncated: true`.
    const line = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(line).toMatchObject({ event: "http.access", truncated: true, request_id: "trunc-id" });

    logSpy.mockRestore();
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
    // in for @lesto/observability's Tracer.
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
          data: { traceId: "t".repeat(32), spanId: "s".repeat(32) },
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
          "lesto.request_id": "req-9",
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
          "lesto.request_id": "req-9",
        },
        status: "error",
        ended: true,
      },
    ]);
  });

  it("joins an inbound W3C traceparent and publishes the request span on the context", async () => {
    // A recording tracer that captures the inbound trace passed to startSpan AND
    // exposes a `data` so the runtime can publish it on the context.
    const started: Array<{ name: string; inbound: unknown }> = [];

    const tracer = {
      startSpan: (name: string, inbound?: unknown) => {
        started.push({ name, inbound });

        return {
          data: { traceId: "a".repeat(32), spanId: "deadbeefdeadbeef" },
          setAttribute: () => undefined,
          setStatus: () => undefined,
          end: () => undefined,
        };
      },
    };

    // The handler reads the span the runtime published on the request context —
    // proving a seam fired during the request can parent on it.
    let seenSpanTraceId: string | undefined;

    const app: App = {
      migrationsApplied: [],
      handle: async () => {
        seenSpanTraceId = (currentContext()?.span as { data: { traceId: string } } | undefined)
          ?.data.traceId;

        return { status: 200, headers: {}, body: "ok" };
      },
    };

    server = await serve(app, { port: 0, tracer, parseTraceparent });

    const trace = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parent = "00f067aa0ba902b7";

    await makeRequest(server.port, {
      method: "GET",
      path: "/",
      headers: { traceparent: `00-${trace}-${parent}-01` },
    });

    // The inbound trace was parsed and handed to the root span. `parseTraceparent`
    // also carries `flags`; the runtime reads only trace + parent, so we match on
    // those rather than the whole record.
    expect(started[0]?.name).toBe("http.request");
    expect(started[0]?.inbound).toMatchObject({ traceId: trace, parentId: parent });

    // The span was published on the request context for child seams to read.
    expect(seenSpanTraceId).toBe("a".repeat(32));
  });

  it("roots a fresh trace when the inbound traceparent is absent or malformed", async () => {
    const started: Array<{ inbound: unknown }> = [];

    const tracer = {
      startSpan: (_name: string, inbound?: unknown) => {
        started.push({ inbound });

        return {
          data: { traceId: "t".repeat(32), spanId: "s".repeat(32) },
          setAttribute: () => undefined,
          setStatus: () => undefined,
          end: () => undefined,
        };
      },
    };

    const app: App = {
      migrationsApplied: [],
      handle: async () => ({ status: 200, headers: {}, body: "ok" }),
    };

    server = await serve(app, { port: 0, tracer, parseTraceparent });

    // A garbage header parses to undefined → a fresh root (no inbound).
    await makeRequest(server.port, {
      method: "GET",
      path: "/",
      headers: { traceparent: "not-a-valid-traceparent" },
    });

    expect(started[0]?.inbound).toBeUndefined();
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
    const calls: Array<{ status: number; headers: Record<string, string | string[]> }> = [];

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

  it("fires onTimeout once at the deadline, before rejecting", async () => {
    let fired = 0;

    await expect(
      withTimeout(new Promise<number>(() => {}), 5, () => {
        fired += 1;
      }),
    ).rejects.toMatchObject({ code: "RUNTIME_HANDLER_TIMEOUT" });

    expect(fired).toBe(1);
  });

  it("never fires onTimeout when the work settles before the deadline", async () => {
    let fired = 0;

    const value = await withTimeout(Promise.resolve(9), 1000, () => {
      fired += 1;
    });

    expect(value).toBe(9);
    expect(fired).toBe(0);
  });
});

describe("adoptRequestId", () => {
  it("adopts a well-formed inbound id from a trusted peer", () => {
    expect(adoptRequestId("abc-123_DEF.4", true)).toBe("abc-123_DEF.4");
  });

  it("rejects an inbound id when the peer is not trusted (forgeable)", () => {
    expect(adoptRequestId("abc-123", false)).toBeUndefined();
  });

  it("rejects a malformed inbound id even from a trusted peer", () => {
    // A space, a slash, a control char — all outside the conservative token shape.
    expect(adoptRequestId("has space", true)).toBeUndefined();
    expect(adoptRequestId("a/b", true)).toBeUndefined();
    expect(adoptRequestId("", true)).toBeUndefined();
  });

  it("rejects an over-long inbound id (bounded length)", () => {
    expect(adoptRequestId("x".repeat(129), true)).toBeUndefined();
    expect(adoptRequestId("x".repeat(128), true)).toBe("x".repeat(128));
  });

  it("yields undefined when no inbound id was sent, even from a trusted peer", () => {
    expect(adoptRequestId(undefined, true)).toBeUndefined();
  });
});

describe("establishContext", () => {
  it("mints the fallback id when the peer is untrusted, ignoring an inbound id", () => {
    const context = establishContext(
      { socket: { remoteAddress: "5.6.7.8" }, headers: { "x-request-id": "forged" } },
      false,
      "minted-id",
    );

    expect(context.requestId).toBe("minted-id");
    expect(context.ip).toBe("5.6.7.8");
  });

  it("adopts a trusted inbound id and resolves the forwarded client", () => {
    const context = establishContext(
      {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          "x-request-id": "upstream-9",
          "x-forwarded-for": "203.0.113.7",
          "x-forwarded-proto": "https",
        },
      },
      true,
      "minted-id",
    );

    // Trusted peer: the upstream id is adopted and the forwarded identity believed.
    expect(context.requestId).toBe("upstream-9");
    expect(context.ip).toBe("203.0.113.7");
    expect(context.protocol).toBe("https");
  });

  it("falls back to the minted id when a trusted peer sent no inbound id", () => {
    const context = establishContext(
      { socket: { remoteAddress: "10.0.0.1" }, headers: {} },
      true,
      "minted-id",
    );

    expect(context.requestId).toBe("minted-id");
  });
});

describe("probeReady", () => {
  it("resolves the probe's result when it answers before the deadline", async () => {
    expect(await probeReady(() => true, 1000)).toBe(true);
    expect(await probeReady(async () => false, 1000)).toBe(false);
  });

  it("resolves false when the probe overruns the deadline", async () => {
    // A probe that never settles: the deadline must answer "not ready", not hang.
    expect(await probeReady(() => new Promise<boolean>(() => {}), 5)).toBe(false);
  });

  it("resolves false when the probe throws", async () => {
    expect(
      await probeReady(() => {
        throw new Error("db ping failed");
      }, 1000),
    ).toBe(false);
  });
});

describe("withRequestId", () => {
  it("echoes the request id onto a response that did not set one", () => {
    const out = withRequestId(
      { status: 200, headers: { "content-type": "text/html" }, body: "" },
      "rid-1",
    );

    expect(out.headers["X-Request-Id"]).toBe("rid-1");
  });

  it("never overrides an X-Request-Id the app already set, in any casing", () => {
    const out = withRequestId(
      { status: 200, headers: { "x-request-id": "app-owned" }, body: "" },
      "rid-1",
    );

    expect(out.headers["x-request-id"]).toBe("app-owned");
    expect(out.headers["X-Request-Id"]).toBeUndefined();
  });
});

describe("requestCancellation", () => {
  it("aborts with RUNTIME_HANDLER_TIMEOUT when the deadline fires", () => {
    const { res } = fakeAbortableRes(false);

    const { signal, abortTimeout } = requestCancellation(res);

    expect(signal.aborted).toBe(false);

    abortTimeout();

    expect(signal.aborted).toBe(true);
    expect((signal.reason as RuntimeError).code).toBe("RUNTIME_HANDLER_TIMEOUT");
  });

  it("aborts with RUNTIME_CLIENT_DISCONNECTED when the client hangs up first", () => {
    const { res, fireClose } = fakeAbortableRes(false);

    const { signal } = requestCancellation(res);

    fireClose();

    expect(signal.aborted).toBe(true);
    expect((signal.reason as RuntimeError).code).toBe("RUNTIME_CLIENT_DISCONNECTED");
  });

  it("is idempotent: a timeout after a disconnect does not re-abort", () => {
    const { res, fireClose } = fakeAbortableRes(false);

    const { signal, abortTimeout } = requestCancellation(res);

    fireClose();

    const firstReason = signal.reason;

    abortTimeout();

    // The first abort wins; the second is a no-op on an already-aborted controller.
    expect(signal.reason).toBe(firstReason);
    expect((signal.reason as RuntimeError).code).toBe("RUNTIME_CLIENT_DISCONNECTED");
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

  it("recognizes HTML when the content-type is a (degenerate) list value", () => {
    // The widened header map allows a list value; the HTML check joins it first.
    const response: AnyLestoResponse = {
      status: 200,
      headers: { "content-type": ["text/html"] },
      body: "<h1>List</h1>",
    };

    expect(withEtag(response, {}).etag).toBe(etagFor("<h1>List</h1>"));
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

describe("applyConnectionLimit", () => {
  it("writes maxConnections onto the server", () => {
    const target = { maxConnections: 0 };

    applyConnectionLimit(target, 10_000);

    expect(target.maxConnections).toBe(10_000);
  });
});

describe("concurrencyLimiter", () => {
  it("admits up to max, sheds past it, and frees a slot on release", () => {
    const limiter = concurrencyLimiter(2);

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false); // at capacity

    limiter.release();

    expect(limiter.tryAcquire()).toBe(true); // the freed slot is reusable
  });

  it("release never underflows below zero", () => {
    const limiter = concurrencyLimiter(1);

    limiter.release(); // no prior acquire — the underflow guard makes this a no-op

    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
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

/** A `ClosableServer` whose `close` callback fires immediately — no real timers. */
function instantClosable(): ClosableServer {
  return {
    close: (cb) => cb(),
    closeIdleConnections: () => {},
    closeAllConnections: () => {},
  };
}

describe("closeWithDrain", () => {
  it("drains first, then runs the drain hook (the order traces depend on)", async () => {
    const order: string[] = [];

    const draining: ClosableServer = {
      close: (cb) => {
        order.push("drain");
        cb();
      },
      closeIdleConnections: () => {},
      closeAllConnections: () => {},
    };

    await closeWithDrain(
      draining,
      100,
      async () => {
        order.push("flush");
      },
      () => {},
    );

    expect(order).toEqual(["drain", "flush"]);
  });

  it("is a plain drain when no hook is given", async () => {
    let logged = false;

    await closeWithDrain(instantClosable(), 100, undefined, () => {
      logged = true;
    });

    // No hook ran, nothing was logged — a clean no-op past the drain.
    expect(logged).toBe(false);
  });

  it("contains a rejecting hook: logs it and still resolves (a failed flush never wedges shutdown)", async () => {
    const errors: Array<{ message: string; error: unknown }> = [];

    const boom = new Error("collector unreachable");

    await expect(
      closeWithDrain(
        instantClosable(),
        100,
        () => Promise.reject(boom),
        (message, error) => errors.push({ message, error }),
      ),
    ).resolves.toBeUndefined();

    expect(errors).toEqual([{ message: "drain hook failed (kept shutting down)", error: boom }]);
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

/** Read a header value (single or list) by case-insensitive name as one string. */
function headerOf(
  headers: Record<string, string | string[]>,
  name: string,
): string | string[] | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }

  return undefined;
}

/** A buffered HTML 200 — the compressible input for the compression tests. */
function htmlBody(body: string): AnyLestoResponse {
  return { status: 200, headers: { "content-type": "text/html" }, body };
}

describe("compressResponse", () => {
  const html = htmlBody;

  it("returns the response untouched when compression is disabled", () => {
    const response = html("hello");

    const result = compressResponse(response, "gzip", false);

    expect(result.response).toBe(response);
    expect(result.streamEncoding).toBeUndefined();
  });

  it("compresses a buffered HTML body and reports no stream encoding", () => {
    const text = "compress me ".repeat(50);

    const result = compressResponse(html(text), "gzip", true);

    expect(headerOf(result.response.headers, "content-encoding")).toBe("gzip");
    expect(result.streamEncoding).toBeUndefined();
    expect(gunzipSync(result.response.body as Buffer).toString("utf8")).toBe(text);
  });

  it("sets Content-Length on a non-compressible buffered body (identity)", () => {
    const response: AnyLestoResponse = {
      status: 200,
      headers: { "content-type": "image/png" },
      body: new Uint8Array([1, 2, 3, 4]),
    };

    const result = compressResponse(response, "gzip", true);

    // Not compressed (an image), but the length is now declared.
    expect(headerOf(result.response.headers, "content-encoding")).toBeUndefined();
    expect(headerOf(result.response.headers, "content-length")).toBe("4");
  });

  it("returns a stream encoding for a compressible stream the client accepts", () => {
    const response: AnyLestoResponse = {
      status: 200,
      headers: { "content-type": "text/html" },
      body: new ReadableStream(),
    };

    const result = compressResponse(response, "br, gzip", true);

    // The header framing is stamped and the chosen coding is handed back for
    // applyResponse to insert the transform.
    expect(result.streamEncoding).toBe("br");
    expect(headerOf(result.response.headers, "content-encoding")).toBe("br");
  });

  it("leaves a stream untouched when its type is not compressible", () => {
    const response: AnyLestoResponse = {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: new ReadableStream(),
    };

    const result = compressResponse(response, "gzip", true);

    expect(result.response).toBe(response);
    expect(result.streamEncoding).toBeUndefined();
  });

  it("leaves a compressible stream untouched when the client accepts no coding", () => {
    const response: AnyLestoResponse = {
      status: 200,
      headers: { "content-type": "text/html" },
      body: new ReadableStream(),
    };

    const result = compressResponse(response, "identity", true);

    expect(result.response).toBe(response);
    expect(result.streamEncoding).toBeUndefined();
  });
});

describe("serve — Set-Cookie multimap + compression (live socket)", () => {
  it("delivers two Set-Cookie lines for a session + CSRF cookie", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async () => ({
        status: 200,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "set-cookie": ["session=s; HttpOnly", "csrf=c; Secure"],
        },
        body: "ok",
      }),
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequest(server.port, { method: "GET", path: "/" });

    // node's http client surfaces repeated Set-Cookie lines as a string array —
    // BOTH cookies arrived, never one comma-joined line.
    expect(response.headers["set-cookie"]).toEqual(["session=s; HttpOnly", "csrf=c; Secure"]);
  });

  it("gzip-compresses a text body end-to-end when the client accepts it", async () => {
    const text = "the quick brown fox ".repeat(80);

    const app: App = {
      migrationsApplied: [],

      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: text,
      }),
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequestRaw(server.port, {
      method: "GET",
      path: "/",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["vary"]).toContain("Accept-Encoding");
    // The wire bytes are gzip; decompressing yields the source HTML.
    expect(gunzipSync(response.body).toString("utf8")).toBe(text);
  });

  it("sets Content-Length and no encoding when the client accepts none", async () => {
    const app: App = {
      migrationsApplied: [],

      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "plain body",
      }),
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequestRaw(server.port, {
      method: "GET",
      path: "/",
      headers: { "accept-encoding": "identity" },
    });

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-length"]).toBe("10");
    expect(response.body.toString("utf8")).toBe("plain body");
  });

  it("sends the body uncompressed when compression is disabled", async () => {
    const text = "uncompressed ".repeat(40);

    const app: App = {
      migrationsApplied: [],

      handle: async () => ({
        status: 200,
        headers: { "content-type": "text/html" },
        body: text,
      }),
    };

    server = await serve(app, { port: 0, compress: false });

    const response = await makeRequestRaw(server.port, {
      method: "GET",
      path: "/",
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.body.toString("utf8")).toBe(text);
  });

  it("compresses a STREAMED HTML body on the fly through the zlib transform", async () => {
    const text = "streamed compress ".repeat(60);

    const app: App = {
      migrationsApplied: [],

      handle: async () =>
        ({
          status: 200,
          headers: { "content-type": "text/html" },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(text));
              controller.close();
            },
          }),
        }) as unknown as LestoResponse,
    };

    server = await serve(app, { port: 0 });

    const response = await makeRequestRaw(server.port, {
      method: "GET",
      path: "/",
      headers: { "accept-encoding": "gzip" },
    });

    // A stream is compressed through the transform — chunked, no Content-Length —
    // and decompresses back to the source HTML.
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["content-length"]).toBeUndefined();
    expect(gunzipSync(response.body).toString("utf8")).toBe(text);
  });
});
