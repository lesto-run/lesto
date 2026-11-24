// Unit tests for the capped workspace typecheck behind `bun run ws:typecheck`
// (`scripts/lib/workspace-typecheck.mjs`). Registered in `test:scripts-unit`:
//   bunx vitest run scripts/workspace-typecheck.test.mjs
import { describe, expect, it } from "vitest";

import {
  PACKAGE_SCOPE,
  TYPECHECK_CONCURRENCY,
  expandWorkspaces,
  runLimited,
  selectTypecheckPackages,
  summarizeFailures,
} from "./lib/workspace-typecheck.mjs";

describe("expandWorkspaces", () => {
  const tree = {
    packages: ["queue", "cli"],
    examples: ["blog", "hmr-check"],
  };
  const listDirs = (dir) => tree[dir] ?? [];

  it("expands one-level wildcards, keeps literals and applies exclusions", () => {
    expect(
      expandWorkspaces(["packages/*", "examples/*", "!examples/hmr-check", "site"], listDirs),
    ).toEqual(["examples/blog", "packages/cli", "packages/queue", "site"]);
  });

  it("expands the repository's real workspaces list without throwing", () => {
    expect(() =>
      expandWorkspaces(
        ["packages/*", "examples/*", "!examples/hmr-check", "site", "www", "benchmarks/apps/lesto"],
        listDirs,
      ),
    ).not.toThrow();
  });

  it.each(["packages/**", "packages/*/sub", "!examples/hmr-*", "apps/{a,b}"])(
    "refuses the unsupported pattern %s instead of silently dropping packages",
    (pattern) => {
      expect(() => expandWorkspaces([pattern], listDirs)).toThrow(/unsupported workspaces pattern/);
    },
  );
});

describe("selectTypecheckPackages", () => {
  it("keeps only @lesto/* packages that declare a typecheck script, sorted by name", () => {
    const selected = selectTypecheckPackages([
      { dir: "packages/web", manifest: { name: "@lesto/web", scripts: { typecheck: "tsc" } } },
      { dir: "packages/cli", manifest: { name: "@lesto/cli", scripts: { typecheck: "tsc" } } },
      { dir: "packages/e2e", manifest: { name: "lesto-e2e", scripts: { typecheck: "tsc" } } },
      { dir: "packages/x", manifest: { name: "@lesto/x", scripts: { test: "vitest" } } },
      { dir: "packages/y", manifest: { name: "@lesto/y" } },
      { dir: "packages/z", manifest: {} },
    ]);

    expect(selected).toEqual([
      { name: "@lesto/cli", dir: "packages/cli" },
      { name: "@lesto/web", dir: "packages/web" },
    ]);
    expect(PACKAGE_SCOPE).toBe("@lesto/");
  });
});

describe("runLimited", () => {
  it("never runs more than the limit at once and keeps input order", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases = [];

    const task = (item) =>
      new Promise((resolve) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        releases.push(() => {
          inFlight -= 1;
          resolve(item * 10);
        });
      });

    const run = runLimited([1, 2, 3, 4, 5, 6, 7], 3, task);

    while (releases.length > 0) {
      await Promise.resolve();
      expect(inFlight).toBeLessThanOrEqual(3);
      // Settle the newest task first, so completion order differs from input order.
      releases.pop()();
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(await run).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });

  it("handles fewer items than the limit, and none at all", async () => {
    expect(await runLimited([1], 4, async (n) => n + 1)).toEqual([2]);
    expect(await runLimited([], 4, async (n) => n)).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses the limit %s", async (limit) => {
    await expect(runLimited([1], limit, async (n) => n)).rejects.toThrow(/positive integer/);
  });

  it("caps the real typecheck at 4", () => {
    expect(TYPECHECK_CONCURRENCY).toBe(4);
  });
});

describe("summarizeFailures", () => {
  it("is null when every package passed", () => {
    expect(summarizeFailures([{ name: "@lesto/cli", code: 0 }])).toBeNull();
  });

  it("names each failed package with its exit code or start error", () => {
    expect(
      summarizeFailures([
        { name: "@lesto/cli", code: 0 },
        { name: "@lesto/web", code: 2 },
        { name: "@lesto/db", code: null, error: "spawn bun ENOENT" },
      ]),
    ).toBe(
      [
        "ws:typecheck failed in 2 of 3 packages:",
        "  @lesto/web: exit 2",
        "  @lesto/db: could not start (spawn bun ENOENT)",
      ].join("\n"),
    );
  });
});
