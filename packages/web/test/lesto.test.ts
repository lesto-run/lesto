import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { defineDataSource } from "@lesto/ui";
import type { BrowserSpan } from "@lesto/observability";

import { BROWSER_SPANS_ROUTE } from "../src/browser-spans";
import { CLIENT_ERRORS_ROUTE } from "../src/client-errors";
import type { ClientErrorEvent } from "../src/client-errors";
import { runWithContext } from "../src/context";
import { WebError } from "../src/errors";
import { fromRequestMiddleware, lesto } from "../src/lesto";
import type { Handler } from "../src/lesto";
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

// Module-scope page guards for the `.page()` guard suite — each captures nothing.
const redirectGuard: Handler = (c) => c.redirect("/login");
const augmentUser: Handler = (c) => {
  c.set("user", "ada");
};
const blockGuard: Handler = (c) => c.text("blocked", 403);
const homePage = { component: () => createElement("main", null, "home") };

// An auth-shaped guard: fall through when the session cookie is present, else redirect
// — the exact shape a page's `middleware.ts` is, shared by the page GET and its bound
// data route so the data-route bypass test gates both with the SAME chain.
const cookieGuard: Handler = (c) =>
  c.header("cookie") === "sid=jade" ? undefined : c.redirect("/login");

describe("lesto verbs + dispatch", () => {
  it("dispatches each verb to its handler", async () => {
    const app = lesto()
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
    const app = lesto().get("/listings/:id", (c) => c.json({ id: c.param("id") }));

    expect(JSON.parse((await app.handle("GET", "/listings/42")).body)).toEqual({ id: "42" });
  });

  it("threads query, headers, and body from the handle options", async () => {
    const app = lesto().post("/echo", (c) =>
      c.json({ q: c.query("a"), h: c.header("x-test"), body: c.req.body }),
    );

    const response = await app.handle("POST", "/echo", {
      query: { a: "1" },
      headers: { "x-test": "yes" },
      body: { n: 2 },
    });

    expect(JSON.parse(response.body)).toEqual({ q: "1", h: "yes", body: { n: 2 } });
  });

  it("threads rawBody from the handle options onto c.req.rawBody", async () => {
    const app = lesto().post("/echo", (c) => c.json({ rawBody: c.req.rawBody }));

    const response = await app.handle("POST", "/echo", {
      body: { n: 2 },
      rawBody: '{"n":2}',
    });

    expect(JSON.parse(response.body)).toEqual({ rawBody: '{"n":2}' });
  });

  it("leaves c.req.rawBody undefined when the handle options omit it", async () => {
    const app = lesto().post("/echo", (c) => c.json({ hasRawBody: "rawBody" in c.req }));

    const response = await app.handle("POST", "/echo", { body: { n: 2 } });

    expect(JSON.parse(response.body)).toEqual({ hasRawBody: false });
  });

  it("threads byte-exact rawBytes from the handle options onto c.req.rawBytes", async () => {
    // Bytes that would be corrupted by a UTF-8 round-trip — the byte-exact
    // channel a binary webhook's HMAC must hash.
    const raw = Uint8Array.from([0xff, 0xfe, 0x00, 0x80]);
    const app = lesto().post("/echo", (c) =>
      c.json({ bytes: c.req.rawBytes === undefined ? "MISSING" : Array.from(c.req.rawBytes) }),
    );

    const response = await app.handle("POST", "/echo", { rawBytes: raw });

    expect(JSON.parse(response.body)).toEqual({ bytes: [0xff, 0xfe, 0x00, 0x80] });
  });

  it("leaves c.req.rawBytes undefined when the handle options omit it", async () => {
    const app = lesto().post("/echo", (c) => c.json({ hasRawBytes: "rawBytes" in c.req }));

    const response = await app.handle("POST", "/echo", { body: { n: 2 } });

    expect(JSON.parse(response.body)).toEqual({ hasRawBytes: false });
  });

  it("returns 404 when no route matches", async () => {
    const app = lesto().get("/a", (c) => c.text("a"));

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

    const app = lesto()
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
    const app = lesto().get("/img", (c) => c.bytes(bytes, "image/png"));

    expect((await app.handle("GET", "/img")).body).toBe(bytes);
  });
});

describe("lesto HEAD + 405 (RFC 9110 §9.1 / §15.5.6)", () => {
  it("answers HEAD with the GET handler's headers + status but no body", async () => {
    let ran = 0;

    const app = lesto().get("/thing", (c) => {
      ran += 1;

      return c.text("the body", 200);
    });

    const response = await app.handle("HEAD", "/thing");

    // The GET handler ran (so a HEAD sees the same headers/status a GET would)…
    expect(ran).toBe(1);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/plain");
    // …but the body is dropped — a HEAD carries none (§9.3.2).
    expect(response.body).toBe("");
  });

  it("answers HEAD on a dynamic route (the F9 regression: was a 404)", async () => {
    const app = lesto().get("/listings/:id", (c) => c.json({ id: c.param("id") }));

    const response = await app.handle("HEAD", "/listings/42");

    expect(response.status).toBe(200);
    expect(response.body).toBe("");
  });

  it("runs the GET route's app middleware for a HEAD fallback", async () => {
    const order: string[] = [];

    const app = lesto()
      .use(async (_c, next) => {
        order.push("mw");

        return next();
      })
      .get("/thing", (c) => c.text("ok"));

    await app.handle("HEAD", "/thing");

    // The middleware baked into the GET chain runs exactly once for the HEAD, too.
    expect(order).toEqual(["mw"]);
  });

  it("a HEAD on a genuinely unknown path is still a 404", async () => {
    const app = lesto().get("/known", (c) => c.text("ok"));

    expect((await app.handle("HEAD", "/missing")).status).toBe(404);
  });

  it("a HEAD fallback on a malformed-param path re-raises the coded refusal (a 400)", async () => {
    // The GET route matches `/q/%zz`, but decoding `%zz` throws — the HEAD fallback
    // defers to the same coded refusal a GET would, so it surfaces a 400, not a 404.
    const app = lesto().get("/q/:term", (c) => c.text("ok"));

    await expect(app.handle("HEAD", "/q/%zz")).rejects.toMatchObject({
      code: "ROUTER_MALFORMED_PARAM",
    });
  });

  it("returns 405 + Allow for a known path hit with an unsupported verb", async () => {
    const app = lesto()
      .get("/things/:id", (c) => c.text("show"))
      .put("/things/:id", (c) => c.text("update"));

    const response = await app.handle("DELETE", "/things/7");

    expect(response.status).toBe(405);
    expect(response.body).toBe("Method Not Allowed");

    // Allow lists the registered verbs, and HEAD because GET is present.
    const allow = (response.headers["allow"] as string).split(", ");
    expect(allow).toContain("GET");
    expect(allow).toContain("PUT");
    expect(allow).toContain("HEAD");
    expect(allow).not.toContain("DELETE");
  });

  it("omits HEAD from Allow when the path has no GET route", async () => {
    const app = lesto().post("/submit", (c) => c.text("ok"));

    const response = await app.handle("GET", "/submit");

    expect(response.status).toBe(405);
    expect(response.headers["allow"]).toBe("POST");
  });

  it("still runs global middleware before the 405 terminal (so CORS can short-circuit)", async () => {
    const app = lesto()
      .use(fromRequestMiddleware(corsLike))
      .get("/r", (c) => c.text("ok"));

    // An OPTIONS on a known path would 405, but the CORS preflight answers first.
    expect((await app.handle("OPTIONS", "/r")).status).toBe(204);
  });
});

describe("lesto middleware (.use) + per-route chain", () => {
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

    const app = lesto()
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

    const app = lesto()
      .get("/early", (c) => c.text("early"))
      .use(mark);

    await app.handle("GET", "/early");

    expect(wrapped).toBe(false);
  });

  it("runs inline route middleware in order before the handler", async () => {
    const app = lesto().get("/g", guard, (c) => c.text("passed"));

    expect((await app.handle("GET", "/g", { query: { ok: "1" } })).body).toBe("passed");
    expect((await app.handle("GET", "/g")).status).toBe(403);
  });

  it("lets a middleware short-circuit without calling next", async () => {
    let reached = false;

    const app = lesto().get("/b", block, (c) => {
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

    const app = lesto().get("/o", observe, (c) => c.text("after"));

    expect((await app.handle("GET", "/o")).body).toBe("after");
    expect(seen).toEqual(["observed"]);
  });

  it("runs the inner chain once even if a middleware both awaits next and falls through", async () => {
    let inner = 0;

    const app = lesto().get("/s", sloppy, (c) => {
      inner += 1;
      return c.text("inner");
    });

    await app.handle("GET", "/s");

    expect(inner).toBe(1);
  });

  it("yields 404 when a matched route's chain answers nothing", async () => {
    const app = lesto().get("/quiet", (_c) => {
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
    const app = lesto()
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
    const app = lesto()
      .use(fromRequestMiddleware(corsLike))
      .get("/r", (c) => c.text("ok"));

    expect((await app.handle("OPTIONS", "/r")).status).toBe(204);

    const response = await app.handle("GET", "/r");
    expect(response.body).toBe("ok");
    expect(response.headers["x-cors"]).toBe("1");
  });
});

describe("lesto.route composition", () => {
  it("mounts a sub-router under a prefix", async () => {
    const admin = lesto().get("/users", (c) => c.text("users"));
    const app = lesto().route("/admin", admin);

    expect((await app.handle("GET", "/admin/users")).body).toBe("users");
  });

  it("mounts a sub-router with no prefix", async () => {
    const slice = lesto().get("/health", (c) => c.text("ok"));
    const app = lesto().route(slice);

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

    const sub = lesto()
      .use(childMw)
      .get("/x", (c) => c.text("x"));
    const app = lesto().use(parentMw).route("/api", sub);

    await app.handle("GET", "/api/x");

    expect(order).toEqual(["parent", "child"]);
  });
});

describe("lesto().page() — file-route guards (per-route middleware)", () => {
  it("runs a guard BEFORE the page loader and falls through to render when it returns nothing", async () => {
    const order: string[] = [];
    const pass: Handler = () => {
      order.push("guard");
    };
    const app = lesto().page(
      "/",
      { load: () => (order.push("load"), {}), component: homePage.component },
      [pass],
    );

    const html = await drainBody((await app.handle("GET", "/")).body);

    // The guard ran, then the loader, then the page rendered — guard precedes load.
    expect(order).toEqual(["guard", "load"]);
    expect(html).toContain("home");
  });

  it("short-circuits the load when a guard answers (redirect before load)", async () => {
    let loaded = false;
    const app = lesto().page(
      "/admin",
      { load: () => ((loaded = true), {}), component: homePage.component },
      [redirectGuard],
    );

    const response = await app.handle("GET", "/admin");

    expect(response.status).toBe(302);
    expect(response.headers.Location).toBe("/login");
    // The loader never ran — the guard short-circuited before render.
    expect(loaded).toBe(false);
  });

  it("passes a value a guard set on the context through to the loader (context augmentation)", async () => {
    const app = lesto().page(
      "/me",
      {
        load: (c) => ({ user: c.get<string>("user") ?? "nobody" }),
        component: ({ user }: { user: string }) => createElement("main", null, `hi ${user}`),
      },
      [augmentUser],
    );

    const html = await drainBody((await app.handle("GET", "/me")).body);

    expect(html).toContain("hi ada");
  });

  it("runs multiple guards in order, the outermost first", async () => {
    const order: string[] = [];
    const outer: Handler = () => {
      order.push("outer");
    };
    const inner: Handler = () => {
      order.push("inner");
    };
    const app = lesto().page("/", homePage, [outer, inner]);

    await app.handle("GET", "/");

    expect(order).toEqual(["outer", "inner"]);
  });

  it("runs app-level .use() middleware BEFORE the page's own guards", async () => {
    const order: string[] = [];
    const appMw: Handler = (_c, next) => {
      order.push("app");
      return next();
    };
    const pageGuard: Handler = () => {
      order.push("guard");
    };
    const app = lesto().use(appMw).page("/", homePage, [pageGuard]);

    await app.handle("GET", "/");

    expect(order).toEqual(["app", "guard"]);
  });

  it("renders a guard-free page exactly as before (empty guards default)", async () => {
    const app = lesto().page("/", homePage);

    const html = await drainBody((await app.handle("GET", "/")).body);

    expect(html).toContain("home");
  });

  it("preserves a page's guards when its sub-app is mounted with .route()", async () => {
    let loaded = false;
    const sub = lesto().page(
      "/secret",
      { load: () => ((loaded = true), {}), component: homePage.component },
      [blockGuard],
    );
    const app = lesto().route("/app", sub);

    const response = await app.handle("GET", "/app/secret");

    expect(response.status).toBe(403);
    expect(response.body).toBe("blocked");
    // The mounted guard still short-circuited the load.
    expect(loaded).toBe(false);
  });
});

describe("lesto.routes inspection", () => {
  it("lists every registered route's verb + pattern in order", () => {
    const sub = lesto().get("/c", (c) => c.text("c"));
    const app = lesto()
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

describe("lesto().data() — island data sources (ADR 0010)", () => {
  // request-scoped: a "who am I" session resolves from the caller's own cookie, so
  // its auto-route is safe unguarded — the secure-by-default opt-out that lets these
  // suites register it without a guard chain (the throw is exercised separately below).
  const sessionSource = defineDataSource<{ id: string; name: string } | null>("session", {
    access: "request-scoped",
  });

  it("auto-exposes a source at GET /__lesto/data/<name>, running the loader with context", async () => {
    const app = lesto().data(sessionSource, (c) =>
      c.header("cookie") === "sid=jade" ? { id: "jade", name: "Jade" } : null,
    );

    // The route the parse-time primer / client fallback fetches.
    expect(app.routes()).toContainEqual({ method: "GET", pattern: "/__lesto/data/session" });

    const signedIn = await app.handle("GET", "/__lesto/data/session", {
      headers: { cookie: "sid=jade" },
    });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(signedIn.body)).toEqual({ id: "jade", name: "Jade" });

    // "Nobody is signed in" is a normal answer — 200 with null, not a 401.
    const signedOut = await app.handle("GET", "/__lesto/data/session");
    expect(JSON.parse(signedOut.body)).toBeNull();
  });

  it("marks a default (private) source no-store — per-user JSON never shared-cacheable", async () => {
    const app = lesto().data(sessionSource, () => ({ id: "ada", name: "Ada" }));

    const response = await app.handle("GET", "/__lesto/data/session");

    expect(response.headers["cache-control"]).toBe("private, no-store");
    // Body + content-type are untouched by the header rule.
    expect(response.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(response.body)).toEqual({ id: "ada", name: "Ada" });
  });

  it("marks a shared source publicly cacheable but always revalidated", async () => {
    const reactionsSource = defineDataSource<Record<string, number>>("reactions", {
      scope: "shared",
    });

    const app = lesto().data(reactionsSource, () => ({ "post-1": 3 }));

    const response = await app.handle("GET", "/__lesto/data/reactions");

    expect(response.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(JSON.parse(response.body)).toEqual({ "post-1": 3 });
  });

  it("awaits an async loader", async () => {
    const app = lesto().data(sessionSource, () => Promise.resolve({ id: "ada", name: "Ada" }));

    expect(JSON.parse((await app.handle("GET", "/__lesto/data/session")).body)).toEqual({
      id: "ada",
      name: "Ada",
    });
  });

  it("runs the .use middleware declared before it, like any route", async () => {
    // secureStack-style guard mounted first must also wrap the data route.
    const app = lesto()
      .use((c, next) => (c.header("x-allow") === "1" ? next() : c.text("denied", 403)))
      .data(sessionSource, () => ({ id: "x", name: "X" }));

    expect((await app.handle("GET", "/__lesto/data/session")).status).toBe(403);
    expect(
      (await app.handle("GET", "/__lesto/data/session", { headers: { "x-allow": "1" } })).status,
    ).toBe(200);
  });

  it("enforces the SAME file-route guard on the data route as on the guarded page GET", async () => {
    // The red-team bypass (task L-f82d573b): a page's auth `middleware.ts` covers
    // only the page document GET, but an island's `scope: "private"` source rides a
    // SEPARATE `/__lesto/data/<name>` route that never sees the file-route guard — so
    // the data most worth protecting fetches over the LEAST-protected route. The fix:
    // `.data()` accepts the SAME guard chain `.page()` does — wired by hand here, the
    // identical guard the page carries — so the data route is gated identically. (The
    // file-route applier does NOT auto-propagate a page's guards to its `.data()`
    // sources; an author passes them, as below.)
    let loaderRan = false;

    const app = lesto()
      // The page document GET carries the guard via `.page`'s guards parameter.
      .page("/secret", { component: () => createElement("h1", null, "secret") }, [cookieGuard])
      // The bound source carries the SAME guard — closing the bypass.
      .data(sessionSource, () => ((loaderRan = true), { id: "jade", name: "Jade" }), [cookieGuard]);

    // Unauthenticated: the page GET is redirected before render…
    expect((await app.handle("GET", "/secret")).status).toBe(302);

    // …and the data route is redirected by the SAME guard, BEFORE the loader runs —
    // the per-user data never leaks over the formerly-unguarded route.
    const blocked = await app.handle("GET", "/__lesto/data/session");
    expect(blocked.status).toBe(302);
    expect(blocked.headers.Location).toBe("/login");
    expect(loaderRan).toBe(false); // the guard short-circuited the loader

    // Authenticated: the guard falls through, the loader runs, the data is served.
    const allowed = await app.handle("GET", "/__lesto/data/session", {
      headers: { cookie: "sid=jade" },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.headers["cache-control"]).toBe("private, no-store"); // header rule still applies
    expect(JSON.parse(allowed.body)).toEqual({ id: "jade", name: "Jade" });
    expect(loaderRan).toBe(true);
  });

  describe("secure by default — a private source must be guarded or request-scoped", () => {
    // The default `defineDataSource(name)` is scope:"private", access:"guarded" — the
    // dangerous fail-open configuration (per-user data on the bypass route) is now
    // unrepresentable by omission. The decision is forced AT the .data() call.
    const guardedSource = defineDataSource<{ secret: string }>("billing");

    it("REFUSES a private source registered with no guards (throws at registration, before any request)", () => {
      let loaderRan = false;

      try {
        lesto().data(guardedSource, () => ((loaderRan = true), { secret: "$$$" }));
        expect.unreachable("registering an unguarded private source must throw");
      } catch (error) {
        expect(error).toBeInstanceOf(WebError);
        expect((error as WebError).code).toBe("WEB_PRIVATE_DATA_UNGUARDED");
        expect((error as WebError).details).toEqual({ source: "billing" });

        // The message must TEACH the fix, not just refuse: name the source + route,
        // and offer BOTH remedies as copy-pasteable code with this source's own name.
        const message = (error as WebError).message;
        expect(message).toContain('"billing"'); // names the offending source
        expect(message).toContain("/__lesto/data/billing"); // names the leaking route
        expect(message).toContain(".data(source, loader, [yourGuard])"); // remedy 1, pasteable
        expect(message).toContain('defineDataSource("billing", { access: "request-scoped" })'); // remedy 2, pasteable
      }

      // It fails CLOSED at registration — the loader never even gets a chance to run.
      expect(loaderRan).toBe(false);
    });

    it("ACCEPTS a private source when a guard chain is passed", () => {
      const app = lesto().data(guardedSource, () => ({ secret: "$$$" }), [cookieGuard]);

      expect(app.routes()).toContainEqual({ method: "GET", pattern: "/__lesto/data/billing" });
    });

    it("ACCEPTS a private source declared access:'request-scoped' with no guards (the opt-out)", () => {
      const ownSource = defineDataSource<{ id: string }>("whoami", { access: "request-scoped" });

      const app = lesto().data(ownSource, (c) => ({ id: c.header("cookie") ?? "anon" }));

      expect(app.routes()).toContainEqual({ method: "GET", pattern: "/__lesto/data/whoami" });
    });

    it("ACCEPTS a shared source with no guards (shared data is publicly cacheable, never guarded)", () => {
      const sharedSource = defineDataSource<number>("count", { scope: "shared" });

      const app = lesto().data(sharedSource, () => 7);

      expect(app.routes()).toContainEqual({ method: "GET", pattern: "/__lesto/data/count" });
    });

    it("does NOT let app-level .use() middleware stand in for the per-source decision", () => {
      // `.use` is global, ordering-dependent, and may not be a guard — so it cannot
      // satisfy the rule. The author must still pass guards or declare request-scoped.
      const build = () =>
        lesto()
          .use((_c, next) => next())
          .data(guardedSource, () => ({ secret: "$$$" }));

      expect(build).toThrow(WebError);
      expect(build).toThrow(/WEB_PRIVATE_DATA_UNGUARDED|no guards/);
    });
  });
});

describe("lesto() client-error beacon (built-in route)", () => {
  it("accepts a beacon at POST /__lesto/client-errors out of the box, answering 204", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // No .clientErrors() wiring: the built-in route + default sink are present.
    const app = lesto();

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
    const app = lesto().get("/a", (c) => c.text("a"));

    // openapi/mcp enumerate routes(); the internal beacon receiver must not leak.
    expect(app.routes()).toEqual([{ method: "GET", pattern: "/a" }]);
  });

  it("forwards beacons to an injected sink via .clientErrors()", async () => {
    const seen: ClientErrorEvent[] = [];

    const app = lesto().clientErrors((event) => seen.push(event));

    const response = await app.handle("POST", CLIENT_ERRORS_ROUTE, {
      body: { failed: ["Nav"], missing: ["Footer"], failedCount: 1, missingCount: 1 },
    });

    expect(response.status).toBe(204);
    expect(seen).toEqual([
      { failed: ["Nav"], missing: ["Footer"], failedCount: 1, missingCount: 1 },
    ]);
  });

  it("lets a user route at the same path override the built-in", async () => {
    const app = lesto().post(CLIENT_ERRORS_ROUTE, (c) => c.text("mine", 201));

    const response = await app.handle("POST", CLIENT_ERRORS_ROUTE, { body: {} });

    expect(response.status).toBe(201);
    expect(response.body).toBe("mine");
  });

  it("wraps the built-in route in the app's top-level middleware", async () => {
    const seen: ClientErrorEvent[] = [];

    const app = lesto()
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

describe("lesto() browser-RUM span receiver (built-in route)", () => {
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

  it("accepts a batch at POST /__lesto/browser-spans out of the box, answering 204", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    // No .browserSpans() wiring: the built-in route + default sink are present.
    const app = lesto();

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
    const app = lesto().get("/a", (c) => c.text("a"));

    expect(app.routes()).toEqual([{ method: "GET", pattern: "/a" }]);
  });

  it("forwards spans to an injected sink via .browserSpans()", async () => {
    const seen: BrowserSpan[] = [];

    const app = lesto().browserSpans((span) => seen.push(span));

    const response = await app.handle("POST", BROWSER_SPANS_ROUTE, {
      body: { spans: [SPAN] },
    });

    expect(response.status).toBe(204);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.traceId).toBe(SPAN.traceId);
  });

  it("is chainable and returns the same app", () => {
    const app = lesto();

    expect(app.browserSpans(() => {})).toBe(app);
  });

  it("wraps the built-in route in the app's top-level middleware", async () => {
    const seen: BrowserSpan[] = [];

    const app = lesto()
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

describe("lesto() — the browser→server trace join meta (ARCHITECTURE.md §7)", () => {
  it("stamps the request span's traceparent into a dynamic page's head", async () => {
    const app = lesto().page("/", { component: () => createElement("main", null, "home") });

    const span = fakeRequestSpan(
      "4bf92f3577b34da6a3ce929d0e0e4736",
      "00f067aa0ba902b7abcdef0123456789",
    );

    const response = await runWithContext({ requestId: "r", span }, () => app.handle("GET", "/"));

    const html = await drainBody(response.body);

    // The traceparent meta carries the trace id and the 16-hex-truncated span id.
    expect(html).toContain(
      '<meta name="lesto-traceparent" content="00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"/>',
    );
  });

  it("emits no traceparent meta when no request span is in flight (tracing off)", async () => {
    const app = lesto().page("/", { component: () => createElement("main", null, "home") });

    // No span on the context → no meta.
    const html = await drainBody((await app.handle("GET", "/")).body);

    expect(html).not.toContain("lesto-traceparent");
  });

  it("emits no traceparent meta on a STATIC page (no live request span to bake in)", async () => {
    const app = lesto().page("/s", {
      static: true,
      component: () => createElement("main", null, "static"),
    });

    const span = fakeRequestSpan("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7");

    const html = await drainBody(
      (await runWithContext({ requestId: "r", span }, () => app.handle("GET", "/s"))).body,
    );

    expect(html).not.toContain("lesto-traceparent");
  });
});

describe("lesto().renderDeadline()", () => {
  it("is chainable and returns the same app", () => {
    const app = lesto();

    expect(app.renderDeadline(5000)).toBe(app);
  });

  it("refuses a non-positive or non-finite deadline with a coded error", () => {
    expect(() => lesto().renderDeadline(0)).toThrowError(
      expect.objectContaining({ code: "WEB_BAD_RENDER_DEADLINE" }),
    );
    expect(() => lesto().renderDeadline(-1)).toThrowError(
      expect.objectContaining({ code: "WEB_BAD_RENDER_DEADLINE" }),
    );
    expect(() => lesto().renderDeadline(Number.POSITIVE_INFINITY)).toThrowError(
      expect.objectContaining({ code: "WEB_BAD_RENDER_DEADLINE" }),
    );
  });
});
