// Unit tests for the manifest-honesty + react/react-dom lockstep logic graduated into the
// ADR-0045 drift guard. The check logic is exported as pure functions from the guard; the CLI at
// the bottom of the script is a thin driver. We test the pure functions directly, drive the
// aggregator against a throwaway git repo, and boot the real CLI as a subprocess to cover main().
//
// NOTE (wiring gap): `scripts/` is NOT in the coverage gate — scripts/coverage-gate.ts sweeps only
// packages/* members that declare a `test:cov` script, and `scripts/` is not a workspace package.
// So this file does not run in CI's coverage gate; run it directly:
//   bunx vitest run scripts/assert-isolated-node-modules.test.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertManifestHonesty,
  assertPeerHonesty,
  assertReactLockstep,
  firstMajor,
  isBounded,
  isExternalPeer,
  isLocalProtocolRange,
  simpleMaxMajor,
  testedMajor,
} from "./assert-isolated-node-modules.mjs";

describe("isLocalProtocolRange", () => {
  it("flags workspace / file / link / catalog / npm protocol ranges", () => {
    for (const r of ["workspace:*", "file:../x", "link:../y", "catalog:", "npm:pg@8", "portal:z"]) {
      expect(isLocalProtocolRange(r)).toBe(true);
    }
  });
  it("does not flag a plain semver range", () => {
    expect(isLocalProtocolRange("^8")).toBe(false);
    expect(isLocalProtocolRange(" >=8 ")).toBe(false);
  });
});

describe("isExternalPeer", () => {
  it("is external for a third-party semver peer", () => {
    expect(isExternalPeer("react", "^19")).toBe(true);
    expect(isExternalPeer("pg", ">=8")).toBe(true);
  });
  it("is NOT external for @lesto siblings or workspace-protocol peers", () => {
    expect(isExternalPeer("@lesto/db", "workspace:*")).toBe(false);
    expect(isExternalPeer("some-dep", "workspace:*")).toBe(false);
  });
});

describe("simpleMaxMajor", () => {
  it("returns the highest major across a simple union", () => {
    expect(simpleMaxMajor("^18.0.0 || ^19.0.0")).toBe(19);
    expect(simpleMaxMajor("^5.0.0 || ^6.0.0 || ^7.0.0")).toBe(7);
    expect(simpleMaxMajor("^6")).toBe(6);
    expect(simpleMaxMajor("3.46.1-build5")).toBe(3);
    expect(simpleMaxMajor("4.3.1")).toBe(4);
  });
  it("bails out (null) on comparator ranges and wildcards", () => {
    expect(simpleMaxMajor(">=8")).toBe(null);
    expect(simpleMaxMajor("*")).toBe(null);
    expect(simpleMaxMajor("x")).toBe(null);
  });
  it("returns null when no numeric major is present", () => {
    expect(simpleMaxMajor("latest")).toBe(null);
  });
});

describe("firstMajor", () => {
  it("extracts the first major from an unbounded range", () => {
    expect(firstMajor(">=8")).toBe(8);
    expect(firstMajor("^19.2.3")).toBe(19);
  });
  it("returns null with no digits", () => {
    expect(firstMajor("latest")).toBe(null);
  });
});

describe("isBounded", () => {
  it("treats caret / tilde / exact / x-range / union as bounded", () => {
    for (const r of [
      "^8",
      "~4.1",
      "4.3.1",
      "1.x",
      "^18.0.0 || ^19.0.0",
      ">=18.0.0 <20.0.0",
      "<9",
    ]) {
      expect(isBounded(r)).toBe(true);
    }
  });
  it("treats open-ended ranges as unbounded", () => {
    for (const r of [">=8", ">8", "*", "x", "X", "", "^18 || >=19"]) {
      expect(isBounded(r)).toBe(false);
    }
  });
  it("is not fooled by a SPACED comparator (npm honors `>= 8` as the unbounded `>=8.0.0`)", () => {
    for (const r of [">= 8", "> 8", "^18 || >= 19"]) {
      expect(isBounded(r)).toBe(false);
    }
    // a spaced but genuinely bounded pair stays bounded
    expect(isBounded(">= 18 < 20")).toBe(true);
  });
});

describe("testedMajor", () => {
  it("prefers the package's own devDependency", () => {
    expect(testedMajor({ devDependencies: { react: "^19.2.3" } }, "react")).toBe(19);
  });
  it("falls back to CI pins when the own devDep is a workspace protocol", () => {
    expect(testedMajor({ devDependencies: { pg: "workspace:*" } }, "pg", { pg: "^8" })).toBe(8);
  });
  it("falls back to CI pins when there is no own devDep", () => {
    expect(testedMajor({}, "pg", { pg: "8.22.0" })).toBe(8);
  });
  it("returns null when neither is known", () => {
    expect(testedMajor({}, "pg")).toBe(null);
    expect(testedMajor({ devDependencies: { pg: "latest" } }, "pg", { pg: "latest" })).toBe(null);
  });
});

describe("assertPeerHonesty", () => {
  it("FAILS on an unbounded `>=` peer and suggests the tested-major caret", () => {
    const problems = assertPeerHonesty({ name: "@lesto/pg", peerDependencies: { pg: ">=8" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/UNBOUNDED/);
    expect(problems[0]).toContain('"^8"');
  });
  it('FAILS on a SPACED unbounded peer (`pg: ">= 8"`) — the space must not smuggle it past', () => {
    const problems = assertPeerHonesty({ name: "@lesto/pg", peerDependencies: { pg: ">= 8" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/UNBOUNDED/);
  });
  it("FAILS on a bare `*` peer with no derivable major (no suggestion)", () => {
    const problems = assertPeerHonesty({ name: "x", peerDependencies: { foo: "*" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/UNBOUNDED/);
    expect(problems[0]).not.toContain("narrow to");
  });
  it("PASSES a caret peer matching the tested major", () => {
    const manifest = {
      name: "@lesto/x",
      peerDependencies: { react: "^19" },
      devDependencies: { react: "^19.0.0" },
    };
    expect(assertPeerHonesty(manifest)).toEqual([]);
  });
  it("FAILS a bounded peer that reaches PAST the tested major", () => {
    const manifest = {
      name: "@lesto/x",
      peerDependencies: { react: "^20" },
      devDependencies: { react: "^19.0.0" },
    };
    const problems = assertPeerHonesty(manifest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/reaches\s+major 20/);
    expect(problems[0]).toMatch(/only major 19 is tested/);
  });
  it("PASSES a bounded peer when the tested major is unknowable (bounded is enough)", () => {
    expect(assertPeerHonesty({ name: "x", peerDependencies: { foo: "^3" } })).toEqual([]);
  });
  it("SKIPS @lesto workspace peers and packages with no peers", () => {
    expect(
      assertPeerHonesty({ name: "x", peerDependencies: { "@lesto/db": "workspace:*" } }),
    ).toEqual([]);
    expect(assertPeerHonesty({ name: "x" })).toEqual([]);
  });
});

describe("assertReactLockstep", () => {
  it("FAILS when react and react-dom split majors in a section", () => {
    const problems = assertReactLockstep({
      name: "@lesto/x",
      devDependencies: { react: "^18.0.0", "react-dom": "^19.0.0" },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/react\/react-dom major mismatch/);
  });
  it("PASSES when the pair shares a major (incl. identical unions)", () => {
    expect(
      assertReactLockstep({ name: "x", devDependencies: { react: "^19", "react-dom": "^19.0.0" } }),
    ).toEqual([]);
    expect(
      assertReactLockstep({
        name: "x",
        peerDependencies: { react: "^18.0.0 || ^19.0.0", "react-dom": "^18.0.0 || ^19.0.0" },
      }),
    ).toEqual([]);
    // a `<Y` ceiling is not an advertised major: `>=18 <19` is major-18-only, equal to `^18`
    expect(
      assertReactLockstep({
        name: "x",
        peerDependencies: { react: ">=18.0.0 <19.0.0", "react-dom": "^18.0.0" },
      }),
    ).toEqual([]);
  });
  it("SKIPS sections that declare only one of the pair, or a workspace protocol", () => {
    expect(assertReactLockstep({ name: "x", peerDependencies: { react: "^19" } })).toEqual([]);
    expect(
      assertReactLockstep({
        peerDependencies: { react: "workspace:*", "react-dom": "^19" },
      }),
    ).toEqual([]);
    expect(assertReactLockstep({})).toEqual([]);
  });
});

describe("assertManifestHonesty (aggregator over a git tree)", () => {
  let repo;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "manifest-honesty-"));
    execFileSync("git", ["init", "-q"], { cwd: repo });
    // A root manifest that supplies the CI-pin fallback + a clean package + a violating package
    // (unbounded pg peer AND a react/react-dom major split) + a malformed manifest.
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "root" }));
    mkdirSync(join(repo, "packages/clean"), { recursive: true });
    writeFileSync(
      join(repo, "packages/clean/package.json"),
      JSON.stringify({ name: "@lesto/clean", peerDependencies: { react: "^19" } }),
    );
    mkdirSync(join(repo, "packages/bad"), { recursive: true });
    writeFileSync(
      join(repo, "packages/bad/package.json"),
      JSON.stringify({
        name: "@lesto/bad",
        peerDependencies: { pg: ">=8" },
        devDependencies: { react: "^18.0.0", "react-dom": "^19.0.0" },
      }),
    );
    mkdirSync(join(repo, "packages/broken"), { recursive: true });
    writeFileSync(join(repo, "packages/broken/package.json"), "{ not json");
    execFileSync("git", ["add", "-A"], { cwd: repo });
  });
  afterAll(() => {
    // Leave the tmp dir; sandbox blocks rm and the OS reaps tmpdir. No teardown needed.
  });

  it("collects unbounded-peer, react-split, and parse-error problems across the tree", () => {
    const problems = assertManifestHonesty({ repoRoot: repo, fallbackPins: {} });
    expect(problems.some((p) => /UNBOUNDED/.test(p))).toBe(true);
    expect(problems.some((p) => /react\/react-dom major mismatch/.test(p))).toBe(true);
    expect(problems.some((p) => /Could not parse .*broken\/package\.json/.test(p))).toBe(true);
  });

  it("reports an enumerate failure when git cannot list the tree", () => {
    const problems = assertManifestHonesty({
      repoRoot: join(tmpdir(), "definitely-not-a-git-repo-xyz"),
      fallbackPins: {},
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Could not enumerate/);
  });
});

describe("CLI entrypoint (real tree)", () => {
  it("exits 0 with the ok banner on the current repo", () => {
    const repoRoot = fileURLToPath(new URL("..", import.meta.url));
    const out = execFileSync("bun", ["scripts/assert-isolated-node-modules.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(out).toMatch(/assert-isolated-node-modules: ok/);
  });
});
