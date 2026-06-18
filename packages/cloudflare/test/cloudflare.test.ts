import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { VoloError } from "@volo/errors";
import { currentContext, currentRequestSpan } from "@volo/web";

import type { DeployPlan } from "@volo/deploy";

import {
  CloudflareError,
  serializeWranglerConfig,
  toFetchHandler,
  withAssets,
  wranglerConfig,
  type AssetAppHandler,
  type AssetFetcher,
  type EdgeAccessEntry,
  type EdgeDispatch,
  type EdgeExecutionContext,
  type EdgeInboundTrace,
  type EdgeRequestOptions,
  type EdgeRequestTracer,
  type EdgeTraceparentParser,
} from "../src/index";

// A dispatcher that records what it was called with and echoes a fixed response.
function recordingDispatch(response: {
  status: number;
  body: string;
  headers?: Record<string, string>;
}): {
  dispatch: EdgeDispatch;
  calls: Array<{ method: string; path: string; options: EdgeRequestOptions }>;
} {
  const calls: Array<{ method: string; path: string; options: EdgeRequestOptions }> = [];

  const dispatch: EdgeDispatch = (method, path, options) => {
    calls.push({ method, path, options });

    return Promise.resolve({
      status: response.status,
      headers: response.headers ?? {},
      body: response.body,
    });
  };

  return { dispatch, calls };
}

/** A dispatcher that always throws `error` — drives the edge error boundary. */
const throwingDispatch =
  (error: unknown): EdgeDispatch =>
  () => {
    throw error;
  };

/** A dispatcher returning a buffered HTML 200 — the edge ETag/304 path's input. */
const htmlDispatch =
  (body: string, headers: Record<string, string> = {}): EdgeDispatch =>
  () =>
    Promise.resolve({ status: 200, headers: { "content-type": "text/html", ...headers }, body });

/** A dispatcher that never settles — only a timeout (or disconnect) ends it. */
const stalledDispatch: EdgeDispatch = () => new Promise(() => undefined);

/**
 * A dispatcher returning a REJECTED promise — an async rejection, not a sync
 * throw, so it flows through `raceTimeout` rather than being caught before it.
 */
function rejectingDispatch(error: unknown): EdgeDispatch {
  async function dispatch(): Promise<never> {
    throw error;
  }

  return dispatch;
}

/** One recorded edge span — what it was minted with and how it was finished. */
interface RecordedSpan {
  name: string;
  inbound: EdgeInboundTrace | undefined;
  attributes: Record<string, unknown>;
  status?: string;
  ended: boolean;
  data: { traceId: string; spanId: string };
}

/**
 * A recording tracer satisfying the structural `EdgeRequestTracer` seam, standing
 * in for `@volo/observability`'s request tracer. Each minted span carries `data`
 * ids (so it is assignable to the request context's span slice) and records the
 * inbound trace it was joined to, so a test can assert the traceparent join.
 */
function recordingTracer(): { tracer: EdgeRequestTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];

  const tracer: EdgeRequestTracer = {
    startSpan: (name, inbound) => {
      const index = spans.length;

      const record: RecordedSpan = {
        name,
        inbound,
        attributes: {},
        ended: false,
        data: {
          traceId: inbound?.traceId ?? `trace-${index}`,
          spanId: `span-${index}`,
        },
      };

      spans.push(record);

      return {
        data: record.data,
        setAttribute: (key, value) => (record.attributes[key] = value),
        setStatus: (status) => (record.status = status),
        end: () => (record.ended = true),
      };
    },
  };

  return { tracer, spans };
}

/** The W3C spec's example `traceparent` header — one trace across a hop. */
const EXAMPLE_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

/** The inbound join {@link EXAMPLE_TRACEPARENT} parses to. */
const EXAMPLE_INBOUND: EdgeInboundTrace = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  parentId: "00f067aa0ba902b7",
};

/**
 * A parser standing in for `@volo/observability`'s `parseTraceparent`: it returns
 * the join for the spec's example header, and `undefined` for anything else.
 */
const exampleTraceparentParser: EdgeTraceparentParser = (header) =>
  header === EXAMPLE_TRACEPARENT ? EXAMPLE_INBOUND : undefined;

/** A parser that rejects everything — the malformed/absent-header path. */
const rejectingParser: EdgeTraceparentParser = () => undefined;

describe("toFetchHandler", () => {
  it("adapts method, path, query, and headers into the dispatcher", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });
    const handler = toFetchHandler(dispatch);

    const response = await handler(
      new Request("https://example.com/mls/listings?sort=price&beds=4", {
        headers: { "x-test": "1" },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.path).toBe("/mls/listings");
    expect(calls[0]?.options.query).toEqual({ sort: "price", beds: "4" });
    expect(calls[0]?.options.headers["x-test"]).toBe("1");
    expect(calls[0]?.options.body).toBeUndefined();
  });

  it("passes response headers through — a Set-Cookie survives to the browser", async () => {
    const { dispatch } = recordingDispatch({
      status: 302,
      body: "",
      headers: { "set-cookie": "__Host-volo_session=abc; Secure", location: "/mls" },
    });

    const response = await toFetchHandler(dispatch)(
      new Request("https://example.com/mls/api/sign-in", { method: "POST" }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBe("__Host-volo_session=abc; Secure");
    expect(response.headers.get("location")).toBe("/mls");
  });

  it("parses a JSON body when the content-type says so", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch)(
      new Request("https://example.com/mls/api/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ listing: "bel-air-glen" }),
      }),
    );

    expect(calls[0]?.options.body).toEqual({ listing: "bel-air-glen" });
  });

  it("answers a malformed JSON body with 400, before dispatch", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });

    const response = await toFetchHandler(dispatch)(
      new Request("https://example.com/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(calls).toEqual([]); // never reached the app
  });

  it("keeps a non-JSON body as raw text", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch)(
      new Request("https://example.com/x", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hello",
      }),
    );

    expect(calls[0]?.options.body).toBe("hello");
  });

  it("refuses a body over the cap with 413, before dispatch", async () => {
    const { dispatch, calls } = recordingDispatch({ status: 200, body: "ok" });

    const response = await toFetchHandler(dispatch, { maxBodyBytes: 8 })(
      new Request("https://example.com/x", { method: "POST", body: "x".repeat(20) }),
    );

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload Too Large");
    expect(calls).toEqual([]); // never reached the app
  });

  it("stops reading an over-cap body mid-stream — later chunks are never pulled", async () => {
    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    // A pull-based stream: each chunk is only produced when the reader asks for
    // it, so the pull count proves how far the bounded read actually consumed.
    let pulls = 0;

    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;

        // 6 bytes per chunk against an 8-byte cap: the second chunk crosses it.
        controller.enqueue(new TextEncoder().encode("chunk!"));
      },
    });

    const response = await toFetchHandler(dispatch, { maxBodyBytes: 8 })(
      new Request("https://example.com/x", { method: "POST", body, duplex: "half" } as RequestInit),
    );

    expect(response.status).toBe(413);
    // The read cancelled at the chunk that crossed the cap instead of draining
    // the (infinite) stream — the whole point of the bounded read.
    expect(pulls).toBeLessThanOrEqual(3);
  });

  it("mints one span per request when a tracer is wired, error-flagged on a 500", async () => {
    const { tracer, spans } = recordingTracer();

    const handler = toFetchHandler(throwingDispatch(new Error("boom")), {
      tracer,
      logError: () => undefined,
      logRequest: () => undefined,
      newRequestId: () => "edge-1",
    });

    await handler(new Request("https://example.com/mls/saved"));

    expect(spans).toEqual([
      {
        name: "http.request",
        inbound: undefined,
        attributes: {
          "http.method": "GET",
          "http.path": "/mls/saved",
          "http.status_code": 500,
          "volo.request_id": "edge-1",
        },
        status: "error",
        ended: true,
        data: { traceId: "trace-0", spanId: "span-0" },
      },
    ]);

    // The happy path flags ok.
    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch, { tracer, logRequest: () => undefined })(
      new Request("https://example.com/"),
    );

    expect(spans[1]?.status).toBe("ok");
    expect(spans[1]?.ended).toBe(true);
  });

  it("joins an inbound W3C traceparent so the request span continues the caller's trace", async () => {
    const { tracer, spans } = recordingTracer();

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch, {
      tracer,
      parseTraceparent: exampleTraceparentParser,
      logRequest: () => undefined,
    })(new Request("https://example.com/mls", { headers: { traceparent: EXAMPLE_TRACEPARENT } }));

    // The request span was minted with the parsed inbound trace — the cross-process
    // join the node tier makes, now on the edge.
    expect(spans[0]?.inbound).toEqual(EXAMPLE_INBOUND);
  });

  it("roots a fresh trace when the inbound header is absent or malformed", async () => {
    const { tracer, spans } = recordingTracer();

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch, {
      tracer,
      parseTraceparent: rejectingParser,
      logRequest: () => undefined,
    })(new Request("https://example.com/mls", { headers: { traceparent: "garbage" } }));

    // No inbound join — the span roots its own trace.
    expect(spans[0]?.inbound).toBeUndefined();
  });

  it("does not parse a traceparent when no tracer is wired (zero overhead)", async () => {
    let parserCalled = false;

    const parseTraceparent: EdgeTraceparentParser = () => {
      parserCalled = true;

      return undefined;
    };

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    // No tracer → the inbound header is never even parsed.
    await toFetchHandler(dispatch, { parseTraceparent, logRequest: () => undefined })(
      new Request("https://example.com/mls", {
        headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      }),
    );

    expect(parserCalled).toBe(false);
  });

  it("passes undefined to the parser when the request carries no traceparent header", async () => {
    const { tracer } = recordingTracer();

    // The parser records exactly what it was handed: an absent header is the
    // Web Headers `.get()` null, normalized to `undefined` before the parser.
    let received: string | undefined | "unset" = "unset";
    const parseTraceparent: EdgeTraceparentParser = (header) => {
      received = header;

      return undefined;
    };

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch, { tracer, parseTraceparent, logRequest: () => undefined })(
      new Request("https://example.com/mls"),
    );

    expect(received).toBeUndefined();
  });

  it("mints a span without an inbound when a tracer is wired but no parser is passed", async () => {
    const { tracer, spans } = recordingTracer();

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    // Tracer but no parseTraceparent: the request still gets a span, just no join.
    await toFetchHandler(dispatch, { tracer, logRequest: () => undefined })(
      new Request("https://example.com/mls", {
        headers: { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" },
      }),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.inbound).toBeUndefined();
  });

  it("publishes the request span on the context, so a seam parents on it", async () => {
    const { tracer, spans } = recordingTracer();

    // The dispatcher reads the span the runtime published on the context — exactly
    // how a @volo/db onQuery seam would find the request span to parent its child.
    let seenSpanData: { traceId: string; spanId: string } | undefined;

    const dispatch: EdgeDispatch = () => {
      seenSpanData = currentRequestSpan()?.data;

      return Promise.resolve({ status: 200, headers: {}, body: "ok" });
    };

    await toFetchHandler(dispatch, { tracer, logRequest: () => undefined })(
      new Request("https://example.com/mls"),
    );

    // The span the handler minted is the one the in-request seam would read.
    expect(seenSpanData).toEqual(spans[0]?.data);
  });

  it("does not publish a span on the context when no tracer is wired", async () => {
    let seen: unknown = "unset";

    const dispatch: EdgeDispatch = () => {
      seen = currentRequestSpan();

      return Promise.resolve({ status: 200, headers: {}, body: "ok" });
    };

    await toFetchHandler(dispatch, { logRequest: () => undefined })(
      new Request("https://example.com/mls"),
    );

    expect(seen).toBeUndefined();
  });

  it("flushes telemetry via ctx.waitUntil AFTER the response, on the happy path", async () => {
    const { tracer } = recordingTracer();

    let flushed = false;
    const flush = (): Promise<void> => {
      flushed = true;

      return Promise.resolve();
    };

    const scheduled: Array<Promise<unknown>> = [];
    const ctx: EdgeExecutionContext = { waitUntil: (promise) => scheduled.push(promise) };

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    const response = await toFetchHandler(dispatch, { tracer, flush, logRequest: () => undefined })(
      new Request("https://example.com/mls"),
      ctx,
    );

    expect(response.status).toBe(200);

    // The flush was handed to waitUntil — scheduled, not awaited on the response's
    // critical path — and it ran, so the request's spans are not lost after return.
    expect(scheduled).toHaveLength(1);

    await Promise.all(scheduled);

    expect(flushed).toBe(true);
  });

  it("flushes via ctx.waitUntil even when the dispatch throws (the error path drains too)", async () => {
    const flushes: number[] = [];
    const flush = (): Promise<void> => {
      flushes.push(1);

      return Promise.resolve();
    };

    const scheduled: Array<Promise<unknown>> = [];
    const ctx: EdgeExecutionContext = { waitUntil: (promise) => scheduled.push(promise) };

    const response = await toFetchHandler(throwingDispatch(new Error("boom")), {
      flush,
      logError: () => undefined,
      logRequest: () => undefined,
    })(new Request("https://example.com/mls"), ctx);

    // The handler still answered (a safe 500), and the flush was still scheduled.
    expect(response.status).toBe(500);
    expect(scheduled).toHaveLength(1);

    await Promise.all(scheduled);

    expect(flushes).toEqual([1]);
  });

  it("never calls flush when no ctx is passed — a node-shaped caller stays one-arg", async () => {
    let flushed = false;
    const flush = (): Promise<void> => {
      flushed = true;

      return Promise.resolve();
    };

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    // Driven with one argument (no ExecutionContext): the waitUntil flush is skipped.
    await toFetchHandler(dispatch, { flush, logRequest: () => undefined })(
      new Request("https://example.com/mls"),
    );

    expect(flushed).toBe(false);
  });

  it("never calls waitUntil when a ctx is passed but no flush is configured", async () => {
    let waitUntilCalled = false;
    const ctx: EdgeExecutionContext = {
      waitUntil: () => {
        waitUntilCalled = true;
      },
    };

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    // A ctx but no flush option: nothing to drain, so waitUntil is never touched.
    await toFetchHandler(dispatch, { logRequest: () => undefined })(
      new Request("https://example.com/mls"),
      ctx,
    );

    expect(waitUntilCalled).toBe(false);
  });

  it("logs one access line per request — method, path, status, latency, id", async () => {
    const { dispatch } = recordingDispatch({ status: 201, body: "ok" });

    const entries: EdgeAccessEntry[] = [];
    let tick = 1000;

    await toFetchHandler(dispatch, {
      logRequest: (entry) => entries.push(entry),
      // Two ticks: start at 1015, end at 1030 → a measured 15ms.
      now: () => (tick += 15),
      newRequestId: () => "fixed-id",
    })(new Request("https://example.com/mls/saved"));

    expect(entries).toEqual([
      { method: "GET", path: "/mls/saved", status: 201, ms: 15, requestId: "fixed-id" },
    ]);
  });

  it("passes a Uint8Array body through to the edge Response, byte-for-byte", async () => {
    // Bytes a UTF-8 round trip would corrupt; a `Response` accepts them natively,
    // so the adapter must not stringify them on the way out.
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);

    const dispatch: EdgeDispatch = () =>
      Promise.resolve({ status: 200, headers: { "content-type": "image/png" }, body: bytes });

    const response = await toFetchHandler(dispatch)(new Request("https://example.com/logo.png"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");

    const received = new Uint8Array(await response.arrayBuffer());

    expect(Array.from(received)).toEqual(Array.from(bytes));
  });

  it("passes a ReadableStream body through to the edge Response", async () => {
    // A streamed body must reach the edge as a stream, not be buffered or
    // stringified — the foundation streaming SSR builds on later.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from("chunk-")));
        controller.enqueue(new Uint8Array(Buffer.from("stream")));

        controller.close();
      },
    });

    const dispatch: EdgeDispatch = () =>
      Promise.resolve({ status: 200, headers: { "content-type": "text/html" }, body });

    const response = await toFetchHandler(dispatch)(new Request("https://example.com/stream"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("chunk-stream");
  });
});

describe("toFetchHandler — hardening (edge parity)", () => {
  it("merges the default security headers under every response", async () => {
    const { dispatch } = recordingDispatch({
      status: 200,
      body: "ok",
      headers: { "content-type": "text/html" },
    });

    const response = await toFetchHandler(dispatch)(new Request("https://example.com/"));

    // The same defaults the node server applies are now on the edge response...
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    // ...without clobbering the app's own headers.
    expect(response.headers.get("content-type")).toBe("text/html");
  });

  it("establishes a per-request context the dispatcher can read", async () => {
    let seen: { requestId: string; ip?: string; protocol?: string } | undefined;

    const dispatch: EdgeDispatch = (_method, _path, _options) => {
      const context = currentContext();
      seen = {
        requestId: context?.requestId ?? "none",
        ...(context?.ip !== undefined ? { ip: context.ip } : {}),
        ...(context?.protocol !== undefined ? { protocol: context.protocol } : {}),
      };

      return Promise.resolve({ status: 200, headers: {}, body: "ok" });
    };

    await toFetchHandler(dispatch, { newRequestId: () => "fixed-id" })(
      new Request("https://example.com/x", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
    );

    expect(seen).toEqual({ requestId: "fixed-id", ip: "203.0.113.7", protocol: "https" });
  });

  it("resolves http protocol and an absent ip when the edge headers are missing", async () => {
    let seen: { ip: string | undefined; protocol: string | undefined } | undefined;

    const dispatch: EdgeDispatch = () => {
      const context = currentContext();
      seen = { ip: context?.ip, protocol: context?.protocol };

      return Promise.resolve({ status: 200, headers: {}, body: "ok" });
    };

    await toFetchHandler(dispatch)(new Request("http://example.com/x"));

    expect(seen).toEqual({ ip: undefined, protocol: "http" });
  });

  it("exposes the request abort signal on the context", async () => {
    let signal: AbortSignal | undefined;

    const dispatch: EdgeDispatch = () => {
      signal = currentContext()?.signal;

      return Promise.resolve({ status: 200, headers: {}, body: "ok" });
    };

    await toFetchHandler(dispatch)(new Request("https://example.com/x"));

    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("catches a dispatch throw, answers a safe 500, and logs it", async () => {
    const logged: unknown[] = [];

    const response = await toFetchHandler(throwingDispatch(new Error("boom: secret=hunter2")), {
      logError: (_message, error) => logged.push(error),
    })(new Request("https://example.com/x"));

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    // The thrown secret never reaches the wire; the error went to the log instead.
    expect(logged).toHaveLength(1);
    // The 500 is hardened like any other response.
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("logs an uncaught dispatch failure through the default sink", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await toFetchHandler(throwingDispatch(new Error("boom")))(
      new Request("https://example.com/x"),
    );

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith("unhandled error serving request", expect.any(Error));

    errorSpy.mockRestore();
  });

  it("maps a coded transport error to its status, without logging a client error", async () => {
    const logged: unknown[] = [];

    const response = await toFetchHandler(
      throwingDispatch(new VoloError("RUNTIME_BODY_TOO_LARGE", "too big")),
      { logError: (_message, error) => logged.push(error) },
    )(new Request("https://example.com/x", { method: "POST" }));

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload Too Large");
    // A 4xx is the client's to own — not logged as a server error.
    expect(logged).toEqual([]);
  });

  it("sends no security headers when they are disabled", async () => {
    const { dispatch } = recordingDispatch({
      status: 200,
      body: "ok",
      headers: { "content-type": "text/plain" },
    });

    const response = await toFetchHandler(dispatch, { securityHeaders: false })(
      new Request("https://example.com/"),
    );

    expect(response.headers.get("x-content-type-options")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/plain");
  });

  it("adds a configured Content-Security-Policy", async () => {
    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    const response = await toFetchHandler(dispatch, {
      csp: { policy: "default-src 'self'", mode: "enforce" },
    })(new Request("https://example.com/"));

    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});

describe("toFetchHandler — Set-Cookie multimap", () => {
  it("emits one Set-Cookie line per value, never a comma-joined line", async () => {
    const { dispatch } = recordingDispatch({
      status: 200,
      body: "ok",
      headers: { "content-type": "text/plain" },
    });

    // A dispatcher that returns TWO cookies as a list — a session and a CSRF token.
    const twoCookies: EdgeDispatch = (method, path, options) => {
      void dispatch(method, path, options);

      return Promise.resolve({
        status: 200,
        headers: {
          "content-type": "text/plain",
          "set-cookie": ["session=s; HttpOnly", "csrf=c; Secure"],
        },
        body: "ok",
      });
    };

    const response = await toFetchHandler(twoCookies)(new Request("https://example.com/"));

    // Workers' Headers.getSetCookie() exposes each line separately — both cookies
    // reached the browser as two lines, not one mangled comma-joined line.
    expect(response.headers.getSetCookie()).toEqual(["session=s; HttpOnly", "csrf=c; Secure"]);
  });
});

describe("toFetchHandler — edge ETag / 304", () => {
  it("attaches a SHA-256 ETag to a buffered HTML 200", async () => {
    const response = await toFetchHandler(htmlDispatch("<h1>Home</h1>"), {
      logRequest: () => undefined,
    })(new Request("https://example.com/"));

    const etag = response.headers.get("etag");

    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("answers 304 when If-None-Match matches the computed ETag", async () => {
    const handler = toFetchHandler(htmlDispatch("<h1>Home</h1>"), { logRequest: () => undefined });

    // First request learns the ETag...
    const first = await handler(new Request("https://example.com/"));
    const etag = first.headers.get("etag") ?? "";

    // ...a conditional GET with that ETag gets a bodiless 304.
    const second = await handler(
      new Request("https://example.com/", { headers: { "if-none-match": etag } }),
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    // The 304 still carries the validator.
    expect(second.headers.get("etag")).toBe(etag);
  });

  it("matches a weak validator and a wildcard If-None-Match", async () => {
    const handler = toFetchHandler(htmlDispatch("<h1>Home</h1>"), { logRequest: () => undefined });

    const first = await handler(new Request("https://example.com/"));
    const etag = first.headers.get("etag") ?? "";

    // `W/"..."` compares equal to the strong tag.
    const weak = await handler(
      new Request("https://example.com/", { headers: { "if-none-match": `W/${etag}` } }),
    );
    expect(weak.status).toBe(304);

    // `*` matches any current representation.
    const star = await handler(
      new Request("https://example.com/", { headers: { "if-none-match": "*" } }),
    );
    expect(star.status).toBe(304);
  });

  it("does not 304 when If-None-Match is absent or does not match", async () => {
    const handler = toFetchHandler(htmlDispatch("<h1>Home</h1>"), { logRequest: () => undefined });

    const stale = await handler(
      new Request("https://example.com/", { headers: { "if-none-match": '"other"' } }),
    );

    expect(stale.status).toBe(200);
    expect(await stale.text()).toBe("<h1>Home</h1>");
  });

  it("does not tag a non-HTML, a non-200, an app-tagged, or a streamed response", async () => {
    const log = { logRequest: () => undefined };

    // Non-HTML.
    const json = await toFetchHandler(
      () =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      log,
    )(new Request("https://example.com/"));
    expect(json.headers.get("etag")).toBeNull();

    // Non-200.
    const created = await toFetchHandler(
      () => Promise.resolve({ status: 201, headers: { "content-type": "text/html" }, body: "x" }),
      log,
    )(new Request("https://example.com/"));
    expect(created.headers.get("etag")).toBeNull();

    // App already set its own ETag.
    const owned = await toFetchHandler(
      htmlDispatch("x", { etag: '"app"' }),
      log,
    )(new Request("https://example.com/"));
    expect(owned.headers.get("etag")).toBe('"app"');

    // Streamed body — cannot be hashed without draining it.
    const streamed = await toFetchHandler(
      () =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": "text/html" },
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("<h1>s</h1>"));
              c.close();
            },
          }),
        }),
      log,
    )(new Request("https://example.com/"));
    expect(streamed.headers.get("etag")).toBeNull();
  });

  it("recognizes HTML from a (degenerate) list-valued content-type", async () => {
    const response = await toFetchHandler(
      () =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": ["text/html"] },
          body: "<h1>List</h1>",
        }),
      { logRequest: () => undefined },
    )(new Request("https://example.com/"));

    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("tags a Uint8Array HTML body too", async () => {
    const bytes = new TextEncoder().encode("<h1>bytes</h1>");

    const response = await toFetchHandler(
      () => Promise.resolve({ status: 200, headers: { "content-type": "text/html" }, body: bytes }),
      { logRequest: () => undefined },
    )(new Request("https://example.com/"));

    expect(response.headers.get("etag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("skips ETag entirely when disabled", async () => {
    const response = await toFetchHandler(htmlDispatch("<h1>Home</h1>"), {
      etag: false,
      logRequest: () => undefined,
    })(new Request("https://example.com/"));

    expect(response.headers.get("etag")).toBeNull();
  });
});

describe("toFetchHandler — timeoutMs", () => {
  it("answers a coded 503 when the dispatch overruns the deadline", async () => {
    const response = await toFetchHandler(stalledDispatch, {
      timeoutMs: 5,
      logRequest: () => undefined,
      logError: () => undefined,
    })(new Request("https://example.com/slow"));

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Service Unavailable");
  });

  it("aborts the request signal on overrun so a cooperative handler stops", async () => {
    let signal: AbortSignal | undefined;

    const captureSignal: EdgeDispatch = () => {
      signal = currentContext()?.signal;

      return new Promise(() => undefined);
    };

    await toFetchHandler(captureSignal, {
      timeoutMs: 5,
      logRequest: () => undefined,
      logError: () => undefined,
    })(new Request("https://example.com/slow"));

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as CloudflareError | undefined)?.code).toBe(
      "CLOUDFLARE_DISPATCH_TIMEOUT",
    );
  });

  it("answers normally when the dispatch finishes within the deadline", async () => {
    const { dispatch } = recordingDispatch({ status: 200, body: "fast" });

    const response = await toFetchHandler(dispatch, {
      timeoutMs: 1000,
      logRequest: () => undefined,
    })(new Request("https://example.com/"));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fast");
  });

  it("propagates a dispatch rejection that loses the race to the error boundary", async () => {
    // The dispatch's promise REJECTS before the (generous) deadline — the race's
    // reject arm forwards it, and the error boundary maps it to a coded status
    // (here 413). An async rejection, NOT a sync throw, so it flows through the race.
    const response = await toFetchHandler(
      rejectingDispatch(new VoloError("RUNTIME_BODY_TOO_LARGE", "too big")),
      {
        timeoutMs: 1000,
        logRequest: () => undefined,
        logError: () => undefined,
      },
    )(new Request("https://example.com/", { method: "POST" }));

    expect(response.status).toBe(413);
  });
});

describe("toFetchHandler — request cancellation", () => {
  it("fires the context signal when the client disconnects", async () => {
    let signal: AbortSignal | undefined;

    const dispatch: EdgeDispatch = () => {
      signal = currentContext()?.signal;

      return Promise.resolve({ status: 200, headers: {}, body: "ok" });
    };

    // A pre-aborted request signal (the client already hung up) is adopted at once.
    const aborted = AbortSignal.abort(new Error("client gone"));

    await toFetchHandler(dispatch, { logRequest: () => undefined })(
      new Request("https://example.com/", { signal: aborted }),
    );

    expect(signal?.aborted).toBe(true);
  });

  it("forwards a client disconnect that arrives mid-request onto the context signal", async () => {
    const controller = new AbortController();

    let aborted = false;

    const dispatch: EdgeDispatch = () => {
      currentContext()?.signal?.addEventListener("abort", () => {
        aborted = true;
      });

      // Disconnect AFTER the handler started reading the signal.
      controller.abort(new Error("client left"));

      return Promise.resolve({ status: 200, headers: {}, body: "ok" });
    };

    await toFetchHandler(dispatch, { logRequest: () => undefined })(
      new Request("https://example.com/", { signal: controller.signal }),
    );

    expect(aborted).toBe(true);
  });
});

describe("toFetchHandler — default access log", () => {
  it("emits one structured JSON line mirroring the node shape", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { dispatch } = recordingDispatch({ status: 200, body: "ok" });

    await toFetchHandler(dispatch, { newRequestId: () => "edge-log-1", now: () => 0 })(
      new Request("https://example.com/mls/saved"),
    );

    expect(logSpy).toHaveBeenCalledTimes(1);

    const line = JSON.parse((logSpy.mock.calls[0]?.[0] as string) ?? "{}");

    expect(line).toEqual({
      level: "info",
      event: "http.access",
      method: "GET",
      path: "/mls/saved",
      status: 200,
      ms: 0,
      request_id: "edge-log-1",
    });

    logSpy.mockRestore();
  });
});

// An assets binding that answers a fixed status for a known path, else 404.
function assetsServing(path: string, body: string): AssetFetcher {
  return {
    fetch: (request) =>
      Promise.resolve(
        new URL(request.url).pathname === path
          ? new Response(body, { status: 200 })
          : new Response("not found", { status: 404 }),
      ),
  };
}

// An app handler that returns a fixed body — the fall-through target.
const fixedApp =
  (body: string) =>
  (_request: Request): Promise<Response> =>
    Promise.resolve(new Response(body, { status: 200 }));

describe("withAssets", () => {
  it("serves an asset hit without touching the app", async () => {
    let appCalled = false;
    const app = (_request: Request): Promise<Response> => {
      appCalled = true;

      return Promise.resolve(new Response("app", { status: 200 }));
    };

    const handler = withAssets(assetsServing("/client.js", "/* bundle */"), app);

    const response = await handler(new Request("https://example.com/client.js"));

    expect(await response.text()).toBe("/* bundle */");
    expect(appCalled).toBe(false);
  });

  it("falls through to the app on an asset 404", async () => {
    const handler = withAssets(assetsServing("/client.js", "x"), fixedApp("app"));

    const response = await handler(new Request("https://example.com/mls"));

    expect(await response.text()).toBe("app");
  });

  it("sends a POST straight to the app, never the assets binding (the sign-in bug)", async () => {
    // Static Assets only answer GET/HEAD; a form POST must reach the app, not be
    // swallowed by the assets layer's 405. The assets fetcher must NOT be called.
    let assetsCalled = false;
    const assets: AssetFetcher = {
      fetch: () => {
        assetsCalled = true;

        return Promise.resolve(new Response("", { status: 405 }));
      },
    };

    const handler = withAssets(assets, fixedApp("signed-in"));

    const response = await handler(
      new Request("https://example.com/mls/api/sign-in", { method: "POST" }),
    );

    expect(await response.text()).toBe("signed-in");
    expect(assetsCalled).toBe(false);
  });

  it("forwards the ExecutionContext to the app on a POST (so its waitUntil flush rides through)", async () => {
    let seenCtx: EdgeExecutionContext | undefined;

    const app: AssetAppHandler = (_request, ctx) => {
      seenCtx = ctx;

      return Promise.resolve(new Response("ok", { status: 200 }));
    };

    const ctx: EdgeExecutionContext = { waitUntil: () => undefined };

    // A POST never touches the assets binding; the ctx must still reach the app.
    await withAssets(assetsServing("/x", "x"), app)(
      new Request("https://example.com/mls/api/sign-in", { method: "POST" }),
      ctx,
    );

    expect(seenCtx).toBe(ctx);
  });

  it("forwards the ExecutionContext to the app on an asset 404 fall-through", async () => {
    let seenCtx: EdgeExecutionContext | undefined;

    const app: AssetAppHandler = (_request, ctx) => {
      seenCtx = ctx;

      return Promise.resolve(new Response("app", { status: 200 }));
    };

    const ctx: EdgeExecutionContext = { waitUntil: () => undefined };

    // A GET that misses the assets binding falls through to the app — with the ctx.
    await withAssets(assetsServing("/client.js", "x"), app)(
      new Request("https://example.com/mls"),
      ctx,
    );

    expect(seenCtx).toBe(ctx);
  });
});

describe("wranglerConfig", () => {
  const planWithDynamic: DeployPlan = {
    targets: [
      {
        kind: "static",
        site: "marketing",
        basePath: "/",
        routing: { basePath: "/", mode: "static" },
        files: [],
      },
      {
        kind: "node",
        site: "mls",
        basePath: "/mls",
        routing: { basePath: "/mls", mode: "dynamic" },
        run: "volo serve",
        needsDatabase: true,
      },
    ],
    routing: [
      { basePath: "/mls", mode: "dynamic" },
      { basePath: "/", mode: "static" },
    ],
  };

  it("emits a worker config with nodejs_compat and an assets binding", () => {
    const config = wranglerConfig(planWithDynamic, {
      name: "estate",
      main: "worker.ts",
      compatibilityDate: "2026-06-01",
      assetsDir: "out",
    });

    expect(config).toEqual({
      name: "estate",
      main: "worker.ts",
      compatibility_date: "2026-06-01",
      compatibility_flags: ["nodejs_compat"],
      assets: { directory: "out", binding: "ASSETS" },
    });
  });

  it("honors a custom assets binding name", () => {
    const config = wranglerConfig(planWithDynamic, {
      name: "estate",
      main: "worker.ts",
      compatibilityDate: "2026-06-01",
      assetsDir: "out",
      assetsBinding: "STATIC",
    });

    expect(config.assets.binding).toBe("STATIC");
  });

  it("omits the optional bindings when they are absent or empty", () => {
    const config = wranglerConfig(planWithDynamic, {
      name: "estate",
      main: "worker.ts",
      compatibilityDate: "2026-06-01",
      assetsDir: "out",
      // Present but empty: an empty alias/d1/vars set carries no field.
      alias: {},
      d1Databases: [],
      vars: {},
    });

    expect(config.alias).toBeUndefined();
    expect(config.d1_databases).toBeUndefined();
    expect(config.vars).toBeUndefined();
    expect(config.placement).toBeUndefined();
  });

  it("emits alias, d1_databases, vars, and placement when supplied", () => {
    const config = wranglerConfig(planWithDynamic, {
      name: "estate",
      main: "worker.ts",
      compatibilityDate: "2026-06-01",
      assetsDir: "out",
      alias: { react: "preact/compat" },
      d1Databases: [{ binding: "DB", databaseName: "estate", databaseId: "abc-123" }],
      vars: { VOLO_DEMO: "1" },
      placement: { mode: "smart" },
    });

    expect(config.alias).toEqual({ react: "preact/compat" });
    expect(config.d1_databases).toEqual([
      { binding: "DB", database_name: "estate", database_id: "abc-123" },
    ]);
    expect(config.vars).toEqual({ VOLO_DEMO: "1" });
    expect(config.placement).toEqual({ mode: "smart" });
  });

  it("refuses a plan with no dynamic zone (nothing for a Worker to run)", () => {
    const staticOnly: DeployPlan = {
      targets: [
        {
          kind: "static",
          site: "marketing",
          basePath: "/",
          routing: { basePath: "/", mode: "static" },
          files: [],
        },
      ],
      routing: [{ basePath: "/", mode: "static" }],
    };

    try {
      wranglerConfig(staticOnly, {
        name: "estate",
        main: "worker.ts",
        compatibilityDate: "2026-06-01",
        assetsDir: "out",
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CloudflareError);
      expect((error as CloudflareError).code).toBe("CLOUDFLARE_NO_DYNAMIC_ZONE");
    }
  });
});

describe("serializeWranglerConfig", () => {
  it("emits tab-indented JSONC with trailing commas and a final newline", () => {
    const text = serializeWranglerConfig({
      name: "w",
      main: "worker.ts",
      compatibility_date: "2026-06-01",
      compatibility_flags: ["nodejs_compat"],
      assets: { directory: "./out", binding: "ASSETS" },
    });

    expect(text).toBe(
      [
        "{",
        '\t"name": "w",',
        '\t"main": "worker.ts",',
        '\t"compatibility_date": "2026-06-01",',
        '\t"compatibility_flags": [',
        '\t\t"nodejs_compat",',
        "\t],",
        '\t"assets": {',
        '\t\t"directory": "./out",',
        '\t\t"binding": "ASSETS",',
        "\t},",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("weaves header and per-field comments in, and renders empty containers inline", () => {
    const text = serializeWranglerConfig(
      {
        name: "w",
        main: "worker.ts",
        compatibility_date: "2026-06-01",
        compatibility_flags: [],
        assets: { directory: "./out", binding: "ASSETS" },
        vars: {},
      },
      {
        header: ["a header line", ""],
        fields: { name: ["names the worker"] },
      },
    );

    expect(text).toBe(
      [
        "// a header line",
        "//",
        "{",
        "\t// names the worker",
        '\t"name": "w",',
        '\t"main": "worker.ts",',
        '\t"compatibility_date": "2026-06-01",',
        '\t"compatibility_flags": [],',
        '\t"assets": {',
        '\t\t"directory": "./out",',
        '\t\t"binding": "ASSETS",',
        "\t},",
        '\t"vars": {},',
        "}",
        "",
      ].join("\n"),
    );
  });

  it("serializes a config that carries every optional binding", () => {
    const text = serializeWranglerConfig({
      name: "w",
      main: "worker.ts",
      compatibility_date: "2026-06-01",
      compatibility_flags: ["nodejs_compat"],
      assets: { directory: "./out", binding: "ASSETS" },
      d1_databases: [{ binding: "DB", database_name: "estate", database_id: "id" }],
      alias: { react: "preact/compat" },
      vars: { VOLO_DEMO: "1" },
      placement: { mode: "smart" },
    });

    expect(text).toContain('\t"d1_databases": [\n\t\t{\n\t\t\t"binding": "DB",');
    expect(text).toContain('\t"alias": {\n\t\t"react": "preact/compat",\n\t},');
    expect(text).toContain('\t"vars": {\n\t\t"VOLO_DEMO": "1",\n\t},');
    expect(text).toContain('\t"placement": {\n\t\t"mode": "smart",\n\t},');
  });

  // The contract: the committed examples/estate/wrangler.jsonc is reproducible
  // byte-for-byte from `serializeWranglerConfig(wranglerConfig(...))`. Any drift
  // — a compatibility_date bump, a binding rename, a new alias — fails here, so
  // the file's "Generated by `wranglerConfig`" header stays true.
  it("regenerates the committed examples/estate/wrangler.jsonc byte-identically", () => {
    const estatePlan: DeployPlan = {
      targets: [
        {
          kind: "static",
          site: "marketing",
          basePath: "/",
          routing: { basePath: "/", mode: "static" },
          files: [],
        },
        {
          kind: "node",
          site: "mls",
          basePath: "/mls",
          routing: { basePath: "/mls", mode: "dynamic" },
          run: "volo serve",
          needsDatabase: true,
        },
      ],
      routing: [
        { basePath: "/mls", mode: "dynamic" },
        { basePath: "/", mode: "static" },
      ],
    };

    const config = wranglerConfig(estatePlan, {
      name: "volo-estate",
      main: "worker.ts",
      compatibilityDate: "2026-06-01",
      assetsDir: "./out/marketing",
      d1Databases: [
        {
          binding: "DB",
          databaseName: "estate",
          databaseId: "c02cbc83-d9f1-40bb-bd64-20f697ebb2f1",
        },
      ],
      alias: {
        react: "preact/compat",
        "react-dom/client": "preact/compat/client",
        "react-dom/server": "./preact-react-dom-server-shim.ts",
        "react-dom": "./preact-react-dom-shim.ts",
        "react/jsx-runtime": "preact/jsx-runtime",
        "react/jsx-dev-runtime": "preact/jsx-runtime",
      },
    });

    const text = serializeWranglerConfig(config, {
      fields: {
        name: [
          "Generated by `wranglerConfig` (@volo/cloudflare) from the deploy plan, then",
          'committed. See ADR 0002 and the README\'s "Deploy to Cloudflare" runbook.',
        ],
        compatibility_flags: ["node:crypto for the signed-session HMAC and password hashing."],
        assets: [
          "The prerendered static marketing site (`volo build` → out/marketing).",
          "Served first; a miss falls through to the Worker (the /mls app).",
        ],
        d1_databases: [
          "Cloudflare D1 backs the DB-driven `/lab/content/:slug` page — a Worker has no",
          "filesystem SQLite, so the content store uses D1 on the edge (Node/`bun run`",
          "use `openSqlite`). One-time setup before `wrangler deploy`:",
          "  1. wrangler d1 create estate        # creates the DB, prints its id",
          "  2. paste that id into `database_id` below",
          "The binding name MUST be `DB` — that is what `worker.ts` reads as `env.DB`.",
          "(`wrangler d1 create` interactively defaults the binding to the DB name,",
          "`estate`, which would leave `env.DB` undefined and the page on its fallback.)",
          "The `pages` table is created + seeded lazily on first request (idempotent),",
          "so no separate migration step is needed for the demo. Absent this binding,",
          'the content page renders a "configure a D1 binding" view instead of 404ing.',
        ],
        alias: [
          "Preact by default on the edge (ADR 0007/0008): the worker bundle resolves",
          "every React specifier to Preact's compat layer — the same alias set",
          "`build-client.ts --preact` applies to the client bundle, so the SSR'd markup",
          "and the shipped client speak one dialect. `worker.ts` completes the pair by",
          "rendering through `preactServerRenderer`. The shims satisfy the react-dom",
          "imports `@volo/ui`'s barrel carries but the worker never invokes.",
        ],
      },
    });

    const committed = readFileSync(
      fileURLToPath(new URL("../../../examples/estate/wrangler.jsonc", import.meta.url)),
      "utf8",
    );

    expect(text).toBe(committed);
  });
});
