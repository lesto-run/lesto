import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { defineDataSource } from "@keel/ui";
import type { BrowserSpan } from "@keel/observability";

import { BROWSER_SPANS_ROUTE } from "../src/browser-spans";
import { CLIENT_ERRORS_ROUTE } from "../src/client-errors";
import type { ClientErrorEvent } from "../src/client-errors";
import { runWithContext } from "../src/context";
import { fromRequestMiddleware, keel } from "../src/keel";
import type { Handler } from "../src/keel";
import type { Middleware } from "../src/middleware";

/** A live-span stub the runtime would publish on the request context. */
function fakeRequestSpan(
  traceId: string,
  spanId: string,
): {
  data: { traceId: string; spanId: string };
  setAttribute: () => unknown;
  setStatus: () => unknown;
  end: () => void;
} {
  return {
    data: { traceId, spanId },
    setAttribute: () => undefined,
    setStatus: () => undefined,
    end: () => undefined,
  };
}

/** Drain a streamed response body to a single string for assertions. */
async function drainBody(body: unknown): Promise<string> {
  const stream = body as ReadableStream<Uint8Array>;
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  let out = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    out += decoder.decode(value, { stream: true });
  }

  return out + decoder.decode();
}

// Hoisted: these capture nothing from their test, so they live at module scope.
const guard: Handler = (c, next) => (c.query("ok") === "1" ? next() : c.text("denied", 403));

const block: Handler = (c) => c.text("blocked", 401);

const sloppy: Handler = async (_c, next) => {
  // Forgets to return next()'s result — the runner must not run the inner chain twice.
  await next();
};

describe("keel verbs + dispatch", () => {
  it("dispatches each verb to its handler", async () => {
    const app = keel()
      .get("/things", (c) => c.json({ verb: "get" }))
      .post("/things", (c) => c.json({ verb: "post" }))
      .put("/things/:id", (c) => c.json({ verb: "put" }))
      .patch("/things/:id", (c) => c.json({ verb: "patch" }))
      .delete("/things/:id", (c) => c.json({ verb: "delete" }));

    expect(JSON.parse((await app.handle("GET", "/things")).body)).toEqual({ verb: "get" });
    expect(JSON.parse((await app.handle("POST", "/things")).body)).toEqual({ verb: "post" });
    expect(JSON.parse((await app.handle("PUT", "/things/1")).body)).toEqual({ verb: "put" });
    expect(JSON.parse((await app.handle("PATCH", "/things/1")).body)).toEqual({ verb: "patch" });
    expect(JSON.parse((await app.handle("DELETE", "/things/1")).body)).toEqual({ verb: "delete" });
  });

  it("captures path params into the context", async () => {
    const app = keel().get("/listings/:id", (c) => c.json({ id: c.param("id") }));

    expect(JSON.parse((await app.handle("GET", "/listings/42")).body)).toEqual({ id: "42" });
  });

  it("threads query, headers, and body from the handle options", async () => {
    const app = keel().post("/echo", (c) =>
      c.json({ q: c.query("a"), h: c.header("x-test"), body: c.req.body }),
    );

    const response = await app.handle("POST", "/echo", {
      query: { a: "1" },
      headers: { "x-test": "yes" },
      body: { n: 2 },
    });

    expect(JSON.parse(response.body)).toEqual({ q: "1", h: "yes", body: { n: 2 } });
  });

  it("returns 404 when no route matches", async () => {
    const app = keel().get("/a", (c) => c.text("a"));

    expect(await app.handle("GET", "/missing")).toEqual({
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "Not Found",
    });
  });

  it("does not leak mutated 404 headers across requests (singleton regression, blocker #2)", async () => {
    // App middleware that mutates the response object it sees ONLY on the first
    // unmatched request — exactly what a header/cookie-setting middleware does on
    // one request. Against a shared NOT_FOUND singleton that one mutation would
    // poison the object every subsequent 404 returns; with a per-request factory
    // the second request's 404 is pristine.
    let tainted = false;
    const taintOnce: Handler = async (_c, next) => {
      const response = await next();
      if (!tainted) {
        tainted = true;
        response.headers["x-tainted"] = "leaked";
      }
      return response;
    };

    const app = keel()
      .use(taintOnce)
      .get("/a", (c) => c.text("a"));

    const first = await app.handle("GET", "/missing");
    expect(first.headers["x-tainted"]).toBe("leaked");

    // The NEXT unmatched request must get a clean 404 — no leaked header.
    const second = await app.handle("GET", "/also-missing");
    expect(second.headers["x-tainted"]).toBeUndefined();
    expect(second).toEqual({
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "Not Found",
    });
  });

  it("returns the handler's wide body (bytes) through the dispatch contract", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const app = keel().get("/img", (c) => c.bytes(bytes, "image/png"));

    expect((await app.handle("GET", "/img")).body).toBe(bytes);
  });
});

describe("keel middleware (.use) + per-route chain", () => {
  it("wraps routes registered after .use, outermost first", async () => {
    const order: string[] = [];

    const tag =
      (label: string): Handler =>
      async (_c, next) => {
        order.push(`enter:${label}`);
        const response = await next();
        order.push(`exit:${label}`);
        return response;
      };

    const app = keel()
      .use(tag("a"))
      .use(tag("b"))
      .get("/x", (c) => {
        order.push("handler");
        return c.text("ok");
      });

    const response = await app.handle("GET", "/x");

    expect(response.body).toBe("ok");
    expect(order).toEqual(["enter:a", "enter:b", "handler", "exit:b", "exit:a"]);
  });

  it("does not apply .use middleware to routes registered before it", async () => {
    let wrapped = false;
    const mark: Handler = (_c, next) => {
      wrapped = true;
      return next();
    };

    const app = keel()
      .get("/early", (c) => c.text("early"))
      .use(mark);

    await app.handle("GET", "/early");

    expect(wrapped).toBe(false);
  });

  it("runs inline route middleware in order before the handler", async () => {
    const app = keel().get("/g", guard, (c) => c.text("passed"));

    expect((await app.handle("GET", "/g", { query: { ok: "1" } })).body).toBe("passed");
    expect((await app.handle("GET", "/g")).status).toBe(403);
  });

  it("lets a middleware short-circuit without calling next", async () => {
    let reached = false;

    const app = keel().get("/b", block, (c) => {
      reached = true;
      return c.text("never");
    });

    expect((await app.handle("GET", "/b")).status).toBe(401);
    expect(reached).toBe(false);
  });

  it("auto-advances when a middleware falls through without calling next", async () => {
    const seen: string[] = [];
    const observe: Handler = (_c) => {
      seen.push("observed");
      // returns void, never calls next — the runner advances for it
    };

    const app = keel().get("/o", observe, (c) => c.text("after"));

    expect((await app.handle("GET", "/o")).body).toBe("after");
    expect(seen).toEqual(["observed"]);
  });

  it("runs the inner chain once even if a middleware both awaits next and falls through", async () => {
    let inner = 0;

    const app = keel().get("/s", sloppy, (c) => {
      inner += 1;
      return c.text("inner");
    });

    await app.handle("GET", "/s");

    expect(inner).toBe(1);
  });

  it("yields 404 when a matched route's chain answers nothing", async () => {
    const app = keel().get("/quiet", (_c) => {
      // returns void, no further handler
    });

    expect((await app.handle("GET", "/quiet")).status).toBe(404);
  });

  it("runs global middleware for a malformed-param path, then re-raises the coded refusal", async () => {
    // `/q/%zz` can't route (a malformed percent-encoding), but global middleware
    // — CORS, rate-limit — must still SEE the request rather than being skipped by
    // a throw before the chain. The coded error then propagates for the transport
    // to map to a 400.
    let seen = false;
    const app = keel()
      .use((_c, next) => {
        seen = true;

        return next();
      })
      .get("/q/:term", (c) => c.text("ok"));

    await expect(app.handle("GET", "/q/%zz")).rejects.toMatchObject({
      code: "ROUTER_MALFORMED_PARAM",
    });
    expect(seen).toBe(true);
  });
});

// A CORS-style request middleware: answers a preflight, else delegates and adds a header.
const corsLike: Middleware = async (request, next) => {
  if (request.method === "OPTIONS") return { status: 204, headers: {}, body: "" };

  const response = await next();

  return { ...response, headers: { ...response.headers, "x-cors": "1" } };
};

describe("fromRequestMiddleware", () => {
  it("runs a request-shaped middleware in the handler chain", async () => {
    const app = keel()
      .use(fromRequestMiddleware(corsLike))
      .get("/r", (c) => c.text("ok"));

    expect((await app.handle("OPTIONS", "/r")).status).toBe(204);

    const response = await app.handle("GET", "/r");
    expect(response.body).toBe("ok");
    expect(response.headers["x-cors"]).toBe("1");
  });
});

describe("keel.route composition", () => {
  it("mounts a sub-router under a prefix", async () => {
    const admin = keel().get("/users", (c) => c.text("users"));
    const app = keel().route("/admin", admin);

    expect((await app.handle("GET", "/admin/users")).body).toBe("users");
  });

  it("mounts a sub-router with no prefix", async () => {
    const slice = keel().get("/health", (c) => c.text("ok"));
    const app = keel().route(slice);

    expect((await app.handle("GET", "/health")).body).toBe("ok");
  });

  it("composes the parent's middleware around the child's routes", async () => {
    const order: string[] = [];
    const parentMw: Handler = (_c, next) => {
      order.push("parent");
      return next();
    };
    const childMw: Handler = (_c, next) => {
      order.push("child");
      return next();
    };

    const sub = keel()
      .use(childMw)
      .get("/x", (c) => c.text("x"));
    const app = keel().use(parentMw).route("/api", sub);

    await app.handle("GET", "/api/x");

    expect(order).toEqual(["parent", "child"]);
  });
});

describe("keel.routes inspection", () => {
  it("lists every registered route's verb + pattern in order", () => {
    const sub = keel().get("/c", (c) => c.text("c"));
    const app = keel()
      .get("/a", (c) => c.text("a"))
      .post("/b", (c) => c.text("b"))
      .route("/nested", sub);

    expect(app.routes()).toEqual([
      { method: "GET", pattern: "/a" },
      { method: "POST", pattern: "/b" },
      { method: "GET", pattern: "/nested/c" },
    ]);
  });
});

describe("keel().data() — island data sources (ADR 0010)", () => {
  const sessionSource = defineDataSource<{ id: string; name: string } | null>("session");

  it("auto-exposes a source at GET /__keel/data/<name>, running the loader with context", async () => {
    const app = keel().data(sessionSource, (c) =>
      c.header("cookie") === "sid=jade" ? { id: "jade", name: "Jade" } : null,
    );

    // The route the parse-time primer / client fallback fetches.
    expect(app.routes()).toContainEqual({ method: "GET", pattern: "/__keel/data/session" });

    const signedIn = await app.handle("GET", "/__keel/data/session", {
      headers: { cookie: "sid=jade" },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(signedIn.body)).toEqual({ id: "jade", name: "Jade" });

    // "Nobody is signed in" is a normal answer — 200 with null, not a 401.
    const signedOut = await app.handle("GET", "/__keel/data/session");
    expect(JSON.parse(signedOut.body)).toBeNull();
  });

  it("marks a default (private) source no-store — per-user JSON never shared-cacheable", async () => {
    const app = keel().data(sessionSource, () => ({ id: "ada", name: "Ada" }));

    const response = await app.handle("GET", "/__keel/data/session");

    expect(response.headers["cache-control"]).toBe("private, no-store");
    // Body + content-type are untouched by the header rule.
    expect(response.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({ id: "ada", name: "Ada" });
  });

  it("marks a shared source publicly cacheable but always revalidated", async () => {
    const reactionsSource = defineDataSource<Record<string, number>>("reactions", {
      scope: "shared",
    });

    const app = keel().data(reactionsSource, () => ({ "post-1": 3 }));

    const response = await app.handle("GET", "/__keel/data/reactions");

    expect(response.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(JSON.parse(response.body)).toEqual({ "post-1": 3 });
  });

  it("awaits an async loader", async () => {
    const app = keel().data(sessionSource, () => Promise.resolve({ id: "ada", name: "Ada" }));

    expect(JSON.parse((await app.handle("GET", "/__keel/data/session")).body)).toEqual({
      id: "ada",
      name: "Ada",
    });
  });

  it("runs the .use middleware declared before it, like any route", async () => {
    // secureStack-style guard mounted first must also wrap the data route.
    const app = keel()
      .use((c, next) => (c.header("x-allow") === "1" ? next() : c.text("denied", 403)))
      .data(sessionSource, () => ({ id: "x", name: "X" }));

    expect((await app.handle("GET", "/__keel/data/session")).status).toBe(403);
    expect(
      (await app.handle("GET", "/__keel/data/session", { headers: { "x-allow": "1" } })).status,
    ).toBe(200);
  });
});

describe("keel() client-error beacon (built-in route)", () => {
  it("accepts a beacon at POST /__keel/client-errors out of the box, answering 204", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // No .clientErrors() wiring: the built-in route + default sink are present.
    const app = keel();

    const response = await app.handle("POST", CLIENT_ERRORS_ROUTE, {
      body: { failed: ["Cart"], missing: [] },
    });

    expect(response.status).toBe(204);

    // The default sink logged one structured line.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      event: "client.island_error",
      failed: ["Cart"],
    });

    errorSpy.mockRestore();
  });

  it("keeps the built-in route OUT of routes() — it is an internal endpoint", () => {
    const app = keel().get("/a", (c) => c.text("a"));

    // openapi/mcp enumerate routes(); the internal beacon receiver must not leak.
    expect(app.routes()).toEqual([{ method: "GET", pattern: "/a" }]);
  });

  it("forwards beacons to an injected sink via .clientErrors()", async () => {
    const seen: ClientErrorEvent[] = [];

    const app = keel().clientErrors((event) => seen.push(event));

    const response = await app.handle("POST", CLIENT_ERRORS_ROUTE, {
      body: { failed: ["Nav"], missing: ["Footer"], failedCount: 1, missingCount: 1 },
    });

    expect(response.status).toBe(204);
    expect(seen).toEqual([
      { failed: ["Nav"], missing: ["Footer"], failedCount: 1, missingCount: 1 },
    ]);
  });

  it("lets a user route at the same path override the built-in", async () => {
    const app = keel().post(CLIENT_ERRORS_ROUTE, (c) => c.text("mine", 201));

    const response = await app.handle("POST", CLIENT_ERRORS_ROUTE, { body: {} });

    expect(response.status).toBe(201);
    expect(response.body).toBe("mine");
  });

  it("wraps the built-in route in the app's top-level middleware", async () => {
    const seen: ClientErrorEvent[] = [];

    const app = keel()
      .use((c, next) => (c.header("x-allow") === "1" ? next() : c.text("denied", 403)))
      .clientErrors((event) => seen.push(event));

    // The guard mounted before any route also covers the built-in beacon route.
    const denied = await app.handle("POST", CLIENT_ERRORS_ROUTE, { body: { failed: [] } });
    expect(denied.status).toBe(403);
    expect(seen).toEqual([]);

    const allowed = await app.handle("POST", CLIENT_ERRORS_ROUTE, {
      body: { failed: [] },
      headers: { "x-allow": "1" },
    });
    expect(allowed.status).toBe(204);
    expect(seen).toHaveLength(1);
  });
});

describe("keel() browser-RUM span receiver (built-in route)", () => {
  const SPAN = {
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    spanId: "00f067aa0ba902b7",
    parentSpanId: "0102030405060708",
    name: "browser.navigation",
    startedAt: 1000,
    endedAt: 1120,
    attributes: { "browser.load_ms": 120 },
    status: 1,
  };

  it("accepts a batch at POST /__keel/browser-spans out of the box, answering 204", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // No .browserSpans() wiring: the built-in route + default sink are present.
    const app = keel();

    const response = await app.handle("POST", BROWSER_SPANS_ROUTE, {
      body: { v: 1, traceId: SPAN.traceId, spans: [SPAN] },
    });

    expect(response.status).toBe(204);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(infoSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      event: "browser.span",
      name: "browser.navigation",
      trace_id: SPAN.traceId,
    });

    infoSpy.mockRestore();
  });

  it("keeps the built-in route OUT of routes() — it is an internal endpoint", () => {
    const app = keel().get("/a", (c) => c.text("a"));

    expect(app.routes()).toEqual([{ method: "GET", pattern: "/a" }]);
  });

  it("forwards spans to an injected sink via .browserSpans()", async () => {
    const seen: BrowserSpan[] = [];

    const app = keel().browserSpans((span) => seen.push(span));

    const response = await app.handle("POST", BROWSER_SPANS_ROUTE, {
      body: { spans: [SPAN] },
    });

    expect(response.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.traceId).toBe(SPAN.traceId);
  });

  it("is chainable and returns the same app", () => {
    const app = keel();

    expect(app.browserSpans(() => {})).toBe(app);
  });

  it("wraps the built-in route in the app's top-level middleware", async () => {
    const seen: BrowserSpan[] = [];

    const app = keel()
      .use((c, next) => (c.header("x-allow") === "1" ? next() : c.text("denied", 403)))
      .browserSpans((span) => seen.push(span));

    const denied = await app.handle("POST", BROWSER_SPANS_ROUTE, { body: { spans: [SPAN] } });
    expect(denied.status).toBe(403);
    expect(seen).toEqual([]);

    const allowed = await app.handle("POST", BROWSER_SPANS_ROUTE, {
      body: { spans: [SPAN] },
      headers: { "x-allow": "1" },
    });
    expect(allowed.status).toBe(204);
    expect(seen).toHaveLength(1);
  });
});

describe("keel() — the browser→server trace join meta (ARCHITECTURE.md §7)", () => {
  it("stamps the request span's traceparent into a dynamic page's head", async () => {
    const app = keel().page("/", { component: () => createElement("main", null, "home") });

    const span = fakeRequestSpan(
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "00f067aa0ba902b7abcdef0123456789",
    );

    const response = await runWithContext({ requestId: "r", span }, () => app.handle("GET", "/"));

    const html = await drainBody(response.body);

    // The traceparent meta carries the trace id and the 16-hex-truncated span id.
    expect(html).toContain(
      '<meta name="keel-traceparent" content="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"/>',
    );
  });

  it("emits no traceparent meta when no request span is in flight (tracing off)", async () => {
    const app = keel().page("/", { component: () => createElement("main", null, "home") });

    // No span on the context → no meta.
    const html = await drainBody((await app.handle("GET", "/")).body);

    expect(html).not.toContain("keel-traceparent");
  });

  it("emits no traceparent meta on a STATIC page (no live request span to bake in)", async () => {
    const app = keel().page("/s", {
      static: true,
      component: () => createElement("main", null, "static"),
    });

    const span = fakeRequestSpan("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7");

    const html = await drainBody(
      (await runWithContext({ requestId: "r", span }, () => app.handle("GET", "/s"))).body,
    );

    expect(html).not.toContain("keel-traceparent");
  });
});

describe("keel().renderDeadline()", () => {
  it("is chainable and returns the same app", () => {
    const app = keel();

    expect(app.renderDeadline(5000)).toBe(app);
  });

  it("refuses a non-positive or non-finite deadline with a coded error", () => {
    expect(() => keel().renderDeadline(0)).toThrowError(
      expect.objectContaining({ code: "WEB_BAD_RENDER_DEADLINE" }),
    );
    expect(() => keel().renderDeadline(-1)).toThrowError(
      expect.objectContaining({ code: "WEB_BAD_RENDER_DEADLINE" }),
    );
    expect(() => keel().renderDeadline(Number.POSITIVE_INFINITY)).toThrowError(
      expect.objectContaining({ code: "WEB_BAD_RENDER_DEADLINE" }),
    );
  });
});
