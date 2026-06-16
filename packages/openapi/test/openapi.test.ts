import { describe, expect, it } from "vitest";

import { type RouteEntry, toJson, toOpenApi } from "../src/index";

// A small but representative route list: the seven RESTful routes for `posts`
// (the shape `keel().routes()` yields), plus a route with two `:param` segments.
const routes: readonly RouteEntry[] = [
  { method: "GET", pattern: "/posts" },
  { method: "GET", pattern: "/posts/new" },
  { method: "POST", pattern: "/posts" },
  { method: "GET", pattern: "/posts/:id" },
  { method: "GET", pattern: "/posts/:id/edit" },
  { method: "PATCH", pattern: "/posts/:id" },
  { method: "PUT", pattern: "/posts/:id" },
  { method: "DELETE", pattern: "/posts/:id" },
  { method: "GET", pattern: "/posts/:postId/comments/:commentId" },
];

describe("toOpenApi", () => {
  it("emits an OpenAPI 3.1 document with the given info", () => {
    const spec = toOpenApi(routes, { title: "Blog", version: "1.0.0" });

    expect(spec["openapi"]).toBe("3.1.0");
    expect(spec["info"]).toEqual({ title: "Blog", version: "1.0.0" });
  });

  it("includes a description on info only when one is provided", () => {
    const withDescription = toOpenApi(routes, {
      title: "Blog",
      version: "1.0.0",
      description: "The blog API.",
    });

    expect(withDescription["info"]).toEqual({
      title: "Blog",
      version: "1.0.0",
      description: "The blog API.",
    });

    const withoutDescription = toOpenApi(routes, { title: "Blog", version: "1.0.0" });

    expect(withoutDescription["info"]).not.toHaveProperty("description");
  });

  it("converts :param segments to OpenAPI {param} path keys", () => {
    const spec = toOpenApi(routes, { title: "Blog", version: "1.0.0" });
    const paths = spec["paths"] as Record<string, Record<string, unknown>>;

    expect(Object.keys(paths)).toEqual(
      expect.arrayContaining([
        "/posts",
        "/posts/new",
        "/posts/{id}",
        "/posts/{id}/edit",
        "/posts/{postId}/comments/{commentId}",
      ]),
    );
  });

  it("lowercases methods and derives operationId from verb + path", () => {
    const spec = toOpenApi(routes, { title: "Blog", version: "1.0.0" });
    const paths = spec["paths"] as Record<string, Record<string, { operationId: string }>>;

    // A path with a single verb.
    const collection = paths["/posts"] as Record<string, { operationId: string }>;
    expect(collection["get"]?.operationId).toBe("getPosts");
    expect(collection["post"]?.operationId).toBe("postPosts");

    // A member path collects several verbs under the same key.
    const member = paths["/posts/{id}"] as Record<string, { operationId: string }>;
    expect(Object.keys(member).toSorted()).toEqual(["delete", "get", "patch", "put"]);
    expect(member["get"]?.operationId).toBe("getPostsId");
    expect(member["delete"]?.operationId).toBe("deletePostsId");
  });

  it("declares a required string path parameter per :param", () => {
    const spec = toOpenApi(routes, { title: "Blog", version: "1.0.0" });
    const paths = spec["paths"] as Record<string, Record<string, { parameters: unknown[] }>>;

    // Two-param route extracts both, in order.
    const nested = paths["/posts/{postId}/comments/{commentId}"] as Record<
      string,
      { parameters: unknown[] }
    >;

    expect(nested["get"]?.parameters).toEqual([
      { name: "postId", in: "path", required: true, schema: { type: "string" } },
      { name: "commentId", in: "path", required: true, schema: { type: "string" } },
    ]);

    // A param-free route still carries an (empty) parameters array.
    const collection = paths["/posts"] as Record<string, { parameters: unknown[] }>;
    expect(collection["get"]?.parameters).toEqual([]);
  });

  it("attaches a 200 OK response to every operation", () => {
    const spec = toOpenApi(routes, { title: "Blog", version: "1.0.0" });
    const paths = spec["paths"] as Record<string, Record<string, { responses: unknown }>>;
    const member = paths["/posts/{id}"] as Record<string, { responses: unknown }>;

    expect(member["get"]?.responses).toEqual({ "200": { description: "OK" } });
  });
});

describe("internal-route filtering", () => {
  it("drops routes flagged internal before export", () => {
    const withInternal: readonly RouteEntry[] = [
      { method: "GET", pattern: "/posts" },
      { method: "GET", pattern: "/healthz", internal: true },
      { method: "POST", pattern: "/admin/flush", internal: true },
    ];

    const spec = toOpenApi(withInternal, { title: "Blog", version: "1.0.0" });
    const paths = spec["paths"] as Record<string, unknown>;

    expect(Object.keys(paths)).toEqual(["/posts"]);
    expect(paths).not.toHaveProperty("/healthz");
    expect(paths).not.toHaveProperty("/admin/flush");
  });

  it("keeps a route explicitly flagged internal: false", () => {
    const spec = toOpenApi([{ method: "GET", pattern: "/posts", internal: false }], {
      title: "Blog",
      version: "1.0.0",
    });
    const paths = spec["paths"] as Record<string, unknown>;

    expect(Object.keys(paths)).toEqual(["/posts"]);
  });

  it("drops routes the caller's isInternal predicate matches", () => {
    const spec = toOpenApi(
      [
        { method: "GET", pattern: "/posts" },
        { method: "GET", pattern: "/admin/posts" },
        { method: "POST", pattern: "/admin/posts" },
      ],
      { title: "Blog", version: "1.0.0" },
      { isInternal: (route) => route.pattern.startsWith("/admin") },
    );
    const paths = spec["paths"] as Record<string, unknown>;

    expect(Object.keys(paths)).toEqual(["/posts"]);
  });

  it("excludes a route matched by EITHER the flag or the predicate", () => {
    const spec = toOpenApi(
      [
        { method: "GET", pattern: "/posts" },
        { method: "GET", pattern: "/metrics", internal: true },
        { method: "GET", pattern: "/admin" },
      ],
      { title: "Blog", version: "1.0.0" },
      { isInternal: (route) => route.pattern === "/admin" },
    );
    const paths = spec["paths"] as Record<string, unknown>;

    expect(Object.keys(paths)).toEqual(["/posts"]);
  });

  it("leaves no empty path bucket when a path's every route is internal", () => {
    const spec = toOpenApi(
      [
        { method: "GET", pattern: "/posts" },
        { method: "GET", pattern: "/posts/:id", internal: true },
        { method: "DELETE", pattern: "/posts/:id", internal: true },
      ],
      { title: "Blog", version: "1.0.0" },
    );
    const paths = spec["paths"] as Record<string, unknown>;

    expect(Object.keys(paths)).toEqual(["/posts"]);
    expect(paths).not.toHaveProperty("/posts/{id}");
  });
});

describe("toJson", () => {
  it("round-trips the spec through a 2-space-indented JSON string", () => {
    const spec = toOpenApi(routes, { title: "Blog", version: "1.0.0" });
    const json = toJson(spec);

    expect(json).toContain("\n  ");
    expect(JSON.parse(json)).toEqual(spec);
  });
});
