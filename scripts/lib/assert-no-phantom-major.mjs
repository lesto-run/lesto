// Committed regression gate for the fixed-group lockstep PHANTOM-MAJOR bug (L-9eafaaaf / ADR 0047).
//
// THE BUG. The 49-package `@lesto/*` + `create-lesto` surface releases as a changesets FIXED lockstep
// group (`.changeset/config.json` `fixed`). `changeset version` computed a spurious MAJOR for the
// WHOLE group on a release carrying only MINOR changesets (0.2.0 was intended; it computed 1.0.0, and
// the next minor would compute 2.0.0). Root cause, traced into @changesets/assemble-release-plan@6.0.10:
// `shouldBumpMajor` forces a `peerDependencies` dependent to MAJOR whenever its peer is bumped minor+
// AND (onlyUpdatePeerDependentsWhenOutOfRange===false [the default → ALWAYS], OR the incremented peer
// version leaves the dependent's declared range). Intra-group OPTIONAL peer edges carried `workspace:*`,
// which changesets rewrites to the EXACT old version — always left on a minor. Each forced major
// re-propagates through the fixed group → the whole surface → a phantom major.
//
// THE FIX (ADR 0047). Two jointly-necessary, jointly-SUFFICIENT conditions for changesets 6.x:
//   1. `.changeset/config.json` sets onlyUpdatePeerDependentsWhenOutOfRange = true (range-gate the rule).
//   2. every INTRA-WORKSPACE peer range is an open `>=X.Y.Z` floor (or `workspace:>=X.Y.Z`) whose floor
//      is AT OR BELOW the peer's current version — the only shape that stays satisfied across a lockstep
//      bump (`^`/`~`/`*`/exact all leave range at 0.x; a floor ABOVE current, e.g. `>=0.5.0` at 0.2.0,
//      also leaves range on the next bump).
// Sufficiency: a peer edge is the ONLY source of a spurious `major` in `determineDependents` (the sole
// `type="major"` assignment sits inside `if (shouldBumpMajor(...))`; every other branch yields
// patch/none, and the fixed-group matcher only PROPAGATES the highest existing type). With (1)+(2),
// `shouldBumpMajor` returns false for every intra-group edge, so no phantom major can originate.
//
// TWO LAYERS (both live in `scripts/assert-no-phantom-major.test.mjs`, ci.yml `test:scripts-unit`):
//   - STATIC (this file): fast, pure, precise diagnostic — flags the exact bad edge + how to fix it,
//     over the publishable `packages/` set. Checks both halves: an open `>=` floor AND that the floor
//     is at or below the peer's current version (a floor ABOVE current, e.g. `>=0.5.0` at 0.2.0, is
//     syntactically a floor but still leaves range — the fail-open both wrap-up reviewers caught).
//   - BEHAVIORAL (the test file): loads the FULL workspace set via `@manypkg/get-packages`, injects a
//     synthetic MINOR changeset, runs the REAL `assembleReleasePlan`, and asserts zero major bumps. This
//     is the authoritative SUFFICIENCY proof — immune to a regex gap, covers `site/`/`www/`/`examples/`,
//     and FAILS CLOSED if a changesets MAJOR upgrade renames/ignores the config option (it also pins the
//     installed major at 6.x). The static layer alone is necessary-not-sufficient; the behavioral layer
//     is the real gate.
//
// WHY THIS FILE IS A GUARD AT ALL. `scripts/` is deliberately OUTSIDE the oxlint/oxfmt/typecheck/100%-
// coverage gates (they scan `packages/` + `@lesto/*` only), so the ONLY guard on this release-critical
// logic is that unit test. Every export except `readWorkspaceManifests` is PURE (plain data in, no
// fs/network), mirroring `scripts/lib/preflight-versions.mjs`. Do NOT assume the coverage/typecheck gate
// has your back when editing here — extend the test.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * True iff `range` is SYNTACTICALLY an open `>=X.Y.Z` lower-bound floor (a NECESSARY condition for a
 * fixed-group peer edge — the only shape that CAN stay in-range across a lockstep bump). Strips an
 * optional `workspace:` prefix (changesets strips it before range-testing and keeps a valid `>=` range
 * verbatim; bun accepts both `workspace:>=x.y.z` and the bare literal, and both publish as the bare
 * floor). `workspace:*`/`^`/`~`, caret, tilde, and an exact pin are all rejected — each leaves range on
 * an 0.x minor. NOT sufficient on its own: a floor ABOVE the current version (`>=0.5.0` while the group
 * is at 0.2.0) is syntactically a floor yet OUT of range on the next bump — {@link floorAdmitsVersion}
 * is the semantic half, and {@link isSafeLockstepPeerRange} combines both (see file header + ADR 0047).
 *
 * @param {string} range a peer-dependency range string
 * @returns {boolean}
 */
export function isOpenLowerBoundFloor(range) {
  return /^>=\d+\.\d+\.\d+$/.test(String(range).trim().replace(/^workspace:/, ""));
}

/**
 * True iff the open `>=` floor in `range` is satisfied by `version` — i.e. the floor is AT OR BELOW
 * `version`, so `version` and every higher lockstep bump stay in range. This is the semantic guard the
 * regex alone can't give: `>=0.5.0` is a valid floor but, against a group at `0.2.0`, `0.2.0`→`0.3.0`
 * is below it → out of range → re-arms the major cascade. Hand-rolled tuple compare (semver is NOT
 * resolvable from `scripts/`, same constraint as preflight-versions.mjs). Returns false for a
 * non-floor `range` or an unparseable `version` (fail-closed).
 *
 * @param {string} range a peer-dependency range (optionally `workspace:`-prefixed)
 * @param {string} version the depended-on member's current version (bare `X.Y.Z`)
 * @returns {boolean}
 */
export function floorAdmitsVersion(range, version) {
  const f = /^(?:workspace:)?>=(\d+)\.(\d+)\.(\d+)$/.exec(String(range).trim());
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version).trim()); // release tuple; ignore any prerelease
  if (!f || !v) return false;
  const [fa, fb, fc] = f.slice(1, 4).map(Number);
  const [va, vb, vc] = v.slice(1, 4).map(Number);
  const cmp = fa - va || fb - vb || fc - vc; // spaceship: <0 floor below version, 0 equal, >0 floor above
  return cmp <= 0;
}

/**
 * True iff `range` both is an open `>=` floor AND that floor is satisfied by `currentVersion` — the
 * jointly necessary-and-sufficient shape for an intra-group peer edge (see ADR 0047). This is the
 * fast static diagnostic; the behavioral synthetic-minor `assembleReleasePlan` assertion in
 * `scripts/assert-no-phantom-major.test.mjs` is the authoritative sufficiency proof.
 *
 * @param {string} range a peer-dependency range string
 * @param {string} currentVersion the depended-on member's current version
 * @returns {boolean}
 */
export function isSafeLockstepPeerRange(range, currentVersion) {
  return isOpenLowerBoundFloor(range) && floorAdmitsVersion(range, currentVersion);
}

/**
 * The whole invariant as a pure function over plain data: the two ADR-0047 conditions checked against
 * the parsed config + every workspace manifest. An intra-group edge is detected by NAME MEMBERSHIP —
 * any peer whose name is itself a workspace package can cascade through the fixed group; a peer that is
 * NOT a workspace member (react/zod/pg/vue/…) is external, never released, and can never trigger
 * `shouldBumpMajor`. Keying on membership (not the `@lesto/` string) auto-covers `create-lesto`, any
 * future package, and any new edge, and needs no `fixed`-group parsing.
 *
 * @param {{ config: any, manifests: {name:string, version?:string, peerDependencies?:Record<string,string>}[] }} input
 *   config: parsed `.changeset/config.json`; manifests: the publishable package.json set under
 *   `packages/` (name + version + peerDependencies). This is the fast STATIC diagnostic; the
 *   behavioral test loads the FULL workspace set (incl. `site/`/`www/`/`examples/`) via
 *   `@manypkg/get-packages` and is the authoritative sufficiency proof.
 * @returns {string[]} one problem string per violation (empty array === safe)
 */
export function findPhantomMajorRisks({ config, manifests }) {
  const problems = [];

  const onlyOOR =
    config?.___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH?.onlyUpdatePeerDependentsWhenOutOfRange;
  if (onlyOOR !== true) {
    problems.push(
      ".changeset/config.json must set ___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH." +
        "onlyUpdatePeerDependentsWhenOutOfRange = true. Without it, changesets bumps EVERY peer-" +
        "dependent to MAJOR on any minor+ peer bump regardless of range, so the fixed group's next " +
        "minor becomes a phantom MAJOR (0.3.0 -> 2.0.0). See ADR 0047 / L-9eafaaaf.",
    );
  }

  const versionByName = new Map(manifests.map((m) => [m.name, m.version]));
  for (const m of manifests) {
    for (const [peer, range] of Object.entries(m.peerDependencies ?? {})) {
      if (!versionByName.has(peer)) continue; // external peer — never released, cannot cascade
      // The floor must be satisfied by the PEER's current version (it is the package being bumped and
      // range-tested). A floor above it (`>=0.5.0` while at 0.2.0) is syntactically a floor yet leaves
      // range on the next bump — that fail-open is exactly what the two reviewers caught.
      if (!isSafeLockstepPeerRange(range, versionByName.get(peer))) {
        problems.push(
          `${m.name} declares intra-workspace peer "${peer}": "${range}" (peer is at ` +
            `${versionByName.get(peer)}). A fixed-group peer range MUST be an open ">=X.Y.Z" floor ` +
            '(or "workspace:>=X.Y.Z") at or below the peer\'s current version; this shape leaves range ' +
            "on a lockstep bump and forces the whole fixed group to a phantom MAJOR. Use " +
            '">=0.1.0". See ADR 0047 / L-9eafaaaf.',
        );
      }
    }
  }
  return problems;
}

/**
 * Throwing wrapper — the caller just captures the message.
 *
 * @param {{ config: any, manifests: {name:string, peerDependencies?:Record<string,string>}[] }} input
 * @throws {Error} if any ADR-0047 condition is violated
 */
export function assertNoPhantomMajor(input) {
  const problems = findPhantomMajorRisks(input);
  if (problems.length > 0) {
    throw new Error(`phantom-major release risk (ADR 0047):\n  - ${problems.join("\n  - ")}`);
  }
}

/**
 * The SOLE fs-touching export (mirrors `readPublishableNodes` in preflight-versions.mjs): every
 * `package.json` directly under `packagesDir`, reduced to `{ name, version, peerDependencies }`. NOTE
 * this reads `packages/` ONLY — the `@lesto/*` fixed group also expands (via the root `workspaces`
 * globs changesets reads) to `site/`, `www/`, and `examples/*`, which this does NOT scan. Those are all
 * `private:true` today (skipped by changesets, cannot originate a major) and declare no intra-group
 * peer edges, so `packages/` covers the entire at-risk surface; the behavioral test in
 * `scripts/assert-no-phantom-major.test.mjs` loads the FULL set via `@manypkg/get-packages` and is the
 * catch-all. Private packages here are included deliberately — a safe SUPERSET (an inert edge is
 * costless to hold to the floor; a future de-privatization can't silently reopen the bug; no
 * private-detection logic needed).
 *
 * @param {string} packagesDir absolute path to the repo's `packages/` directory
 * @returns {{name:string, version?:string, peerDependencies?:Record<string,string>}[]} one node per package
 */
export function readWorkspaceManifests(packagesDir) {
  const out = [];
  for (const dir of readdirSync(packagesDir)) {
    try {
      const m = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
      if (m.name) out.push({ name: m.name, version: m.version, peerDependencies: m.peerDependencies });
    } catch {
      // not a package dir (no package.json / unreadable) — skip. A genuinely malformed manifest breaks
      // bun/changesets loudly upstream long before this gate runs, so a silent skip here can't mask a
      // release; the behavioral test (getPackages) would also throw on a broken manifest.
    }
  }
  return out;
}
