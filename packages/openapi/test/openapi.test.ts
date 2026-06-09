import { Router } from "@keel/router";
import { describe, expect, it } from "vitest";

import { toJson, toOpenApi } from "../src/index";

// A small but representative router: the seven RESTful routes for `posts`,
// plus a hand-written route carrying two `:param` segments.
const buildRouter = (): Router => {
  const router = new Router();

  router.resources("posts");
  router.get("/posts/:postId/comments/:commentId", "comments#show");

  return router;
};

describe("toOpenApi", () => {
  it("emits an OpenAPI 3.1 document with the given info", () => {
    const spec = toOpenApi(buildRouter(), { title: "Blog", version: "1.0.0" });

    expect(spec["openapi"]).toBe("3.1.0");
    expect(spec["info"]).toEqual({ title: "Blog", version: "1.0.0" });
  });

  it("includes a description on info only when one is provided", () => {
    const withDescription = toOpenApi(buildRouter(), {
      title: "Blog",
      version: "1.0.0",
      description: "The blog API.",
    });

    expect(withDescription["info"]).toEqual({
      title: "Blog",
      version: "1.0.0",
      description: "The blog API.",
    });

    const withoutDescription = toOpenApi(buildRouter(), { title: "Blog", version: "1.0.0" });

    expect(withoutDescription["info"]).not.toHaveProperty("description");
  });

  it("converts :param segments to OpenAPI {param} path keys", () => {
    const spec = toOpenApi(buildRouter(), { title: "Blog", version: "1.0.0" });
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

  it("lowercases methods and maps operationId to the route target", () => {
    const spec = toOpenApi(buildRouter(), { title: "Blog", version: "1.0.0" });
    const paths = spec["paths"] as Record<string, Record<string, { operationId: string }>>;

    // A path with a single verb.
    const collection = paths["/posts"] as Record<string, { operationId: string }>;
    expect(collection["get"]?.operationId).toBe("posts#index");
    expect(collection["post"]?.operationId).toBe("posts#create");

    // A member path collects several verbs under the same key.
    const member = paths["/posts/{id}"] as Record<string, { operationId: string }>;
    expect(Object.keys(member).toSorted()).toEqual(["delete", "get", "patch", "put"]);
    expect(member["get"]?.operationId).toBe("posts#show");
    expect(member["delete"]?.operationId).toBe("posts#destroy");
  });

  it("declares a required string path parameter per :param", () => {
    const spec = toOpenApi(buildRouter(), { title: "Blog", version: "1.0.0" });
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

    // A param-free route still carries a (empty) parameters array.
    const collection = paths["/posts"] as Record<string, { parameters: unknown[] }>;
    expect(collection["get"]?.parameters).toEqual([]);
  });

  it("attaches a 200 OK response to every operation", () => {
    const spec = toOpenApi(buildRouter(), { title: "Blog", version: "1.0.0" });
    const paths = spec["paths"] as Record<string, Record<string, { responses: unknown }>>;
    const member = paths["/posts/{id}"] as Record<string, { responses: unknown }>;

    expect(member["get"]?.responses).toEqual({ "200": { description: "OK" } });
  });
});

describe("toJson", () => {
  it("round-trips the spec through a 2-space-indented JSON string", () => {
    const spec = toOpenApi(buildRouter(), { title: "Blog", version: "1.0.0" });
    const json = toJson(spec);

    expect(json).toContain("\n  ");
    expect(JSON.parse(json)).toEqual(spec);
  });
});
