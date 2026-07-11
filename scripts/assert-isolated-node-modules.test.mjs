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
  isBounded,
  isExternalPeer,
  isLocalProtocolRange,
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

describe("assertPeerHonesty", () => {
  it("FAILS on an unbounded `>=` peer", () => {
    const problems = assertPeerHonesty({ name: "@lesto/pg", peerDependencies: { pg: ">=8" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/UNBOUNDED/);
  });
  it('FAILS on a SPACED unbounded peer (`pg: ">= 8"`) — the space must not smuggle it past', () => {
    const problems = assertPeerHonesty({ name: "@lesto/pg", peerDependencies: { pg: ">= 8" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/UNBOUNDED/);
  });
  it("FAILS on a bare `*` peer", () => {
    const problems = assertPeerHonesty({ name: "x", peerDependencies: { foo: "*" } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/UNBOUNDED/);
  });
  it("PASSES a bounded caret peer", () => {
    expect(
      assertPeerHonesty({ name: "@lesto/x", peerDependencies: { react: "^19" } }),
    ).toEqual([]);
  });
  it("PASSES a bounded peer even when it reaches past a would-be tested major (reach leg CUT)", () => {
    // Before the ADR-0045 CUT this FAILED (`^20` peer against a `^19` devDep). The reach-past-
    // tested-major leg was removed as unmandated speculative strictness; boundedness is the whole
    // honesty floor now, so a bounded `^20` PASSES regardless of any devDependency pin.
    const manifest = {
      name: "@lesto/x",
      peerDependencies: { react: "^20" },
      devDependencies: { react: "^19.0.0" },
    };
    expect(assertPeerHonesty(manifest)).toEqual([]);
  });
  it("PASSES any bounded peer (boundedness is the whole check)", () => {
    expect(assertPeerHonesty({ name: "x", peerDependencies: { foo: "^3" } })).toEqual([]);
    expect(assertPeerHonesty({ name: "x", peerDependencies: { foo: ">=18 <20" } })).toEqual([]);
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
  it("treats a WIDE `>=X <Y` comparator span as equivalent to its caret-union (L-f4ca9903)", () => {
    // `>=18 <20` and `^18 || ^19` advertise the SAME major set, [18, 19] — a comparator span must
    // enumerate its INTERIOR majors (18 AND 19), not just the lower bound, or these two equivalent
    // ranges report different major sets and trip a false lockstep mismatch. (Before the fix,
    // `advertisedMajors(">=18.0.0 <20.0.0")` returned only `[18]`, dropping the interior major 19.)
    expect(
      assertReactLockstep({
        name: "x",
        peerDependencies: { react: ">=18.0.0 <20.0.0", "react-dom": "^18.0.0 || ^19.0.0" },
      }),
    ).toEqual([]);
  });
  it("counts major Y for a `<Y.z` ceiling with a nonzero minor/patch (Y.0.0..Y.z−1 admits Y)", () => {
    // `<20.5.0` still admits all of 20.0.0..20.4.x, so major 20 IS advertised — the
    // ceiling is 20, not 19. Before the fix this returned [18, 19] and tripped a false
    // mismatch against the equivalent caret union — the exact bug class L-f4ca9903 fixed.
    expect(
      assertReactLockstep({
        name: "x",
        peerDependencies: {
          react: ">=18.0.0 <20.5.0",
          "react-dom": "^18.0.0 || ^19.0.0 || ^20.0.0",
        },
      }),
    ).toEqual([]);
  });
  it("does not crash on a pathologically wide (typo) `>=X <Y` span", () => {
    // A fat-fingered `<100000000` would enumerate ~10^8 majors into a Set — a
    // `RangeError: Set maximum size exceeded` (or hundreds of MB) that crashes the
    // check with a stack pointing nowhere near the real problem. The width cap keeps
    // it bounded; the range still mismatches its react-dom counterpart and is flagged.
    let problems;
    expect(() => {
      problems = assertReactLockstep({
        name: "x",
        peerDependencies: { react: ">=1.0.0 <100000000.0.0", "react-dom": "^18.0.0" },
      });
    }).not.toThrow();
    expect(problems).toHaveLength(1);
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
    // A root manifest + a clean package + a violating package (unbounded pg peer AND a
    // react/react-dom major split) + a malformed manifest.
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
    const problems = assertManifestHonesty({ repoRoot: repo });
    expect(problems.some((p) => /UNBOUNDED/.test(p))).toBe(true);
    expect(problems.some((p) => /react\/react-dom major mismatch/.test(p))).toBe(true);
    expect(problems.some((p) => /Could not parse .*broken\/package\.json/.test(p))).toBe(true);
  });

  it("reports an enumerate failure when git cannot list the tree", () => {
    const problems = assertManifestHonesty({
      repoRoot: join(tmpdir(), "definitely-not-a-git-repo-xyz"),
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
