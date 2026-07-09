// Unit tests for the new-package generator. Wired into CI's scripts-unit job
// (.github/workflows/ci.yml) — scripts/ is outside the coverage gate, so a test
// that never runs is green-because-never-run; this runs there so a regression
// (e.g. the leading-digit identifier bug) goes red instead of shipping green.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  createPackage,
  currentLineVersion,
  isValidShortName,
  toIdentifier,
} from "./new-package.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

function freshRoot() {
  const root = mkdtempSync(join(tmpdir(), "np-test-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("isValidShortName", () => {
  it("accepts letter-led lowercase names with digits and single hyphens", () => {
    for (const ok of ["cache", "mailing-lists", "i18n", "web3", "a", "a1b2"]) {
      expect(isValidShortName(ok), ok).toBe(true);
    }
  });

  it("rejects leading-digit, uppercase, underscores, and stray hyphens", () => {
    // Leading digits are the load-bearing rejection: they derive an illegal JS
    // identifier (`export function 2fa()`), which the whole tool exists to prevent.
    for (const bad of ["2fa", "3d", "123", "-x", "x-", "x--y", "", "A", "a_b", "a.b"]) {
      expect(isValidShortName(bad), bad).toBe(false);
    }
  });
});

describe("toIdentifier", () => {
  it("camelCases hyphen segments into a JS identifier", () => {
    expect(toIdentifier("mailing-lists")).toBe("mailingLists");
    expect(toIdentifier("a-b-c")).toBe("aBC");
    expect(toIdentifier("i18n")).toBe("i18n");
    expect(toIdentifier("cache")).toBe("cache");
  });
});

describe("createPackage", () => {
  it("scaffolds the correct publishable package.json shape", () => {
    const root = freshRoot();
    const { pkgDir, version } = createPackage({
      shortName: "demo",
      description: "A demo package.",
      root,
    });

    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    expect(pkg.name).toBe("@lesto/demo");
    expect(pkg.version).toBe(version);
    expect(version).toBe(currentLineVersion(join(REPO, "packages"))); // born at the line, not 0.0.0
    expect(pkg.license).toBe("MIT");
    expect(pkg.type).toBe("module");
    expect(pkg.private).toBeUndefined(); // publishable
    expect(pkg.files).toEqual(["src"]);
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.exports["."]).toEqual({ types: "./src/index.ts", import: "./src/index.ts" });
    expect(pkg.repository.directory).toBe("packages/demo");
  });

  it("copies the reference package's static config verbatim (drift-free)", () => {
    const root = freshRoot();
    const { pkgDir } = createPackage({ shortName: "demo", description: "d", root });
    for (const f of ["tsconfig.json", "vitest.config.ts"]) {
      expect(readFileSync(join(pkgDir, f), "utf8")).toBe(
        readFileSync(join(REPO, "packages", "queue", f), "utf8"),
      );
    }
  });

  it("emits a green stub: a covered module, its test, and a re-exporting index", () => {
    const root = freshRoot();
    const { pkgDir } = createPackage({ shortName: "mailing-widgets", description: "d", root });
    const stub = readFileSync(join(pkgDir, "src", "mailing-widgets.ts"), "utf8");
    const test = readFileSync(join(pkgDir, "test", "mailing-widgets.test.ts"), "utf8");
    const index = readFileSync(join(pkgDir, "src", "index.ts"), "utf8");
    expect(stub).toContain("export function mailingWidgets(): string");
    expect(test).toContain('import { mailingWidgets } from "../src/mailing-widgets"');
    expect(index).toContain('export { mailingWidgets } from "./mailing-widgets"');
  });

  it("rejects a leading-digit name (would emit an illegal identifier)", () => {
    expect(() => createPackage({ shortName: "2fa", root: freshRoot() })).toThrow(/must start with/);
  });

  it("rejects a name that derives a reserved JS identifier", () => {
    expect(() => createPackage({ shortName: "new", root: freshRoot() })).toThrow(/reserved/);
  });

  it("refuses to overwrite an existing package dir", () => {
    const root = freshRoot();
    createPackage({ shortName: "demo", description: "d", root });
    expect(() => createPackage({ shortName: "demo", description: "d", root })).toThrow(
      /already exists/,
    );
  });
});
