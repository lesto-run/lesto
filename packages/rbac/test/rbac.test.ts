import { describe, expect, it } from "vitest";

import { Permissions, RbacError } from "../src/index";

describe("Permissions.can — grants and wildcards", () => {
  it("grants an exact permission", () => {
    const perms = new Permissions();
    perms.defineRole("reader", ["posts:read"]);

    expect(perms.can(["reader"], "posts:read")).toBe(true);
    expect(perms.can(["reader"], "posts:write")).toBe(false);
  });

  it("matches a resource wildcard but not a sibling resource", () => {
    const perms = new Permissions();
    perms.defineRole("author", ["posts:*"]);

    expect(perms.can(["author"], "posts:read")).toBe(true);
    expect(perms.can(["author"], "posts:delete")).toBe(true);
    expect(perms.can(["author"], "comments:read")).toBe(false);
  });

  it("matches the global wildcard against anything", () => {
    const perms = new Permissions();
    perms.defineRole("root", ["*"]);

    expect(perms.can(["root"], "posts:read")).toBe(true);
    expect(perms.can(["root"], "anything:at:all")).toBe(true);
  });

  it("grants when only one of several roles grants", () => {
    const perms = new Permissions();
    perms.defineRole("viewer", ["posts:read"]);
    perms.defineRole("billing", ["invoices:read"]);

    expect(perms.can(["viewer", "billing"], "invoices:read")).toBe(true);
  });

  it("returns false when no role grants", () => {
    const perms = new Permissions();
    perms.defineRole("viewer", ["posts:read"]);

    expect(perms.can(["viewer"], "posts:write")).toBe(false);
  });

  it("treats an unknown role name as simply false, never a throw", () => {
    const perms = new Permissions();

    expect(perms.can(["ghost"], "posts:read")).toBe(false);
  });
});

describe("Permissions — inheritance", () => {
  it("sees a parent role's permissions (B inherits A)", () => {
    const perms = new Permissions();
    perms.defineRole("a", ["posts:read"]);
    perms.defineRole("b", ["comments:read"], { inherits: ["a"] });

    expect(perms.can(["b"], "posts:read")).toBe(true);
    expect(perms.can(["b"], "comments:read")).toBe(true);
  });

  it("resolves transitive inheritance (C -> B -> A)", () => {
    const perms = new Permissions();
    perms.defineRole("a", ["posts:read"]);
    perms.defineRole("b", ["comments:read"], { inherits: ["a"] });
    perms.defineRole("c", ["billing:read"], { inherits: ["b"] });

    expect(perms.can(["c"], "posts:read")).toBe(true);
    expect(perms.can(["c"], "comments:read")).toBe(true);
    expect(perms.can(["c"], "billing:read")).toBe(true);
  });

  it("resolves a cycle without hanging (A inherits B, B inherits A)", () => {
    const perms = new Permissions();
    perms.defineRole("a", ["posts:read"], { inherits: ["b"] });
    perms.defineRole("b", ["comments:read"], { inherits: ["a"] });

    expect(perms.can(["a"], "posts:read")).toBe(true);
    expect(perms.can(["a"], "comments:read")).toBe(true);
    expect(perms.permissionsFor("a").toSorted()).toEqual(["comments:read", "posts:read"]);
  });

  it("ignores an unknown parent role during resolution", () => {
    const perms = new Permissions();
    perms.defineRole("b", ["comments:read"], { inherits: ["missing"] });

    expect(perms.permissionsFor("b")).toEqual(["comments:read"]);
  });
});

describe("Permissions.permissionsFor", () => {
  it("de-duplicates across inheritance", () => {
    const perms = new Permissions();
    perms.defineRole("a", ["posts:read", "shared:x"]);
    perms.defineRole("b", ["shared:x", "comments:read"], { inherits: ["a"] });

    expect(perms.permissionsFor("b").toSorted()).toEqual([
      "comments:read",
      "posts:read",
      "shared:x",
    ]);
  });

  it("throws RBAC_UNKNOWN_ROLE on an unknown role", () => {
    const perms = new Permissions();

    let caught: unknown;

    try {
      perms.permissionsFor("ghost");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(RbacError);
    expect((caught as RbacError).code).toBe("RBAC_UNKNOWN_ROLE");
    expect((caught as RbacError).details).toEqual({ role: "ghost" });
  });
});

describe("Permissions.hasRole and defineRole", () => {
  it("reports whether a role is defined", () => {
    const perms = new Permissions();
    perms.defineRole("a", []);

    expect(perms.hasRole("a")).toBe(true);
    expect(perms.hasRole("b")).toBe(false);
  });

  it("chains defineRole and defaults inherits to none", () => {
    const perms = new Permissions();

    const returned = perms.defineRole("a", ["posts:read"]).defineRole("b", ["comments:read"]);

    expect(returned).toBe(perms);
    expect(perms.permissionsFor("a")).toEqual(["posts:read"]);
  });
});
