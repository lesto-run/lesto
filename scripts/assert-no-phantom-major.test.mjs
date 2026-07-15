// Unit tests for the fixed-group lockstep PHANTOM-MAJOR regression gate (L-9eafaaaf / ADR 0047).
// Source lives at `scripts/lib/assert-no-phantom-major.mjs`; this test lives here at
// `scripts/*.test.mjs` — the same split `preflight-versions.mjs`→`preflight-versions.test.mjs` uses.
//
// `scripts/` is OUTSIDE the coverage/typecheck/lint gates, so THIS test — registered in ci.yml's
// `test:scripts-unit` step — is the actual always-on guard. It has TWO layers:
//   1. STATIC — pure unit tests of the diagnostic (`findPhantomMajorRisks` + its predicates).
//   2. BEHAVIORAL — the AUTHORITATIVE sufficiency proof: load the real workspace via
//      `@manypkg/get-packages`, inject a synthetic MINOR changeset, run the real `assembleReleasePlan`,
//      assert zero major bumps. Immune to a regex gap; covers the full workspace set; fails closed on a
//      changesets major upgrade.
//   bunx vitest run scripts/assert-no-phantom-major.test.mjs
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assertNoPhantomMajor,
  findPhantomMajorRisks,
  floorAdmitsVersion,
  isOpenLowerBoundFloor,
  isSafeLockstepPeerRange,
  readWorkspaceManifests,
} from "./lib/assert-no-phantom-major.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// A config with the ADR-0047 key set — reused by the pure-function cases.
const CONFIG_OK = {
  ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH: { onlyUpdatePeerDependentsWhenOutOfRange: true },
};

describe("isOpenLowerBoundFloor — the SYNTACTIC half (is it an open >= floor?)", () => {
  const table = [
    [">=0.1.0", true],
    ["workspace:>=0.1.0", true],
    ["  workspace:>=0.1.0  ", true],
    [">=0.0.0", true],
    [">=10.20.30", true], // syntactically a floor — semantic safety is floorAdmitsVersion's job
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
      expect(isOpenLowerBoundFloor(range)).toBe(expected);
    });
  }
});

describe("floorAdmitsVersion — the SEMANTIC half (is the floor at or below the current version?)", () => {
  const table = [
    // range, current version, expected
    [">=0.1.0", "0.2.0", true], // floor below current -> current + all higher stay in range
    [">=0.2.0", "0.2.0", true], // floor == current -> still admits current and up
    [">=0.5.0", "0.2.0", false], // floor ABOVE current -> next bump (0.3.0) is below it = OUT of range
    [">=10.20.30", "0.2.0", false], // the exact fail-open both reviewers caught
    ["workspace:>=0.1.0", "0.2.0", true],
    [">=1.0.0", "1.2.0", true],
    [">=1.3.0", "1.2.0", false],
    ["^0.1.0", "0.2.0", false], // not a floor at all -> false (fail-closed)
    [">=0.1.0", "not-a-version", false], // unparseable version -> false (fail-closed)
  ];
  for (const [range, version, expected] of table) {
    it(`(${JSON.stringify(range)} @ ${version}) -> ${expected}`, () => {
      expect(floorAdmitsVersion(range, version)).toBe(expected);
    });
  }
});

describe("isSafeLockstepPeerRange — both halves combined", () => {
  it("safe only when it is an open floor AND that floor is <= the current version", () => {
    expect(isSafeLockstepPeerRange(">=0.1.0", "0.2.0")).toBe(true);
    expect(isSafeLockstepPeerRange("workspace:>=0.1.0", "0.2.0")).toBe(true);
    expect(isSafeLockstepPeerRange(">=0.5.0", "0.2.0")).toBe(false); // floor above current — the fail-open
    expect(isSafeLockstepPeerRange("workspace:*", "0.2.0")).toBe(false);
    expect(isSafeLockstepPeerRange("^0.1.7", "0.2.0")).toBe(false);
  });
});

describe("findPhantomMajorRisks", () => {
  const manifests = [
    { name: "@lesto/mail", version: "0.2.0" },
    {
      name: "@lesto/identity",
      version: "0.2.0",
      peerDependencies: { "@lesto/mail": "workspace:>=0.1.0", react: "^19" },
    },
  ];

  it("passes when the config key is set and every intra-group range is a satisfied open floor", () => {
    expect(findPhantomMajorRisks({ config: CONFIG_OK, manifests })).toEqual([]);
  });

  it("RED canary: flags a workspace:* intra-group edge (the exact 1.0.0 regression)", () => {
    // This is the state the repo was in when the bug shipped. The check MUST fire, proving it is not a
    // vacuous assertion (see the vacuous-negative-assertion trap this repo has been bitten by).
    const bad = [
      { name: "@lesto/mail", version: "0.2.0" },
      { name: "@lesto/identity", version: "0.2.0", peerDependencies: { "@lesto/mail": "workspace:*" } },
    ];
    const problems = findPhantomMajorRisks({ config: CONFIG_OK, manifests: bad });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/@lesto\/identity.*@lesto\/mail.*phantom MAJOR/s);
  });

  it("RED canary #2: flags a >= floor ABOVE the peer's current version (the reviewer fail-open)", () => {
    const bad = [
      { name: "@lesto/mail", version: "0.2.0" },
      { name: "@lesto/identity", version: "0.2.0", peerDependencies: { "@lesto/mail": "workspace:>=0.5.0" } },
    ];
    const problems = findPhantomMajorRisks({ config: CONFIG_OK, manifests: bad });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/peer is at 0\.2\.0/);
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
    const bad = [
      { name: "@lesto/mail", version: "0.2.0" },
      { name: "@lesto/x", version: "0.2.0", peerDependencies: { "@lesto/mail": "workspace:*" } },
    ];
    expect(findPhantomMajorRisks({ config: {}, manifests: bad })).toHaveLength(2);
  });

  it("ignores EXTERNAL peers (react/zod/pg) — never released, cannot cascade", () => {
    const external = [{ name: "@lesto/x", version: "0.2.0", peerDependencies: { react: "^19", pg: ">=8", zod: "^4.0.0" } }];
    expect(findPhantomMajorRisks({ config: CONFIG_OK, manifests: external })).toEqual([]);
  });
});

describe("STATIC: the real packages/ set must satisfy the invariant (fast diagnostic layer)", () => {
  const config = JSON.parse(readFileSync(join(REPO, ".changeset/config.json"), "utf8"));
  const manifests = readWorkspaceManifests(join(REPO, "packages"));

  it("actually exercises the on-disk intra-workspace peer edges (guards against a vacuous pass)", () => {
    // If this were 0, the not.toThrow() below would pass for the wrong reason.
    const names = new Set(manifests.map((m) => m.name));
    const intraGroupEdges = manifests.flatMap((m) =>
      Object.keys(m.peerDependencies ?? {}).filter((peer) => names.has(peer)),
    );
    expect(intraGroupEdges.length).toBeGreaterThanOrEqual(8);
  });

  it("does not throw against the committed config + manifests", () => {
    expect(() => assertNoPhantomMajor({ config, manifests })).not.toThrow();
  });
});

describe("BEHAVIORAL: the real assembleReleasePlan must compute a MINOR, not a phantom major", () => {
  // Resolve the pinned changesets internals from the isolated `.bun` layout (bare specifiers do NOT
  // resolve here — the root node_modules is isolated per ADR 0045). Version-agnostic within a major:
  // glob the installed dir so a patch/minor changesets bump doesn't break the path, but ASSERT the
  // major so a changesets MAJOR upgrade fails closed (it would move `shouldBumpMajor` out from under
  // the sufficiency proof — see ADR 0047 residual risk).
  function resolveBun(pkgPrefix, innerName) {
    const bun = join(REPO, "node_modules/.bun");
    const dir = readdirSync(bun).find((d) => d.startsWith(`${pkgPrefix}@`));
    if (!dir) throw new Error(`not installed under .bun: ${pkgPrefix}`);
    return { path: join(bun, dir, "node_modules", innerName), version: dir.slice(dir.lastIndexOf("@") + 1) };
  }

  it("pins @changesets/assemble-release-plan at major 6 (fail closed on a major upgrade)", () => {
    const { version } = resolveBun("@changesets+assemble-release-plan", "@changesets/assemble-release-plan");
    expect(version.split(".")[0]).toBe("6");
  });

  it("a synthetic single MINOR changeset produces zero major bumps across the WHOLE fixed group", async () => {
    const arp = resolveBun("@changesets+assemble-release-plan", "@changesets/assemble-release-plan");
    const cfg = resolveBun("@changesets+config", "@changesets/config");
    const mp = resolveBun("@manypkg+get-packages", "@manypkg/get-packages");
    const assembleReleasePlan = (await import(`${arp.path}/dist/changesets-assemble-release-plan.esm.js`)).default;
    const { read } = await import(`${cfg.path}/dist/changesets-config.esm.js`);
    const { getPackages } = await import(`${mp.path}/dist/get-packages.cjs.js`);

    const packages = await getPackages(REPO); // FULL workspace set: packages/ + site/ + www/ + examples/*
    const config = await read(REPO, packages);
    const plan = assembleReleasePlan(
      [{ id: "probe-minor", summary: "probe", releases: [{ name: "@lesto/db", type: "minor" }] }],
      packages,
      config,
      undefined,
      undefined,
    );
    const bumped = plan.releases.filter((r) => r.type !== "none");
    const majors = bumped.filter(
      (r) => Number(r.newVersion.split(".")[0]) > Number(r.oldVersion.split(".")[0]),
    );
    // Non-vacuous: a minor changeset over a fixed group MUST bump the whole group.
    expect(bumped.length).toBeGreaterThanOrEqual(49);
    expect(majors).toEqual([]);
  });
});
