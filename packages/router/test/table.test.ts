import { describe, expect, expectTypeOf, it } from "vitest";

import { type Match, type ParamKeys, type PathParams, RouteTable, RouterError } from "../src/index";

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
});
