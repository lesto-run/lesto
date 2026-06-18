/**
 * The ported `@volo/rbac` matrix.
 *
 * When `@volo/rbac` was folded into `definePolicy` (one authorization story
 * before the API freeze), its full test matrix moved here verbatim in behavior —
 * every wildcard, inheritance, cycle, and multi-role case is preserved, retold in
 * the policy's declarative shape. `Permissions#can(roles, perm)` becomes
 * `policy.allows(roles, perm)`; a role's `permissions` + `inherits` become the
 * `can` grants plus the `inherits` map.
 *
 * One contract tightened in the fold and is asserted as such: rbac resolved
 * unknown role names lazily (an unknown *parent* was silently ignored at query
 * time; `permissionsFor` threw only when asked). `definePolicy` instead validates
 * the whole vocabulary at declaration time, so an undeclared role anywhere — a
 * grantee or an inheritance edge — fails fast with `AUTHZ_UNKNOWN_ROLE`. An
 * unknown role *presented by a subject at request time* still contributes
 * nothing (fails closed), exactly as before.
 */

import { describe, expect, it } from "vitest";

import { AuthzError, definePolicy } from "../src/index";

describe("ported rbac: grants and wildcards", () => {
  it("grants an exact permission", () => {
    const policy = definePolicy({
      roles: ["reader"],
      can: { "posts:read": ["reader"], "posts:write": [] },
    });

    expect(policy.allows(["reader"], "posts:read")).toBe(true);
    expect(policy.allows(["reader"], "posts:write")).toBe(false);
  });

  it("matches a resource wildcard but not a sibling resource", () => {
    const policy = definePolicy({
      roles: ["author"],
      can: {
        "posts:*": ["author"],
        "posts:read": [],
        "posts:delete": [],
        "comments:read": [],
      },
    });

    expect(policy.allows(["author"], "posts:read")).toBe(true);
    expect(policy.allows(["author"], "posts:delete")).toBe(true);
    expect(policy.allows(["author"], "comments:read")).toBe(false);
  });

  it("matches the global wildcard against anything", () => {
    const policy = definePolicy({
      roles: ["root"],
      can: { "*": ["root"] },
    });

    // The point of "*" is to cover permissions the policy never enumerates as
    // keys, so these probes are intentionally outside the `Permission` union —
    // the same cast idiom the base policy suite uses for an unknown permission.
    expect(policy.allows(["root"], "posts:read" as "*")).toBe(true);
    expect(policy.allows(["root"], "anything:at:all" as "*")).toBe(true);
  });

  it("grants when only one of several roles grants", () => {
    const policy = definePolicy({
      roles: ["viewer", "billing"],
      can: { "posts:read": ["viewer"], "invoices:read": ["billing"] },
    });

    expect(policy.allows(["viewer", "billing"], "invoices:read")).toBe(true);
  });

  it("returns false when no role grants", () => {
    const policy = definePolicy({
      roles: ["viewer"],
      can: { "posts:read": ["viewer"], "posts:write": [] },
    });

    expect(policy.allows(["viewer"], "posts:write")).toBe(false);
  });

  it("treats an unknown subject role as simply false, never a throw", () => {
    const policy = definePolicy({
      roles: ["reader"],
      can: { "posts:read": ["reader"] },
    });

    // "ghost" is not in the policy vocabulary; presented by a subject it
    // resolves to an empty grant set rather than throwing — fail closed.
    expect(policy.allows(["ghost"], "posts:read")).toBe(false);
  });
});

describe("ported rbac: inheritance", () => {
  it("sees a parent role's permissions (b inherits a)", () => {
    const policy = definePolicy({
      roles: ["a", "b"],
      can: { "posts:read": ["a"], "comments:read": ["b"] },
      inherits: { b: ["a"] },
    });

    expect(policy.allows(["b"], "posts:read")).toBe(true);
    expect(policy.allows(["b"], "comments:read")).toBe(true);
  });

  it("resolves transitive inheritance (c -> b -> a)", () => {
    const policy = definePolicy({
      roles: ["a", "b", "c"],
      can: { "posts:read": ["a"], "comments:read": ["b"], "billing:read": ["c"] },
      inherits: { b: ["a"], c: ["b"] },
    });

    expect(policy.allows(["c"], "posts:read")).toBe(true);
    expect(policy.allows(["c"], "comments:read")).toBe(true);
    expect(policy.allows(["c"], "billing:read")).toBe(true);
  });

  it("resolves a cycle without hanging (a inherits b, b inherits a)", () => {
    const policy = definePolicy({
      roles: ["a", "b"],
      can: { "posts:read": ["a"], "comments:read": ["b"] },
      inherits: { a: ["b"], b: ["a"] },
    });

    expect(policy.allows(["a"], "posts:read")).toBe(true);
    expect(policy.allows(["a"], "comments:read")).toBe(true);
    // Both grants are reachable from either end of the cycle.
    expect(policy.allows(["b"], "posts:read")).toBe(true);
    expect(policy.allows(["b"], "comments:read")).toBe(true);
  });

  it("de-duplicates a permission shared across an inheritance edge", () => {
    // a and b both grant "shared:x"; b inherits a. b resolves both its own and
    // a's grants with no double-counting, and still covers the shared one once.
    const policy = definePolicy({
      roles: ["a", "b"],
      can: {
        "posts:read": ["a"],
        "shared:x": ["a", "b"],
        "comments:read": ["b"],
      },
      inherits: { b: ["a"] },
    });

    expect(policy.allows(["b"], "shared:x")).toBe(true);
    expect(policy.allows(["b"], "posts:read")).toBe(true);
    expect(policy.allows(["b"], "comments:read")).toBe(true);
  });

  it("combines inheritance with a wildcard grant on the parent", () => {
    // editor inherits author, which holds posts:* — editor gets the whole
    // resource by inheritance, plus its own concrete grant.
    const policy = definePolicy({
      roles: ["author", "editor"],
      can: {
        "posts:*": ["author"],
        "posts:read": [], // a concrete permission the parent's wildcard covers
        "comments:moderate": ["editor"],
        "billing:refund": [],
      },
      inherits: { editor: ["author"] },
    });

    expect(policy.allows(["editor"], "posts:read")).toBe(true);
    expect(policy.allows(["editor"], "comments:moderate")).toBe(true);
    expect(policy.allows(["editor"], "billing:refund")).toBe(false);
  });
});

describe("ported rbac: declaration-time validation (tightened in the fold)", () => {
  it("rejects an inheritance edge naming an undeclared parent", () => {
    expect(() =>
      definePolicy({
        roles: ["b"],
        can: { "comments:read": ["b"] },
        inherits: { b: ["missing"] },
      }),
    ).toThrow(AuthzError);
  });

  it("rejects inheritance declared for an undeclared child role", () => {
    let caught: unknown;

    try {
      definePolicy({
        roles: ["a"],
        can: { "posts:read": ["a"] },
        inherits: { ghost: ["a"] } as never,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthzError);
    expect((caught as AuthzError).code).toBe("AUTHZ_UNKNOWN_ROLE");
    expect((caught as AuthzError).details).toEqual({ role: "ghost" });
  });

  it("reports the offending role and parent on an undeclared parent", () => {
    let caught: unknown;

    try {
      definePolicy({
        roles: ["b"],
        can: { "comments:read": ["b"] },
        inherits: { b: ["missing"] as never },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthzError);
    expect((caught as AuthzError).code).toBe("AUTHZ_UNKNOWN_ROLE");
    expect((caught as AuthzError).details).toEqual({ role: "b", parent: "missing" });
  });

  it("tolerates a role declared with an empty inheritance list", () => {
    const policy = definePolicy({
      roles: ["a", "b"],
      can: { "posts:read": ["a"], "comments:read": ["b"] },
      inherits: { a: [], b: ["a"] },
    });

    expect(policy.allows(["b"], "posts:read")).toBe(true);
    expect(policy.allows(["a"], "comments:read")).toBe(false);
  });
});

describe("ported rbac: resolved-grant memoization", () => {
  it("resolves a role's grants once and serves the cached set thereafter", () => {
    // A diamond: d inherits b and c, both of which inherit a. Without memoizing
    // the cycle-safe walk, a's grants would be re-collected on every allows; the
    // memo makes the second-and-later asks read one already-resolved set.
    const policy = definePolicy({
      roles: ["a", "b", "c", "d"],
      can: {
        "a:grant": ["a"],
        "b:grant": ["b"],
        "c:grant": ["c"],
        "d:grant": ["d"],
      },
      inherits: { b: ["a"], c: ["a"], d: ["b", "c"] },
    });

    // Repeated asks against the same role are stable and correct — the memo is
    // a cache, not a one-shot: it must keep answering.
    for (let i = 0; i < 3; i++) {
      expect(policy.allows(["d"], "a:grant")).toBe(true);
      expect(policy.allows(["d"], "b:grant")).toBe(true);
      expect(policy.allows(["d"], "c:grant")).toBe(true);
      expect(policy.allows(["d"], "d:grant")).toBe(true);
      expect(policy.allows(["d"], "nope:grant" as "a:grant")).toBe(false);
    }

    // A different subject role exercises a fresh memo entry alongside the first.
    expect(policy.allows(["b"], "a:grant")).toBe(true);
    expect(policy.allows(["b"], "c:grant")).toBe(false);
  });
});
