import { describe, expect, it } from "vitest";

import { toLestoRequest } from "../src/index";
import { parseRequestTarget } from "../src/request";

describe("parseRequestTarget (authority confusion — F19)", () => {
  it("accepts an origin-form path and keeps its query", () => {
    const url = parseRequestTarget("/admin?tab=users");

    expect(url.pathname).toBe("/admin");
    expect(url.search).toBe("?tab=users");
  });

  it("refuses an authority-form target that would smuggle a path past a proxy ACL", () => {
    // `//evil/admin` parses as host `evil` + path `/admin`: a proxy ACL matching the
    // raw target (not `/admin`) would forward it and the app would route `/admin`.
    expect(() => parseRequestTarget("//evil/admin")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_INVALID_REQUEST_TARGET" }),
    );
  });

  it("refuses the `/\\` backslash authority variant", () => {
    expect(() => parseRequestTarget("/\\evil/admin")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_INVALID_REQUEST_TARGET" }),
    );
  });

  it("refuses an absolute-form target (only a forward proxy receives one)", () => {
    expect(() => parseRequestTarget("http://evil/admin")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_INVALID_REQUEST_TARGET" }),
    );
  });

  it("refuses a userinfo trick whose real host is not localhost", () => {
    // `http://localhost@evil/admin` → host is `evil`, username `localhost`.
    expect(() => parseRequestTarget("http://localhost@evil/admin")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_INVALID_REQUEST_TARGET" }),
    );
  });

  it("refuses a raw target that RESOLVES to a `//`-prefixed pathname (node/edge parity)", () => {
    // `/..//evil` slips every raw-prefix check — it begins `/..`, not `//` or `/\` —
    // yet `new URL` normalizes it to host localhost + pathname `//evil`, the exact
    // `//`-prefixed path the edge twin (`fetch-handler.ts`) already rejects. Node must
    // reject it too, or a front proxy that ACL-matched the raw `/..//evil` while the
    // app routes `//evil` is a path-confusion mismatch and the tiers diverge.
    expect(() => parseRequestTarget("/..//evil")).toThrowError(
      expect.objectContaining({ code: "RUNTIME_INVALID_REQUEST_TARGET" }),
    );
  });

  it("still accepts a dot-segment path that normalizes to a single-slash pathname", () => {
    // The resolved-pathname guard rejects only a `//`-prefixed result, never every
    // target that used `..`: `/a/../b` normalizes to the ordinary `/b` and routes.
    expect(parseRequestTarget("/a/../b").pathname).toBe("/b");
  });

  it("carries the offending target in the error details", () => {
    try {
      parseRequestTarget("//evil/admin");

      expect.unreachable("an authority-form target should throw");
    } catch (error) {
      expect((error as { details?: unknown }).details).toMatchObject({ target: "//evil/admin" });
    }
  });
});

describe("toLestoRequest", () => {
  it("refuses an authority-form url before routing (F19)", () => {
    expect(() =>
      toLestoRequest({ method: "GET", url: "//evil/admin", headers: {}, body: "" }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_INVALID_REQUEST_TARGET" }));
  });

  it("derives method, splits path from query, and parses the query string", () => {
    const request = toLestoRequest({
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

  it("normalizes headers: lowercased keys, first value of a list, dropping the absent", () => {
    const request = toLestoRequest({
      method: "GET",
      url: "/",
      headers: {
        Cookie: "lesto_session=abc",
        "Set-Cookie": ["a=1", "b=2"], // a list keeps its first value
        "X-Empty": [], // an empty list flattens to ""
        "X-Absent": undefined, // an absent value is dropped entirely
      },
      body: "",
    });

    expect(request.headers["cookie"]).toBe("lesto_session=abc");
    expect(request.headers["set-cookie"]).toBe("a=1");
    expect(request.headers["x-empty"]).toBe("");
    expect("x-absent" in request.headers).toBe(false);
  });

  it("parses a JSON body when the content-type is application/json", () => {
    const request = toLestoRequest({
      method: "POST",
      url: "/posts",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: '{"title":"Hello"}',
    });

    expect(request.body).toEqual({ title: "Hello" });
  });

  it("rejects a malformed JSON body with a typed RUNTIME_INVALID_JSON error", () => {
    expect(() =>
      toLestoRequest({
        method: "POST",
        url: "/posts",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    ).toThrowError(expect.objectContaining({ code: "RUNTIME_INVALID_JSON" }));
  });

  it("keeps a non-JSON body as the raw string", () => {
    const request = toLestoRequest({
      method: "POST",
      url: "/posts",
      headers: { "content-type": "text/plain" },
      body: "just text",
    });

    expect(request.body).toBe("just text");
  });

  it("keeps the body raw when no content-type header is present", () => {
    const request = toLestoRequest({
      method: "POST",
      url: "/posts",
      headers: {},
      body: "untyped",
    });

    expect(request.body).toBe("untyped");
  });

  it("treats an empty body as undefined regardless of content-type", () => {
    const request = toLestoRequest({
      method: "GET",
      url: "/posts",
      headers: { "content-type": "application/json" },
      body: "",
    });

    expect(request.body).toBeUndefined();
  });

  it("reads the content-type header case-insensitively and from a list", () => {
    const request = toLestoRequest({
      method: "POST",
      url: "/posts",
      headers: { "Content-Type": ["application/json", "ignored"] },
      body: '{"ok":true}',
    });

    expect(request.body).toEqual({ ok: true });
  });

  it("ignores unrelated headers when locating the content-type", () => {
    const request = toLestoRequest({
      method: "POST",
      url: "/posts",
      headers: { accept: "application/json", "x-trace": undefined },
      body: "plain",
    });

    expect(request.body).toBe("plain");
  });

  it("yields an empty query record when the url has no query string", () => {
    const request = toLestoRequest({
      method: "GET",
      url: "/posts",
      headers: {},
      body: "",
    });

    expect(request.query).toEqual({});
  });

  it("carries the raw JSON string alongside the parsed body", () => {
    const raw = '{"title":"Hello"}';

    const request = toLestoRequest({
      method: "POST",
      url: "/posts",
      headers: { "content-type": "application/json" },
      body: raw,
    });

    expect(request.rawBody).toBe(raw);
    expect(request.body).toEqual({ title: "Hello" });
  });

  it("carries the raw string as rawBody for a non-JSON body", () => {
    const request = toLestoRequest({
      method: "POST",
      url: "/posts",
      headers: { "content-type": "text/plain" },
      body: "just text",
    });

    expect(request.rawBody).toBe("just text");
    expect(request.body).toBe("just text");
  });

  it("carries no rawBody when the body is empty", () => {
    const request = toLestoRequest({
      method: "GET",
      url: "/posts",
      headers: {},
      body: "",
    });

    expect(request.rawBody).toBeUndefined();
    expect("rawBody" in request).toBe(false);
  });
});

describe("toLestoRequest — multi-value query (queryAll)", () => {
  it("keeps last-wins in query AND every value, in order, in queryAll", () => {
    const request = toLestoRequest({
      method: "GET",
      url: "/posts?tag=a&tag=b&tag=c&author=ada",
      headers: {},
      body: "",
    });

    // `query` is the unchanged last-value projection…
    expect(request.query).toEqual({ tag: "c", author: "ada" });

    // …and `queryAll` carries every value a repeated key sent, in arrival order.
    expect(request.queryAll?.["tag"]).toEqual(["a", "b", "c"]);
    expect(request.queryAll?.["author"]).toEqual(["ada"]);
  });

  it("builds queryAll on a null prototype so a `?constructor=` key cannot poison it", () => {
    // On a plain `{}`, `(queryAll["constructor"] ??= [])` reads the inherited
    // `Function` (not undefined), so `??=` skips and `.push` throws — a
    // prototype-pollution DoS. `Object.create(null)` has no such inherited key.
    let request!: ReturnType<typeof toLestoRequest>;

    expect(() => {
      request = toLestoRequest({
        method: "GET",
        url: "/posts?constructor=a&constructor=b",
        headers: {},
        body: "",
      });
    }).not.toThrow();

    // The key was captured as an ordinary own data property — the array, not `Function`.
    expect(request.queryAll?.["constructor"]).toEqual(["a", "b"]);
    expect(Object.getPrototypeOf(request.queryAll)).toBeNull();
  });

  it("captures a `?__proto__=` key as own data without touching any prototype", () => {
    // On a plain `{}`, `queryAll["__proto__"]` hits the inherited accessor, so
    // `.push` would mutate `Object.prototype` itself. The null prototype makes it
    // an ordinary own key instead.
    const request = toLestoRequest({
      method: "GET",
      url: "/posts?__proto__=x&__proto__=y",
      headers: {},
      body: "",
    });

    expect(request.queryAll?.["__proto__"]).toEqual(["x", "y"]);
    expect(Object.getPrototypeOf(request.queryAll)).toBeNull();
    // Nothing leaked onto the global prototype.
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("yields an empty (null-prototype) queryAll when the url has no query string", () => {
    const request = toLestoRequest({
      method: "GET",
      url: "/posts",
      headers: {},
      body: "",
    });

    expect(request.queryAll).toEqual({});
    expect(Object.getPrototypeOf(request.queryAll)).toBeNull();
  });
});
