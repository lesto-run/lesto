import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import { runWithContext } from "../src/context";
import { Context } from "../src/handler-context";
import { WebError } from "../src/errors";
import type { LestoRequest } from "../src/types";

const requestOf = (over: Partial<LestoRequest> = {}): LestoRequest => ({
  method: "GET",
  path: "/",
  params: {},
  query: {},
  headers: {},
  body: undefined,
  ...over,
});

describe("Context readers", () => {
  it("exposes the request, method, and path", () => {
    const request = requestOf({ method: "POST", path: "/x" });
    const c = new Context(request);

    expect(c.req).toBe(request);
    expect(c.method).toBe("POST");
    expect(c.path).toBe("/x");
  });

  it("reads a captured path param", () => {
    const c = new Context(requestOf({ params: { id: "42" } }));

    expect(c.param("id")).toBe("42");
  });

  it("returns undefined for an absent param", () => {
    const c = new Context(requestOf());

    expect(c.param("missing")).toBeUndefined();
  });

  it("reads a catch-all param as a typed string[] of segments", () => {
    // For a known pattern, `param` is typed per-name via `PathParams`: a single
    // `:id` is a `string`, the `*slug` catch-all a `string[]`.
    const c = new Context<"/docs/:id/*slug">(requestOf({ params: { id: "7", slug: ["a", "b"] } }));

    expectTypeOf(c.param("id")).toEqualTypeOf<string>();
    expectTypeOf(c.param("slug")).toEqualTypeOf<string[]>();

    expect(c.param("id")).toBe("7");
    expect(c.param("slug")).toEqual(["a", "b"]);
  });

  it("reads a query value", () => {
    const c = new Context(requestOf({ query: { sort: "price" } }));

    expect(c.query("sort")).toBe("price");
    expect(c.query("nope")).toBeUndefined();
  });

  it("reads every value of a repeated query key from queryAll", () => {
    const c = new Context(requestOf({ query: { tag: "c" }, queryAll: { tag: ["a", "b", "c"] } }));

    expect(c.queries("tag")).toEqual(["a", "b", "c"]);
  });

  it("falls back to the boxed single query value when queryAll is absent", () => {
    // A transport that never populated `queryAll` (a hand-built option, an older
    // adapter) degrades to the last-value projection boxed as a one-element array.
    const c = new Context(requestOf({ query: { sort: "price" } }));

    expect(c.req.queryAll).toBeUndefined();
    expect(c.queries("sort")).toEqual(["price"]);
  });

  it("returns [] from queries when the key is absent (either map)", () => {
    const withAll = new Context(requestOf({ query: {}, queryAll: {} }));
    const withoutAll = new Context(requestOf({ query: {} }));

    expect(withAll.queries("nope")).toEqual([]);
    expect(withoutAll.queries("nope")).toEqual([]);
  });

  it("reads a header case-insensitively", () => {
    const c = new Context(requestOf({ headers: { "content-type": "application/json" } }));

    expect(c.header("Content-Type")).toBe("application/json");
    expect(c.header("x-absent")).toBeUndefined();
  });
});

describe("Context.signal", () => {
  it("is undefined outside a transport-opened request", () => {
    const c = new Context(requestOf());

    expect(c.signal).toBeUndefined();
  });

  it("reads the abort signal from the ambient request context", () => {
    const controller = new AbortController();
    const c = new Context(requestOf());

    runWithContext({ requestId: "r1", signal: controller.signal }, () => {
      expect(c.signal).toBe(controller.signal);
    });
  });
});

describe("Context.valid", () => {
  const Schema = z.object({ title: z.string() });

  it("returns the parsed value when the body is valid", () => {
    const c = new Context(requestOf({ body: { title: "ok" } }));

    expect(c.valid(Schema)).toEqual({ title: "ok" });
  });

  it("throws a coded WebError when the body is invalid", () => {
    const c = new Context(requestOf({ body: { title: 1 } }));

    expect(() => c.valid(Schema)).toThrow(WebError);
  });
});

describe("Context.set / get", () => {
  it("stashes and reads a request-scoped value", () => {
    const c = new Context(requestOf());

    c.set("user", { id: 7 });

    expect(c.get<{ id: number }>("user")).toEqual({ id: 7 });
  });

  it("returns undefined for an unset key", () => {
    const c = new Context(requestOf());

    expect(c.get("nope")).toBeUndefined();
  });
});

describe("Context response builders", () => {
  const c = new Context(requestOf());

  it("builds a JSON response", () => {
    expect(c.json({ a: 1 })).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"a":1}',
    });
    expect(c.json({}, 201).status).toBe(201);
  });

  it("builds a text response", () => {
    expect(c.text("hi", 202)).toEqual({
      status: 202,
      headers: { "content-type": "text/plain" },
      body: "hi",
    });
  });

  it("builds an HTML response", () => {
    expect(c.html("<p>x</p>")).toEqual({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<p>x</p>",
    });
  });

  it("builds a redirect, defaulting to 302", () => {
    expect(c.redirect("/next")).toEqual({
      status: 302,
      headers: { Location: "/next" },
      body: "",
    });
    expect(c.redirect("/next", 301).status).toBe(301);
  });

  it("builds a bytes response with the caller's content type", () => {
    const data = new Uint8Array([1, 2, 3]);

    expect(c.bytes(data, "image/png")).toEqual({
      status: 200,
      headers: { "content-type": "image/png" },
      body: data,
    });
  });

  it("builds a stream response, defaulting to HTML", () => {
    const body = new ReadableStream();
    const response = c.stream(body);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/html");
    expect(response.body).toBe(body);

    expect(c.stream(body, "text/event-stream", 201).headers["content-type"]).toBe(
      "text/event-stream",
    );
  });
});
