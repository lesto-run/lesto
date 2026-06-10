import { describe, expect, it } from "vitest";

import { AuthzError, definePolicy } from "../src/index";

const policy = definePolicy({
  roles: ["guest", "member", "agent", "admin"],
  can: {
    "listing.read": ["guest", "member", "agent", "admin"],
    "listing.write": ["agent", "admin"],
    "admin.access": ["admin"],
    "nobody.can": [],
  },
});

describe("definePolicy validation", () => {
  it("rejects a permission that grants an undeclared role", () => {
    expect(() =>
      definePolicy({
        roles: ["member"],
        can: { "x.do": ["member", "ghost"] },
      }),
    ).toThrow(AuthzError);
  });

  it("accepts a valid policy", () => {
    expect(policy.roles).toEqual(["guest", "member", "agent", "admin"]);
  });
});

describe("policy.allows", () => {
  it("grants when the subject holds a permitted role", () => {
    expect(policy.allows(["agent"], "listing.write")).toBe(true);
    expect(policy.allows(["admin"], "admin.access")).toBe(true);
  });

  it("denies when the subject holds no permitted role", () => {
    expect(policy.allows(["member"], "listing.write")).toBe(false);
  });

  it("denies a subject with no roles (undefined)", () => {
    expect(policy.allows(undefined, "listing.read")).toBe(false);
  });

  it("denies a permission no role was granted", () => {
    expect(policy.allows(["admin"], "nobody.can")).toBe(false);
  });

  it("denies an unknown permission by default", () => {
    expect(policy.allows(["admin"], "ghost.permission" as "admin.access")).toBe(false);
  });

  it("accepts any iterable of roles, e.g. a Set", () => {
    expect(policy.allows(new Set(["admin"]), "listing.write")).toBe(true);
  });
});

describe("policy introspection (for the audit)", () => {
  it("lists every governed permission", () => {
    expect(policy.permissions()).toEqual([
      "listing.read",
      "listing.write",
      "admin.access",
      "nobody.can",
    ]);
  });

  it("reports the roles that hold a permission", () => {
    expect(policy.rolesFor("listing.write")).toEqual(["agent", "admin"]);
  });

  it("reports an empty grant for an unknown permission", () => {
    expect(policy.rolesFor("ghost" as "admin.access")).toEqual([]);
  });
});
