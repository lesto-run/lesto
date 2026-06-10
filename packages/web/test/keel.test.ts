import { describe, expect, it } from "vitest";

import { keel } from "../src/keel";
import type { Handler } from "../src/keel";

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
