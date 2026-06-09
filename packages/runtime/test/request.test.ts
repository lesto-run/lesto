import { describe, expect, it } from "vitest";

import { toKeelRequest } from "../src/index";

describe("toKeelRequest", () => {
  it("derives method, splits path from query, and parses the query string", () => {
    const request = toKeelRequest({
      method: "GET",
      url: "/posts?author=ada&tag=math",
      headers: {},
      body: "",
    });

    expect(request.method).toBe("GET");
    expect(request.path).toBe("/posts");
    expect(request.query).toEqual({ author: "ada", tag: "math" });

    // The router, not the transport, fills params during dispatch.
    expect(request.params).toEqual({});
  });

  it("parses a JSON body when the content-type is application/json", () => {
    const request = toKeelRequest({
      method: "POST",
      url: "/posts",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: '{"title":"Hello"}',
    });

    expect(request.body).toEqual({ title: "Hello" });
  });

  it("keeps a non-JSON body as the raw string", () => {
    const request = toKeelRequest({
      method: "POST",
      url: "/posts",
      headers: { "content-type": "text/plain" },
      body: "just text",
    });

    expect(request.body).toBe("just text");
  });

  it("keeps the body raw when no content-type header is present", () => {
    const request = toKeelRequest({
      method: "POST",
      url: "/posts",
      headers: {},
      body: "untyped",
    });

    expect(request.body).toBe("untyped");
  });

  it("treats an empty body as undefined regardless of content-type", () => {
    const request = toKeelRequest({
      method: "GET",
      url: "/posts",
      headers: { "content-type": "application/json" },
      body: "",
    });

    expect(request.body).toBeUndefined();
  });

  it("reads the content-type header case-insensitively and from a list", () => {
    const request = toKeelRequest({
      method: "POST",
      url: "/posts",
      headers: { "Content-Type": ["application/json", "ignored"] },
      body: '{"ok":true}',
    });

    expect(request.body).toEqual({ ok: true });
  });

  it("ignores unrelated headers when locating the content-type", () => {
    const request = toKeelRequest({
      method: "POST",
      url: "/posts",
      headers: { accept: "application/json", "x-trace": undefined },
      body: "plain",
    });

    expect(request.body).toBe("plain");
  });

  it("yields an empty query record when the url has no query string", () => {
    const request = toKeelRequest({
      method: "GET",
      url: "/posts",
      headers: {},
      body: "",
    });

    expect(request.query).toEqual({});
  });
});
