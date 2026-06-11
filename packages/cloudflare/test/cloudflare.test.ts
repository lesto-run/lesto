import { describe, expect, it, vi } from "vitest";

import { KeelError } from "@keel/errors";
import { currentContext } from "@keel/web";

import type { DeployPlan } from "@keel/deploy";

import {
  CloudflareError,
  toFetchHandler,
  withAssets,
  wranglerConfig,
  type AssetFetcher,
  type EdgeAccessEntry,
  type EdgeDispatch,
  type EdgeRequestOptions,
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
      headers: { "set-cookie": "__Host-keel_session=abc; Secure", location: "/mls" },
    });

    const response = await toFetchHandler(dispatch)(
      new Request("https://example.com/mls/api/sign-in", { method: "POST" }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBe("__Host-keel_session=abc; Secure");
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
      throwingDispatch(new KeelError("RUNTIME_BODY_TOO_LARGE", "too big")),
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
        run: "keel serve",
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
