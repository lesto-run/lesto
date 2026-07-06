// Unit tests for the PURE publish-ordering logic graduated into the fail-closed release
// (L-9cba7b41). `scripts/publish.mjs` splits its dependency-first topological ordering,
// workspace-dep extraction, and fail-fast orchestration into exported pure functions; the
// effectful CLI (bun pack + npm publish) is `main()`, guarded so importing this module runs
// nothing. We test the pure functions directly — no bun/npm/network.
//
// NOTE (wiring gap): `scripts/` is NOT in the coverage gate — scripts/coverage-gate.ts sweeps
// only packages/* members with a `test:cov` script. Run this file directly:
//   bunx vitest run scripts/publish.test.mjs
import { describe, expect, it } from "vitest";

import { lestoWorkspaceDeps, runPublish, topoSortPackages } from "./publish.mjs";

describe("lestoWorkspaceDeps", () => {
  it("collects @lesto/* runtime deps from `dependencies` ONLY — never devDependencies", () => {
    const deps = lestoWorkspaceDeps({
      dependencies: { "@lesto/errors": "workspace:*", jiti: "^2.7.0" },
      devDependencies: { "@lesto/assets": "workspace:*" },
    });
    // A consumer never installs a published package's devDependencies, so ordering them buys no
    // install-safety; scanning them would also risk a false dev-only cycle aborting the release.
    // This asserts the devDep (@lesto/assets) is EXCLUDED — it goes RED if devDeps are re-scanned.
    expect(deps).toEqual(["@lesto/errors"]);
  });

  it("ignores third-party semver deps", () => {
    expect(lestoWorkspaceDeps({ dependencies: { react: "^19", jiti: "^2" } })).toEqual([]);
  });

  it("catches a workspace: protocol edge even when the name is not @lesto-scoped", () => {
    // e.g. a local package depended on via `workspace:*` under an unscoped name.
    expect(lestoWorkspaceDeps({ dependencies: { "create-lesto": "workspace:*" } })).toEqual([
      "create-lesto",
    ]);
  });

  it("tolerates a manifest with no dependency sections", () => {
    expect(lestoWorkspaceDeps({})).toEqual([]);
    expect(lestoWorkspaceDeps(undefined)).toEqual([]);
  });
});

/** Assert every in-set dependency appears strictly before each package that depends on it. */
function assertDepsBeforeDependents(packages, order) {
  const inSet = new Set(packages.map((p) => p.name));
  const pos = new Map(order.map((name, i) => [name, i]));
  for (const p of packages) {
    for (const dep of p.deps) {
      if (inSet.has(dep)) {
        expect(pos.get(dep)).toBeLessThan(pos.get(p.name));
      }
    }
  }
}

describe("topoSortPackages", () => {
  it("(a) orders every dependency BEFORE its dependents (the safety invariant)", () => {
    // Mirrors the real graph shape: @lesto/sites → {@lesto/seo, @lesto/errors}; @lesto/seo →
    // @lesto/errors. Input order is deliberately dependents-first to prove the sort reorders.
    const packages = [
      { name: "@lesto/sites", deps: ["@lesto/seo", "@lesto/errors"] },
      { name: "@lesto/seo", deps: ["@lesto/errors"] },
      { name: "@lesto/errors", deps: [] },
    ];
    const order = topoSortPackages(packages);

    // This is the RED canary: if the topo sort emitted a package before its dependency (e.g. a
    // bug that pushed a node before recursing into its deps), these strict-ordering assertions
    // fail — a dependent must never precede a dependency it exact-pins.
    assertDepsBeforeDependents(packages, order);
    expect(order.indexOf("@lesto/errors")).toBeLessThan(order.indexOf("@lesto/seo"));
    expect(order.indexOf("@lesto/seo")).toBeLessThan(order.indexOf("@lesto/sites"));
    expect(new Set(order)).toEqual(new Set(packages.map((p) => p.name))); // every node present, once
    expect(order).toHaveLength(3);
  });

  it("orders a deep/transitive chain dependency-first", () => {
    const packages = [
      { name: "d", deps: ["c"] },
      { name: "c", deps: ["b"] },
      { name: "b", deps: ["a"] },
      { name: "a", deps: [] },
    ];
    expect(topoSortPackages(packages)).toEqual(["a", "b", "c", "d"]);
  });

  it("(b) IGNORES a dep on a package outside the set (registry/third-party), no throw", () => {
    // @lesto/foo depends on @lesto/not-published, which isn't in the closure — it resolves from
    // the registry, so it must not constrain ordering and must not error.
    const packages = [
      { name: "@lesto/foo", deps: ["@lesto/not-published", "@lesto/bar"] },
      { name: "@lesto/bar", deps: [] },
    ];
    const order = topoSortPackages(packages);
    expect(new Set(order)).toEqual(new Set(["@lesto/foo", "@lesto/bar"]));
    expect(order.indexOf("@lesto/bar")).toBeLessThan(order.indexOf("@lesto/foo"));
    assertDepsBeforeDependents(packages, order);
  });

  it("(b) THROWS on a dependency cycle (an unpublishable graph — a real bug)", () => {
    const packages = [
      { name: "a", deps: ["b"] },
      { name: "b", deps: ["a"] },
    ];
    expect(() => topoSortPackages(packages)).toThrow(/cycle/i);
  });

  it("is a no-op for the empty set", () => {
    expect(topoSortPackages([])).toEqual([]);
  });
});

describe("runPublish (fail-closed orchestration)", () => {
  it("(c) FAIL-FAST: stops at the first failure and attempts NOTHING downstream", () => {
    const attempts = [];
    const outcome = runPublish(["a", "b", "c", "d"], (name) => {
      attempts.push(name);
      if (name === "b") throw new Error("403 no trusted publisher");
      return "published";
    });

    expect(outcome.failed).toBe("b");
    expect(outcome.error).toBeInstanceOf(Error);
    expect(outcome.published).toEqual(["a"]);
    expect(outcome.attempted).toEqual(["a", "b"]); // c and d NEVER attempted
    expect(attempts).toEqual(["a", "b"]); // the injected effect confirms it — no downstream call
  });

  it("records skips vs publishes and reports success when all succeed", () => {
    const outcome = runPublish(["a", "b", "c"], (name) => (name === "b" ? "skipped" : "published"));
    expect(outcome.failed).toBeNull();
    expect(outcome.error).toBeNull();
    expect(outcome.published).toEqual(["a", "c"]);
    expect(outcome.skipped).toEqual(["b"]);
    expect(outcome.attempted).toEqual(["a", "b", "c"]);
  });

  it("SAFETY: with topo order, failing a dependency never lets a dependent be attempted", () => {
    // The two pure pieces composed: order dependency-first, then fail the dependency. Every
    // dependent that exact-pins it must be left unattempted. If the ordering regressed so a
    // dependent preceded its dep, that dependent WOULD appear in `attempted` and this fails.
    const packages = [
      { name: "@lesto/sites", deps: ["@lesto/seo", "@lesto/errors"] },
      { name: "@lesto/seo", deps: ["@lesto/errors"] },
      { name: "@lesto/errors", deps: [] },
    ];
    const order = topoSortPackages(packages);
    const outcome = runPublish(order, (name) => {
      if (name === "@lesto/errors") throw new Error("403");
      return "published";
    });
    expect(outcome.failed).toBe("@lesto/errors");
    expect(outcome.attempted).not.toContain("@lesto/seo");
    expect(outcome.attempted).not.toContain("@lesto/sites");
  });
});
