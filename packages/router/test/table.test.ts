import { describe, expect, expectTypeOf, it } from "vitest";

import {
  compile,
  type Match,
  type ParamKeys,
  pathFor,
  type PathParams,
  RouteTable,
  RouterError,
} from "../src/index";

const run = (): string => "ran";

describe("RouteTable.add / match", () => {
  it("matches a static path and returns its value with empty params", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/about", "about-page");

    expect(table.match("GET", "/about")).toEqual({ value: "about-page", params: {} });
  });

  it("captures a :param from the matched path", () => {
    const table = new RouteTable<number>();

    table.add("GET", "/listings/:id", 7);

    expect(table.match("GET", "/listings/42")).toEqual({ value: 7, params: { id: "42" } });
  });

  it("captures multiple params in pattern order", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/posts/:postId/comments/:id", "comment");

    expect(table.match("GET", "/posts/3/comments/9")?.params).toEqual({ postId: "3", id: "9" });
  });

  it("captures a param name that ends at a literal in the same segment", () => {
    // The runtime key is `name` (the `.json` is literal) — and ParamKeys agrees.
    const table = new RouteTable<string>();

    table.add("GET", "/files/:name.json", "file");

    expect(table.match("GET", "/files/report.json")?.params).toEqual({ name: "report" });
    expect(table.match("GET", "/files/report.csv")).toBeUndefined();
  });

  it("returns the value as the caller's type, not a stringly target", () => {
    const table = new RouteTable<() => string>();

    table.add("POST", "/run", run);

    expect(table.match("POST", "/run")?.value).toBe(run);
  });

  it("returns `this` so registration chains", () => {
    const table = new RouteTable<string>();

    expect(table.add("GET", "/a", "a")).toBe(table);
  });
});

describe("RouteTable resolution order + misses", () => {
  it("resolves the first matching route — earlier shadows later", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/items/new", "new-form");
    table.add("GET", "/items/:id", "show");

    expect(table.match("GET", "/items/new")?.value).toBe("new-form");
    expect(table.match("GET", "/items/123")?.value).toBe("show");
  });

  it("returns undefined when no pattern fits the path", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/a", "a");

    expect(table.match("GET", "/b")).toBeUndefined();
  });

  it("returns undefined when the path fits but the verb differs", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/a", "a");

    expect(table.match("POST", "/a")).toBeUndefined();
  });
});

describe("RouteTable.list", () => {
  it("lists every route's verb + pattern in registration order", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/a", "a");
    table.add("POST", "/b", "b");

    expect(table.list()).toEqual([
      { method: "GET", pattern: "/a" },
      { method: "POST", pattern: "/b" },
    ]);
  });
});

describe("RouteTable param decoding (BREAKING, Wave 5)", () => {
  it("decodes a percent-encoded value into its literal text", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/q/:term", "search");

    expect(table.match("GET", "/q/hello%20world")?.params).toEqual({ term: "hello world" });
  });

  it("matches %2F as ONE segment and decodes it without smuggling a separator", () => {
    // The capture is `[^/]+` over the WIRE form, so `%2F` is one segment; only
    // after the boundary is fixed does it decode to `/`. It must NOT split into
    // two segments, and must NOT match a two-segment pattern.
    const oneSegment = new RouteTable<string>();

    oneSegment.add("GET", "/files/:path", "file");

    expect(oneSegment.match("GET", "/files/a%2Fb")?.params).toEqual({ path: "a/b" });

    const twoSegments = new RouteTable<string>();

    twoSegments.add("GET", "/files/:dir/:name", "nested");

    // A single encoded `/` is one wire segment, so the two-segment pattern misses.
    expect(twoSegments.match("GET", "/files/a%2Fb")).toBeUndefined();
  });

  it("decodes %2e%2e to the literal '..' string, not a path operator", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/n/:slug", "node");

    // `..` arrives as a plain value the handler sees; the router does not honor it
    // as a traversal — there is nothing to traverse, it is just a captured string.
    expect(table.match("GET", "/n/%2e%2e")?.params).toEqual({ slug: ".." });
  });

  it("decodes a unicode slug correctly", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/u/:name", "user");

    expect(table.match("GET", "/u/%E2%9C%93")?.params).toEqual({ name: "✓" });
    expect(table.match("GET", "/u/caf%C3%A9")?.params).toEqual({ name: "café" });
  });

  it("refuses a stray '%' with a coded ROUTER_MALFORMED_PARAM (a 400, not a 500)", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/q/:term", "search");

    expect(() => table.match("GET", "/q/%zz")).toThrowError(
      expect.objectContaining({ code: "ROUTER_MALFORMED_PARAM" }),
    );
    expect(() => table.match("GET", "/q/100%")).toThrow(RouterError);
  });

  it("carries the offending param name and raw value in the error details", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/q/:term", "search");

    try {
      table.match("GET", "/q/%zz");
      expect.unreachable("malformed param should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).details).toEqual({ param: "term", raw: "%zz" });
    }
  });

  it("decodes every captured param, not just the first", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/a/:x/b/:y", "two");

    // The SECOND param is the malformed one — proves the loop decodes each capture.
    expect(() => table.match("GET", "/a/ok/b/%g")).toThrow(RouterError);
    expect(table.match("GET", "/a/x%20/b/y%20")?.params).toEqual({ x: "x ", y: "y " });
  });
});

describe("pathFor — reverse routing round-trips with match", () => {
  it("substitutes and encodes a param into the pattern", () => {
    expect(pathFor("/listings/:id", { id: "42" })).toBe("/listings/42");
  });

  it("encodes a value so it round-trips back through match as one segment", () => {
    const pattern = "/files/:path";
    const path = pathFor(pattern, { path: "a/b" });

    expect(path).toBe("/files/a%2Fb");

    const table = new RouteTable<string>();

    table.add("GET", pattern, "file");

    // The full round-trip: decoded value out, encoded into a path, decoded back.
    expect(table.match("GET", path)?.params).toEqual({ path: "a/b" });
  });

  it("round-trips a unicode value", () => {
    const pattern = "/u/:name";
    const path = pathFor(pattern, { name: "café" });
    const table = new RouteTable<string>();

    table.add("GET", pattern, "user");

    expect(table.match("GET", path)?.params).toEqual({ name: "café" });
  });

  it("substitutes multiple params in one pattern", () => {
    expect(pathFor("/posts/:postId/comments/:id", { postId: "3", id: "9" })).toBe(
      "/posts/3/comments/9",
    );
  });

  it("returns a static pattern unchanged with no params", () => {
    expect(pathFor("/about")).toBe("/about");
  });

  it("refuses a missing param with a coded ROUTER_MISSING_PARAM", () => {
    expect(() => pathFor("/listings/:id", {})).toThrowError(
      expect.objectContaining({ code: "ROUTER_MISSING_PARAM" }),
    );
  });

  it("refuses an empty-string param — it would build a path that can never route back", () => {
    // encodeURIComponent("") === "", so this would yield "/files/", which the
    // `[^/]+` capture never matches; refuse it loudly rather than ship a 404ing link.
    expect(() => pathFor("/files/:p", { p: "" })).toThrowError(
      expect.objectContaining({ code: "ROUTER_MISSING_PARAM" }),
    );
  });
});

describe("RouteTable declaration-time safety", () => {
  it("rejects an ambiguous two-params-in-one-segment pattern at add time", () => {
    const table = new RouteTable<string>();

    expect(() => table.add("GET", "/r/:a-:b", "x")).toThrow(RouterError);
  });
});

describe("type-level params", () => {
  it("infers a single param key from a pattern", () => {
    expectTypeOf<ParamKeys<"/listings/:id">>().toEqualTypeOf<"id">();
    expectTypeOf<PathParams<"/listings/:id">>().toEqualTypeOf<{ id: string }>();
  });

  it("infers a union of param keys for nested params", () => {
    expectTypeOf<ParamKeys<"/posts/:postId/comments/:id">>().toEqualTypeOf<"postId" | "id">();
  });

  it("stops a param name at a literal that follows it in the same segment", () => {
    // The runtime captures `name`/`slug`, matching `.json`/`-edit` literally — the
    // type must agree, or c.param(...) would be steered to a non-existent key.
    expectTypeOf<ParamKeys<"/files/:name.json">>().toEqualTypeOf<"name">();
    expectTypeOf<ParamKeys<"/posts/:slug-edit">>().toEqualTypeOf<"slug">();
  });

  it("yields never / an empty record for a static path", () => {
    expectTypeOf<ParamKeys<"/about">>().toEqualTypeOf<never>();
    expectTypeOf<PathParams<"/about">>().toEqualTypeOf<Record<never, string>>();
  });

  it("threads the value type through a Match", () => {
    expectTypeOf<Match<number>["value"]>().toEqualTypeOf<number>();
  });

  it("types a catch-all key as string[] and a mixed pattern per-name", () => {
    expectTypeOf<ParamKeys<"/docs/*slug">>().toEqualTypeOf<"slug">();
    expectTypeOf<ParamKeys<"/docs/*slug?">>().toEqualTypeOf<"slug">();
    expectTypeOf<PathParams<"/docs/*slug">>().toEqualTypeOf<{ slug: string[] }>();
    expectTypeOf<PathParams<"/u/:id/*rest">>().toEqualTypeOf<{ id: string; rest: string[] }>();
  });
});

describe("RouteTable catch-all segments", () => {
  it("compile marks the catch-all param names (and only those)", () => {
    expect([...compile("/docs/*slug").catchAllParams]).toEqual(["slug"]);
    expect([...compile("/docs/*slug?").catchAllParams]).toEqual(["slug"]);
    expect([...compile("/docs/:id").catchAllParams]).toEqual([]);
  });

  it("captures a required catch-all as a string[] of one or more segments", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/docs/*path", "docs");

    expect(table.match("GET", "/docs/intro")?.params).toEqual({ path: ["intro"] });
    expect(table.match("GET", "/docs/a/b/c")?.params).toEqual({ path: ["a", "b", "c"] });
    // A required catch-all needs at least one segment — the bare parent does not match.
    expect(table.match("GET", "/docs")).toBeUndefined();
  });

  it("captures a root catch-all but never the bare root", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/*path", "all");

    expect(table.match("GET", "/a/b")?.params).toEqual({ path: ["a", "b"] });
    expect(table.match("GET", "/")).toBeUndefined();
  });

  it("matches an optional catch-all down to its parent (zero segments → [])", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/shop/*rest?", "shop");

    expect(table.match("GET", "/shop")?.params).toEqual({ rest: [] });
    expect(table.match("GET", "/shop/a/b")?.params).toEqual({ rest: ["a", "b"] });
    // The catch-all is its own segment, so it must not glue onto the literal prefix.
    expect(table.match("GET", "/shopX")).toBeUndefined();
  });

  it("matches a root optional catch-all including the bare root", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/*rest?", "root");

    expect(table.match("GET", "/")?.params).toEqual({ rest: [] });
    expect(table.match("GET", "/a")?.params).toEqual({ rest: ["a"] });
    expect(table.match("GET", "/a/b")?.params).toEqual({ rest: ["a", "b"] });
  });

  it("decodes each catch-all segment and keeps an encoded slash within one element", () => {
    const table = new RouteTable<string>();

    table.add("GET", "/d/*p", "d");

    // Each segment decodes independently...
    expect(table.match("GET", "/d/a%20b/c")?.params).toEqual({ p: ["a b", "c"] });
    // ...and a %2F decodes to a slash WITHIN an element, never a new boundary.
    expect(table.match("GET", "/d/a%2Fb/c")?.params).toEqual({ p: ["a/b", "c"] });
    // A malformed `%` in any segment is a coded 400, not a 500.
    expect(() => table.match("GET", "/d/ok/%zz")).toThrowError(
      expect.objectContaining({ code: "ROUTER_MALFORMED_PARAM" }),
    );
  });

  it("refuses a catch-all that is not the final segment", () => {
    const table = new RouteTable<string>();

    // A literal after the catch-all (caught after the token scan).
    expect(() => table.add("GET", "/a/*x/edit", "x")).toThrowError(
      expect.objectContaining({ code: "ROUTER_CATCHALL_NOT_LAST" }),
    );
    // Another token after the catch-all (caught during the token scan).
    expect(() => table.add("GET", "/a/*x/:y", "x")).toThrowError(
      expect.objectContaining({ code: "ROUTER_CATCHALL_NOT_LAST" }),
    );
  });

  it("refuses a catch-all glued to a literal instead of its own segment", () => {
    const table = new RouteTable<string>();

    expect(() => table.add("GET", "/shop*rest", "x")).toThrowError(
      expect.objectContaining({ code: "ROUTER_CATCHALL_NOT_SEGMENT" }),
    );
  });
});

describe("pathFor — catch-all reverse routing", () => {
  it("joins a required catch-all's segments, round-tripping through match", () => {
    const pattern = "/docs/*path";
    const path = pathFor(pattern, { path: ["a", "b"] });

    expect(path).toBe("/docs/a/b");

    const table = new RouteTable<string>();

    table.add("GET", pattern, "docs");

    expect(table.match("GET", path)?.params).toEqual({ path: ["a", "b"] });
  });

  it("encodes a slash inside a catch-all segment so it round-trips as one element", () => {
    const pattern = "/d/*p";
    const path = pathFor(pattern, { p: ["a/b", "c"] });

    expect(path).toBe("/d/a%2Fb/c");

    const table = new RouteTable<string>();

    table.add("GET", pattern, "d");

    expect(table.match("GET", path)?.params).toEqual({ p: ["a/b", "c"] });
  });

  it("drops an empty optional catch-all to the parent path (and to '/' at the root)", () => {
    expect(pathFor("/shop/*rest?", { rest: [] })).toBe("/shop");
    expect(pathFor("/*rest?", { rest: [] })).toBe("/");
    expect(pathFor("/shop/*rest?", { rest: ["a"] })).toBe("/shop/a");
  });

  it("refuses a required catch-all given no segments", () => {
    expect(() => pathFor("/docs/*path", { path: [] })).toThrowError(
      expect.objectContaining({ code: "ROUTER_MISSING_PARAM" }),
    );
  });

  it("refuses an empty element inside a catch-all — it would not round-trip", () => {
    // `["a", "", "b"]` would emit `/docs/a//b`, which `match` rejects; refuse it here
    // rather than ship an unroutable link, mirroring the empty single-param guard.
    expect(() => pathFor("/docs/*path", { path: ["a", "", "b"] })).toThrowError(
      expect.objectContaining({ code: "ROUTER_MISSING_PARAM" }),
    );
  });

  it("refuses a catch-all given the wrong shape (a missing or a string value)", () => {
    expect(() => pathFor("/docs/*path", {})).toThrowError(
      expect.objectContaining({ code: "ROUTER_MISSING_PARAM" }),
    );
    expect(() => pathFor("/docs/*path", { path: "oops" })).toThrowError(
      expect.objectContaining({ code: "ROUTER_MISSING_PARAM" }),
    );
  });
});
