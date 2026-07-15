// Unit tests for the fixed-group lockstep PHANTOM-MAJOR regression gate (L-9eafaaaf / ADR 0047).
// Source lives at `scripts/lib/assert-no-phantom-major.mjs`; this test lives here at
// `scripts/*.test.mjs` — the same split `preflight-versions.mjs`→`preflight-versions.test.mjs` uses.
//
// `scripts/` is OUTSIDE the coverage/typecheck/lint gates, so THIS test — registered in ci.yml's
// `test:scripts-unit` step — is the actual always-on guard against a future revert of the config key
// or any intra-group peer range. Run directly:
//   bunx vitest run scripts/assert-no-phantom-major.test.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertNoPhantomMajor,
  findPhantomMajorRisks,
  isSafeLockstepPeerRange,
  readWorkspaceManifests,
} from "./lib/assert-no-phantom-major.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// A config with the ADR-0047 key set — reused by the pure-function cases.
const CONFIG_OK = {
  ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: { onlyUpdatePeerDependentsWhenOutOfRange: true },
};

describe("isSafeLockstepPeerRange — only an open >= floor survives an 0.x lockstep minor", () => {
  // The truth table. SAFE = the incremented peer version still satisfies the (workspace-stripped) range;
  // UNSAFE = it leaves range and re-arms the shouldBumpMajor cascade (see ADR 0047 §Context).
  const table = [
    [">=0.1.0", true],
    ["workspace:>=0.1.0", true],
    ["  workspace:>=0.1.0  ", true],
    [">=0.0.0", true],
    [">=10.20.30", true],
    ["workspace:*", false],
    ["workspace:^", false],
    ["workspace:~", false],
    ["^0.1.7", false],
    ["~0.1.7", false],
    ["0.2.0", false],
    ["*", false],
    [">=0.1", false], // must be a full X.Y.Z floor
    [">0.1.0", false], // strict-greater, not a floor
  ];
  for (const [range, expected] of table) {
    it(`(${JSON.stringify(range)}) -> ${expected}`, () => {
      expect(isSafeLockstepPeerRange(range)).toBe(expected);
    });
  }
});

describe("findPhantomMajorRisks", () => {
  const manifests = [
    { name: "@lesto/mail" },
    { name: "@lesto/identity", peerDependencies: { "@lesto/mail": "workspace:>=0.1.0", react: "^19" } },
  ];

  it("passes when the config key is set and every intra-group range is an open floor", () => {
    expect(findPhantomMajorRisks({ config: CONFIG_OK, manifests })).toEqual([]);
  });

  it("RED canary: flags a workspace:* intra-group edge (the exact 1.0.0 regression)", () => {
    // This is the state the repo was in when the bug shipped. The check MUST fire, proving it is not a
    // vacuous assertion (see the vacuous-negative-assertion trap this repo has been bitten by).
    const bad = [
      { name: "@lesto/mail" },
      { name: "@lesto/identity", peerDependencies: { "@lesto/mail": "workspace:*" } },
    ];
    const problems = findPhantomMajorRisks({ config: CONFIG_OK, manifests: bad });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/@lesto\/identity.*@lesto\/mail.*phantom MAJOR/s);
  });

  it("flags a missing / false onlyUpdatePeerDependentsWhenOutOfRange", () => {
    expect(findPhantomMajorRisks({ config: {}, manifests })).toEqual([
      expect.stringMatching(/onlyUpdatePeerDependentsWhenOutOfRange = true/),
    ]);
    expect(
      findPhantomMajorRisks({
        config: { ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: { onlyUpdatePeerDependentsWhenOutOfRange: false } },
        manifests,
      }),
    ).toHaveLength(1);
  });

  it("reports BOTH a config miss and a bad range together", () => {
    const bad = [{ name: "@lesto/mail" }, { name: "@lesto/x", peerDependencies: { "@lesto/mail": "workspace:*" } }];
    expect(findPhantomMajorRisks({ config: {}, manifests: bad })).toHaveLength(2);
  });

  it("ignores EXTERNAL peers (react/zod/pg) — never released, cannot cascade", () => {
    const external = [{ name: "@lesto/x", peerDependencies: { react: "^19", pg: ">=8", zod: "^4.0.0" } }];
    expect(findPhantomMajorRisks({ config: CONFIG_OK, manifests: external })).toEqual([]);
  });
});

describe("the REAL repo must satisfy the invariant (the always-on release guard)", () => {
  const config = JSON.parse(readFileSync(join(REPO, ".changeset/config.json"), "utf8"));
  const manifests = readWorkspaceManifests(join(REPO, "packages"));

  it("actually exercises the on-disk intra-workspace peer edges (guards against a vacuous pass)", () => {
    // If this were 0, the not.toThrow() below would pass for the wrong reason. The surface HAS
    // intra-group optional-peer edges (identity->mail, mcp/cli->content-*, …); assert we see them.
    const workspaceNames = new Set(manifests.map((m) => m.name));
    const intraGroupEdges = manifests.flatMap((m) =>
      Object.keys(m.peerDependencies ?? {}).filter((peer) => workspaceNames.has(peer)),
    );
    expect(intraGroupEdges.length).toBeGreaterThanOrEqual(8);
  });

  it("does not throw against the committed config + manifests", () => {
    expect(() => assertNoPhantomMajor({ config, manifests })).not.toThrow();
  });
});
