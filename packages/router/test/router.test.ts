import { describe, expect, it } from "vitest";

import { Router, RouterError } from "../src/index";

describe("verb helpers", () => {
  it("registers every verb and resolves it to its target", () => {
    const router = new Router();

    router.get("/things", "things#index");
    router.post("/things", "things#create");
    router.patch("/things/:id", "things#update");
    router.put("/things/:id", "things#replace");
    router.delete("/things/:id", "things#destroy");

    expect(router.resolve("GET", "/things")?.target).toBe("things#index");
    expect(router.resolve("POST", "/things")?.target).toBe("things#create");
    expect(router.resolve("PATCH", "/things/1")?.target).toBe("things#update");
    expect(router.resolve("PUT", "/things/1")?.target).toBe("things#replace");
    expect(router.resolve("DELETE", "/things/1")?.target).toBe("things#destroy");
  });

  it("returns `this` from verb helpers so calls chain", () => {
    const router = new Router();

    const returned = router.get("/a", "a#index").post("/a", "a#create");

    expect(returned).toBe(router);
  });
});

describe("resolve", () => {
  it("extracts a `:id` param from the matched path", () => {
    const router = new Router();

    router.get("/posts/:id", "posts#show");

    const resolution = router.resolve("GET", "/posts/42");

    expect(resolution).toEqual({ target: "posts#show", params: { id: "42" } });
  });

  it("returns undefined when no pattern fits the path", () => {
    const router = new Router();

    router.get("/posts", "posts#index");

    expect(router.resolve("GET", "/nope")).toBeUndefined();
  });

  it("returns undefined when the path matches but the method does not", () => {
    const router = new Router();

    router.get("/posts/:id", "posts#show");

    expect(router.resolve("DELETE", "/posts/42")).toBeUndefined();
  });

  it("treats `.` in a static segment as a literal, not a wildcard", () => {
    const router = new Router();

    router.get("/feed.json", "feeds#show");

    expect(router.resolve("GET", "/feedXjson")).toBeUndefined();
    expect(router.resolve("GET", "/feed.json")?.target).toBe("feeds#show");
  });
});

describe("ambiguous-segment guard", () => {
  it("refuses two params in one segment at declaration time", () => {
    const router = new Router();

    try {
      router.get("/posts/:a-:b", "posts#show");
      expect.unreachable("declaring an ambiguous segment should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("ROUTER_AMBIGUOUS_SEGMENT");
      expect((error as RouterError).details).toEqual({ pattern: "/posts/:a-:b", param: "b" });
    }
  });

  it("refuses two adjacent params with no separator", () => {
    const router = new Router();

    expect(() => router.get("/:a:b", "x#y")).toThrow(RouterError);
  });

  it("allows multiple params in separate `/` segments", () => {
    const router = new Router();

    router.get("/posts/:post_id/comments/:id", "comments#show");

    expect(router.resolve("GET", "/posts/3/comments/8")).toEqual({
      target: "comments#show",
      params: { post_id: "3", id: "8" },
    });
  });
});

describe("root", () => {
  it("answers GET / and is named root", () => {
    const router = new Router();

    router.root("home#index");

    expect(router.resolve("GET", "/")?.target).toBe("home#index");
    expect(router.pathFor("root")).toBe("/");
  });
});

describe("resources", () => {
  it("generates exactly the seven RESTful routes with correct targets and names", () => {
    const router = new Router();

    router.resources("posts");

    expect(router.list()).toEqual([
      { method: "GET", pattern: "/posts", target: "posts#index", name: "posts" },
      { method: "GET", pattern: "/posts/new", target: "posts#new", name: "new_post" },
      { method: "POST", pattern: "/posts", target: "posts#create" },
      { method: "GET", pattern: "/posts/:id", target: "posts#show", name: "post" },
      { method: "GET", pattern: "/posts/:id/edit", target: "posts#edit", name: "edit_post" },
      { method: "PATCH", pattern: "/posts/:id", target: "posts#update" },
      { method: "PUT", pattern: "/posts/:id", target: "posts#update" },
      { method: "DELETE", pattern: "/posts/:id", target: "posts#destroy" },
    ]);
  });

  it("leaves a name with no trailing 's' unchanged when singularizing", () => {
    const router = new Router();

    router.resources("fish");

    // "fish" does not end in "s", so the "new" route is named "new_fish",
    // exercising the singularizer's pass-through branch.
    expect(router.pathFor("new_fish")).toBe("/fish/new");
    expect(router.pathFor("edit_fish", { id: 7 })).toBe("/fish/7/edit");
  });

  it("returns `this` without nesting when no nest callback is given", () => {
    const router = new Router();

    expect(router.resources("posts")).toBe(router);
  });

  it("nests child resources under the parent's singular id", () => {
    const router = new Router();

    router.resources("posts", (posts) => {
      posts.resources("comments");
    });

    const resolution = router.resolve("GET", "/posts/3/comments/8");

    expect(resolution).toEqual({
      target: "comments#show",
      params: { post_id: "3", id: "8" },
    });
  });
});

describe("pathFor", () => {
  it("builds a path and percent-encodes the substituted values", () => {
    const router = new Router();

    router.resources("posts");

    expect(router.pathFor("post", { id: "a b/c" })).toBe("/posts/a%20b%2Fc");
  });

  it("accepts numeric param values", () => {
    const router = new Router();

    router.resources("posts");

    expect(router.pathFor("post", { id: 42 })).toBe("/posts/42");
  });

  it("throws ROUTER_UNKNOWN_NAMED_ROUTE for a name with no route", () => {
    const router = new Router();

    try {
      router.pathFor("ghost");
      expect.unreachable("pathFor should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("ROUTER_UNKNOWN_NAMED_ROUTE");
      expect((error as RouterError).details).toEqual({ name: "ghost" });
    }
  });

  it("throws ROUTER_MISSING_PARAM when a required param is absent", () => {
    const router = new Router();

    router.resources("posts");

    try {
      router.pathFor("post");
      expect.unreachable("pathFor should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RouterError);
      expect((error as RouterError).code).toBe("ROUTER_MISSING_PARAM");
      expect((error as RouterError).details).toEqual({ name: "post", param: "id" });
    }
  });
});

describe("list", () => {
  it("reports declared routes in resolution order, omitting name when unset", () => {
    const router = new Router();

    router.get("/health", "system#health");

    expect(router.list()).toEqual([{ method: "GET", pattern: "/health", target: "system#health" }]);
  });
});
