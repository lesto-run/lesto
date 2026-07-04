import { describe, expect, it } from "vitest";

import { packageNameOf, resolveInstalledPackage } from "../src/resolve-import";

/** An `exists` predicate backed by a fixed set of paths that "exist". */
const existsIn =
  (...paths: string[]) =>
  (path: string): boolean =>
    paths.includes(path);

describe("packageNameOf", () => {
  it("extracts the scoped package from a subpath specifier", () => {
    expect(packageNameOf("@lesto/observability/rum")).toBe("@lesto/observability");
  });

  it("returns a bare scoped package unchanged", () => {
    expect(packageNameOf("@lesto/ui")).toBe("@lesto/ui");
  });

  it("extracts an unscoped package from a subpath specifier", () => {
    expect(packageNameOf("react-dom/client")).toBe("react-dom");
  });

  it("returns a bare unscoped package unchanged", () => {
    expect(packageNameOf("preact")).toBe("preact");
  });
});

describe("resolveInstalledPackage", () => {
  it("finds the package in the app root's own node_modules", () => {
    const exists = existsIn("/app/node_modules/@lesto/observability/package.json");

    expect(resolveInstalledPackage("@lesto/observability/rum", "/app", exists)).toBe(
      "/app/node_modules/@lesto/observability",
    );
  });

  it("walks UP to a hoisted ancestor node_modules when the app root has none", () => {
    // The isolated app root lacks it; a hoisted monorepo root two levels up holds it.
    const exists = existsIn("/repo/node_modules/@lesto/observability/package.json");

    expect(resolveInstalledPackage("@lesto/observability/rum", "/repo/apps/web", exists)).toBe(
      "/repo/node_modules/@lesto/observability",
    );
  });

  it("returns undefined when no ancestor holds the package (the missing-dep case)", () => {
    // Nothing exists anywhere — the walk reaches the filesystem root and terminates.
    const exists = existsIn();

    expect(
      resolveInstalledPackage("@lesto/observability/rum", "/repo/apps/web", exists),
    ).toBeUndefined();
  });

  it("resolves an unscoped package by its first segment", () => {
    const exists = existsIn("/app/node_modules/preact/package.json");

    expect(resolveInstalledPackage("preact/compat", "/app", exists)).toBe(
      "/app/node_modules/preact",
    );
  });
});
