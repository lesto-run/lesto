// Unit tests for the `release:cut` version-bump precondition (L-ccd2d722), graduated out of an
// inline `node -e` heredoc in `scripts/dev/release.sh` into `scripts/lib/preflight-versions.mjs`.
// That heredoc was the ONLY untested, un-typechecked, un-lint/format-checked, un-coverage-gated
// stretch of the release path — bespoke caret math + a fail-closed range guard next to helpers that
// ARE covered. This is the truth table that guards the extracted logic.
//
// NOTE: `scripts/` is NOT swept by the coverage gate (scripts/coverage-gate.ts covers only
// packages/* members with a `test:cov`), and the source lives at `scripts/lib/*.mjs` while its test
// lives here at `scripts/*.test.mjs` — the same split `pack-public.mjs`→`publish.test.mjs` and
// `build-public.mjs`→`build-public.test.mjs` use. Run directly (registered in ci.yml):
//   bunx vitest run scripts/preflight-versions.test.mjs
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertCaretRangeShape,
  buildPreflightSummary,
  caretSatisfies,
  extractDepRange,
  readPublishableNodes,
} from "./lib/preflight-versions.mjs";

describe("caretSatisfies (hand-rolled caret membership — no semver dep)", () => {
  // The truth table. Each row is [version, range, expected]. Covers all three caret-on-zero regimes
  // (X>0, ^0.Y.Z, ^0.0.Z), double-digit components, and the boundary just-below / just-at the ceiling.
  const table = [
    // ^0.Y.Z — the shape LESTO_DEP_RANGE actually uses (< 0.(Y+1).0).
    ["0.1.7", "^0.1.0", "satisfied"], // in-range patch
    ["0.1.0", "^0.1.0", "satisfied"], // exactly the floor
    ["0.1.99", "^0.1.0", "satisfied"], // double-digit patch, still < 0.2.0
    ["0.2.0", "^0.1.0", "unsatisfied"], // hits the ceiling exactly → excluded (< is strict)
    ["0.1.7", "^0.2.0", "unsatisfied"], // below the floor (0.1.7 < 0.2.0)
    ["0.0.9", "^0.1.0", "unsatisfied"], // below the floor, different minor
    // ^0.0.Z — every patch is its own compatibility line (< 0.0.(Z+1)).
    ["0.0.4", "^0.0.4", "satisfied"], // exact pin satisfied
    ["0.0.5", "^0.0.4", "unsatisfied"], // one patch up → out (0.0.x pins are exact)
    ["0.0.3", "^0.0.4", "unsatisfied"], // one patch down → below floor
    // ^X.Y.Z with X>0 — classic caret (< (X+1).0.0).
    ["1.0.0", "^1.0.0", "satisfied"], // floor
    ["1.9.9", "^1.0.0", "satisfied"], // anything < 2.0.0
    ["2.0.0", "^1.0.0", "unsatisfied"], // ceiling excluded
    ["10.0.0", "^2.0.0", "unsatisfied"], // double-digit major well past the 3.0.0 ceiling
    ["2.10.3", "^2.0.0", "satisfied"], // double-digit minor, still < 3.0.0
    // Prerelease VERSION → unknown (not a verdict): warn-not-fail, ships under `next`.
    ["0.2.0-rc.1", "^0.1.0", "unknown"],
    ["1.2.3-canary.0", "^1.0.0", "unknown"],
  ];

  it.each(table)("caretSatisfies(%s, %s) === %s", (version, range, expected) => {
    expect(caretSatisfies(version, range)).toBe(expected);
  });

  it("returns 'unknown' for a non-caret RANGE (this primitive alone cannot model it)", () => {
    // The fail-closed decision on an unverifiable range is the CALLER's (assertCaretRangeShape); this
    // pure primitive is deliberately non-committal. Covers the `!cm` half of the unknown branch.
    expect(caretSatisfies("0.1.7", "~0.1.0")).toBe("unknown");
    expect(caretSatisfies("0.1.7", ">=0.1.0")).toBe("unknown");
  });

  it("RED canary: a real satisfied case must NOT be 'unsatisfied'/'unknown'", () => {
    // If the caret math regressed (e.g. an off-by-one on the ceiling or a dropped geLow), the
    // canonical launch case would flip. This is the assertion that goes RED on such a break.
    expect(caretSatisfies("0.1.7", "^0.1.0")).toBe("satisfied");
    expect(caretSatisfies("0.1.7", "^0.1.0")).not.toBe("unsatisfied");
  });
});

describe("assertCaretRangeShape (fail closed on an unverifiable range)", () => {
  it("accepts a simple ^X.Y.Z caret", () => {
    expect(() => assertCaretRangeShape("^0.1.0")).not.toThrow();
    expect(() => assertCaretRangeShape("^10.20.30")).not.toThrow();
    expect(() => assertCaretRangeShape("  ^1.2.3  ")).not.toThrow(); // trimmed
  });

  // The whole point of the wrap-up fix (7a8d0e5): an unrecognized range shape must THROW, never
  // warn-and-proceed. Each of these would silently mis-resolve if waved through.
  it.each([
    ["~0.1.0", "tilde"],
    [">=0.1.0", "gte"],
    ["0.1.x", "x-range"],
    ["^0.1", "two-component caret"],
    ["^0.1.0 || ^0.2.0", "disjunction"],
    ["1.2.3", "bare version (no caret)"],
    ["^0.1.0-rc.1", "caret with prerelease"],
  ])("THROWS on %s (%s)", (range) => {
    expect(() => assertCaretRangeShape(range)).toThrow(/not a simple \^X\.Y\.Z caret/);
  });
});

describe("extractDepRange (grep LESTO_DEP_RANGE out of scaffold source text)", () => {
  it("finds the declaration in the real scaffold shape", () => {
    // Mirrors packages/create-lesto/src/scaffold.ts's actual line, with surrounding noise.
    const source = [
      "/** The published range a scaffolded app pins each `@lesto/*` dep at by default. */",
      'const LESTO_DEP_RANGE = "^0.1.0";',
      "export const publishedRangePin = () => LESTO_DEP_RANGE;",
    ].join("\n");
    expect(extractDepRange(source)).toBe("^0.1.0");
  });

  it("tolerates alternate spacing", () => {
    expect(extractDepRange('const    LESTO_DEP_RANGE="^2.3.4";')).toBe("^2.3.4");
  });

  it("THROWS (fail closed) when the constant is absent — renamed or moved", () => {
    // RED canary: if the regex were loosened to match nothing/anything, or the throw dropped, a
    // renamed constant would silently skip the entire scaffold-range check. Uses the default label.
    expect(() => extractDepRange("const SOMETHING_ELSE = \"^0.1.0\";")).toThrow(
      /could not find LESTO_DEP_RANGE in packages\/create-lesto\/src\/scaffold\.ts/,
    );
  });

  it("names a caller-supplied path in the not-found error", () => {
    expect(() => extractDepRange("nope", "/abs/scaffold.ts")).toThrow(/in \/abs\/scaffold\.ts/);
  });

  it("ignores a commented-out decoy above the real declaration (no fail-open)", () => {
    // RED canary for the comment-blind first-match hazard: an unanchored regex returns the FIRST
    // `LESTO_DEP_RANGE = "..."` it sees, so a stale decoy in a comment ABOVE the real line would be
    // validated instead of the real pin — silently passing while the pin is stale. The anchored
    // regex must skip the `//` line and return the REAL range.
    const source = [
      '// const LESTO_DEP_RANGE = "^0.2.0"; // OLD — do not use',
      'const LESTO_DEP_RANGE = "^0.1.0";',
    ].join("\n");
    expect(extractDepRange(source)).toBe("^0.1.0");
  });

  it("matches an `export const` declaration too", () => {
    expect(extractDepRange('export const LESTO_DEP_RANGE = "^0.1.0";')).toBe("^0.1.0");
  });
});

describe("buildPreflightSummary (the whole precondition, composed + fail-closed)", () => {
  it("returns the exact summary line for the launch surface (49 pkgs @ 0.1.7, ^0.1.0)", () => {
    const nodes = Array.from({ length: 49 }, (_, i) => ({ name: `@lesto/p${i}`, version: "0.1.7" }));
    expect(buildPreflightSummary({ nodes, depRange: "^0.1.0" })).toBe(
      '49 publishable packages @ 0.1.7 (scaffold LESTO_DEP_RANGE "^0.1.0" satisfies the surface)',
    );
  });

  it("THROWS when the range does NOT satisfy the surface (the stale-pin hole)", () => {
    // ^0.1.0 pinned while the surface moved to 0.2.0 — the exact regression this precondition exists
    // to catch. RED canary: drop the unsatisfied throw and this passes vacuously.
    expect(() =>
      buildPreflightSummary({
        nodes: [{ name: "@lesto/a", version: "0.2.0" }],
        depRange: "^0.1.0",
      }),
    ).toThrow(/does NOT satisfy release version\(s\) 0\.2\.0/);
  });

  it("THROWS (fail closed) on an un-bumped 0.0.0 package (reuses assertVersionsBumped)", () => {
    expect(() =>
      buildPreflightSummary({
        nodes: [{ name: "@lesto/a", version: "0.0.0" }],
        depRange: "^0.1.0",
      }),
    ).toThrow(/0\.0\.0/);
  });

  it("THROWS (fail closed) on an unverifiable range shape (delegates to assertCaretRangeShape)", () => {
    expect(() =>
      buildPreflightSummary({ nodes: [{ name: "@lesto/a", version: "0.1.7" }], depRange: "~0.1.0" }),
    ).toThrow(/not a simple \^X\.Y\.Z caret/);
  });

  it("WARNS (not fails) on a prerelease VERSION — ships under `next`, caret from `latest` skips it", () => {
    // Asymmetry preserved: an unverifiable RANGE fails closed, but a prerelease VERSION only warns in
    // the summary note (unknown → EYEBALL), because a `latest` caret never pulls a `next` prerelease.
    const summary = buildPreflightSummary({
      nodes: [{ name: "@lesto/a", version: "0.2.0-rc.1" }],
      depRange: "^0.1.0",
    });
    expect(summary).toContain("prerelease version(s) present");
    expect(summary).toContain("EYEBALL");
    expect(summary).toBe(
      '1 publishable packages @ 0.2.0-rc.1 (scaffold LESTO_DEP_RANGE "^0.1.0" set, but prerelease version(s) present -- not caret-checkable, EYEBALL)',
    );
  });

  it("dedups + sorts distinct versions in the summary line", () => {
    const summary = buildPreflightSummary({
      nodes: [
        { name: "@lesto/a", version: "0.1.7" },
        { name: "@lesto/b", version: "0.1.7" },
        { name: "@lesto/c", version: "0.1.2" },
      ],
      depRange: "^0.1.0",
    });
    // Two distinct versions, sorted; nodes.length (3) is the package count, not the version count.
    expect(summary).toBe(
      '3 publishable packages @ 0.1.2, 0.1.7 (scaffold LESTO_DEP_RANGE "^0.1.0" satisfies the surface)',
    );
  });
});

// The one fs-touching export — readdir + read each manifest's name/version, no subprocess — so, like
// its sibling `readPublicPackageDirs` (tested the same way in scripts/publish.test.mjs), it is
// cheaply unit-testable against a hermetic temp dir rather than the live packages/ tree.
describe("readPublishableNodes (fs mapping — hermetic temp dir)", () => {
  let dir;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lesto-preflight-nodes-"));
    // Two public packages — both included, mapped to { name, version }.
    mkdirSync(join(dir, "alpha"));
    writeFileSync(
      join(dir, "alpha", "package.json"),
      JSON.stringify({ name: "@lesto/alpha", version: "0.1.7" }),
    );
    mkdirSync(join(dir, "bravo"));
    writeFileSync(
      join(dir, "bravo", "package.json"),
      JSON.stringify({ name: "@lesto/bravo", version: "0.1.7" }),
    );
    // A `private: true` package — EXCLUDED by the shared `readPublicPackageDirs` filter.
    mkdirSync(join(dir, "charlie"));
    writeFileSync(
      join(dir, "charlie", "package.json"),
      JSON.stringify({ name: "@lesto/charlie", version: "9.9.9", private: true }),
    );
  });

  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort — a sandbox may block deletion; the temp dir is ephemeral anyway.
    }
  });

  it("maps each public package dir to its { name, version }, excluding private", () => {
    const nodes = readPublishableNodes(dir);
    expect(nodes).toContainEqual({ name: "@lesto/alpha", version: "0.1.7" });
    expect(nodes).toContainEqual({ name: "@lesto/bravo", version: "0.1.7" });
    // RED canary: the private package must never reach the publish set.
    expect(nodes.map((n) => n.name)).not.toContain("@lesto/charlie");
    // Feeds straight into the summary composer — proving the two compose end to end off real fs.
    const depRange = extractDepRange('const LESTO_DEP_RANGE = "^0.1.0";');
    expect(buildPreflightSummary({ nodes, depRange })).toBe(
      '2 publishable packages @ 0.1.7 (scaffold LESTO_DEP_RANGE "^0.1.0" satisfies the surface)',
    );
  });
});
