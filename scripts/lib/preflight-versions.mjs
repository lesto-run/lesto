// The `release:cut` version-bump precondition, graduated OUT of an inline `node -e` heredoc in
// `scripts/dev/release.sh` (L-ccd2d722) into committed, unit-tested helpers. That heredoc was the
// ONE stretch of the release path that was untested, un-typechecked, and invisible to oxlint/oxfmt +
// the 100%-coverage gate — bespoke caret-satisfaction math and a fail-closed range-shape guard
// sitting right beside the helpers (`assertVersionsBumped`, `readPublicPackageDirs`) that ARE
// covered. Splitting it here makes the same logic reviewable, testable, and gated like the rest.
//
// The precondition answers two questions before a release is armed:
//   1. Is EVERY publishable package bumped off the `0.0.0` placeholder? (reuses publish.mjs's own
//      `assertVersionsBumped`, so the local check is the identical floor the release enforces.)
//   2. Does the scaffold's hard-coded `LESTO_DEP_RANGE` — the range every `npm create lesto` app
//      pins EVERY `@lesto/*` dep at — still cover the surface being published? A stale range is
//      invisible to CI (its scaffold/install-proof jobs pin file:/overrides tarballs, NOT the
//      published range), so a `^0.1.0` left behind after the surface moves to `0.2.0` sails through
//      green CI yet strands every new app on the OLD line. This is the ONLY place that hole is shut.
//
// TESTING: every export except `readPublishableNodes` is PURE (takes source text / plain data, no
// fs/network), and unit-tested with a truth table in `scripts/preflight-versions.test.mjs` (that
// path, not `scripts/lib/`, matches the house convention — `pack-public.mjs`/`build-public.mjs`
// are likewise tested one level up, and the file is registered in ci.yml's scripts-unit-test step).
// `readPublishableNodes` is the sole fs-touching export (readdir + read manifests); importing this
// module runs NOTHING — the effectful CLI wiring stays in `release.sh` (a couple of lines now).

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readPublicPackageDirs } from "./pack-public.mjs";
// publish.mjs's `main()` is guarded by an `import.meta.url === argv[1]` check, so importing it here
// runs nothing — we reuse its version FLOOR so the local precondition is the identical assertion the
// release enforces, never a drifting re-implementation.
import { assertVersionsBumped } from "../publish.mjs";

/** Sign of the difference between two `X.Y.Z` version tuples: <0, 0, or >0 (like a spaceship). */
function compareVersionTuples(aMaj, aMin, aPat, bMaj, bMin, bPat) {
  return aMaj - bMaj || aMin - bMin || aPat - bPat;
}

/**
 * Caret-range membership WITHOUT a semver dependency (semver is not resolvable from this repo,
 * verified with `require.resolve` at authoring time — hence the hand-rolled check). Models ONLY the
 * simple `^X.Y.Z` caret `LESTO_DEP_RANGE` actually uses; the caller fails closed on any other range
 * shape (see {@link assertCaretRangeShape}) before trusting this. Caret-on-zero semantics:
 *   `^X.Y.Z` (X>0) := `>=X.Y.Z  <(X+1).0.0`
 *   `^0.Y.Z` (Y>0) := `>=0.Y.Z  <0.(Y+1).0`
 *   `^0.0.Z`       := `>=0.0.Z  <0.0.(Z+1)`
 *
 * A prerelease-tagged VERSION (e.g. `0.2.0-rc.1`, not a bare `X.Y.Z`) → `"unknown"`, NOT a verdict:
 * prereleases ship under a `next` dist-tag and a caret from `latest` never pulls them, so a
 * range/prerelease mismatch is not a real stale-pin and a false hard-fail there would be worse. A
 * non-caret `range` likewise → `"unknown"` (this function alone cannot model it) — the caller turns
 * that into a fail-closed error via {@link assertCaretRangeShape}, so an unverifiable RANGE never
 * silently passes here even though this pure primitive is deliberately non-committal about it.
 *
 * @param {string} version a package version (bare `X.Y.Z` is caret-checkable; a prerelease is not)
 * @param {string} range a dependency range (only a simple `^X.Y.Z` caret is modelled)
 * @returns {"satisfied"|"unsatisfied"|"unknown"} whether `version` falls in `range`, or `"unknown"`
 *          when either side is a shape this checker does not model
 */
export function caretSatisfies(version, range) {
  const cm = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  const vm = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim()); // bare X.Y.Z only; a prerelease tag → unknown
  if (!cm || !vm) return "unknown";
  const [rMaj, rMin, rPat] = cm.slice(1, 4).map(Number);
  const [vMaj, vMin, vPat] = vm.slice(1, 4).map(Number);
  const geLow = compareVersionTuples(vMaj, vMin, vPat, rMaj, rMin, rPat) >= 0;
  const hi = rMaj > 0 ? [rMaj + 1, 0, 0] : rMin > 0 ? [0, rMin + 1, 0] : [0, 0, rPat + 1];
  const ltHigh = compareVersionTuples(vMaj, vMin, vPat, hi[0], hi[1], hi[2]) < 0;
  return geLow && ltHigh ? "satisfied" : "unsatisfied";
}

/**
 * FAIL CLOSED on an unrecognized RANGE shape. {@link caretSatisfies} models only the simple `^X.Y.Z`
 * caret; a future `~0.1.0` / `>=0.1.0` / `0.1.x` / `||` / caret-with-prerelease is one this checker
 * CANNOT verify. Warning-and-proceeding on an unverifiable range would reopen the exact stale-pin
 * hole this precondition exists to close (a `~0.1.0` resolves 0.1.x only, never 0.2.x, yet would
 * sail through). So refuse and tell the operator to extend the checker. NB: this guards the RANGE
 * shape; an individual prerelease VERSION is a warn-not-fail case handled in
 * {@link buildPreflightSummary}, deliberately NOT here.
 *
 * @param {string} range the scaffold's `LESTO_DEP_RANGE`
 * @throws {Error} if `range` is not a simple `^X.Y.Z` caret
 */
export function assertCaretRangeShape(range) {
  if (!/^\^\d+\.\d+\.\d+$/.test(range.trim())) {
    throw new Error(
      `scaffold LESTO_DEP_RANGE "${range}" is not a simple ^X.Y.Z caret. The release:cut ` +
        "satisfaction checker only models that shape, so it cannot verify this range covers the " +
        "surface -- refusing rather than waving an unverifiable pin through. Extend caretSatisfies " +
        "in scripts/lib/preflight-versions.mjs, or normalize LESTO_DEP_RANGE to a caret, before " +
        "releasing.",
    );
  }
}

/**
 * Grep `LESTO_DEP_RANGE` straight out of the scaffold SOURCE TEXT (its single source of truth).
 * Takes the source string, not a path, so it stays pure and unit-testable. If the constant was
 * renamed or moved the regex misses → THROW (fail closed) rather than silently skip the whole
 * scaffold-range check.
 *
 * @param {string} scaffoldSource the contents of `packages/create-lesto/src/scaffold.ts`
 * @param {string} [sourcePath] a label for the error message (the caller passes the real path)
 * @returns {string} the declared range string (e.g. `"^0.1.0"`)
 * @throws {Error} if no `LESTO_DEP_RANGE = "..."` declaration is present
 */
export function extractDepRange(scaffoldSource, sourcePath = "packages/create-lesto/src/scaffold.ts") {
  const rangeMatch = /const\s+LESTO_DEP_RANGE\s*=\s*"([^"]+)"/.exec(scaffoldSource);
  if (!rangeMatch) {
    throw new Error(
      `could not find LESTO_DEP_RANGE in ${sourcePath} -- the scaffold pin was renamed or moved. ` +
        "Update the extractDepRange regex in scripts/lib/preflight-versions.mjs to match the new " +
        "declaration.",
    );
  }
  return rangeMatch[1];
}

/**
 * The publishable set as `{ name, version }` nodes — the dir→manifest mapping publish.mjs's `main()`
 * does, minus the graph-only `dir`/`deps` fields this precondition does not need. The SOLE fs-touching
 * export: it reuses the shared `readPublicPackageDirs` filter (so it covers the exact set the release
 * ships) and reads each manifest's `name`/`version`.
 *
 * @param {string} packagesDir absolute path to the repo's `packages/` directory
 * @returns {{name:string, version:string}[]} one node per publishable package
 */
export function readPublishableNodes(packagesDir) {
  return readPublicPackageDirs(packagesDir).map((dir) => {
    const manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    return { name: manifest.name, version: manifest.version };
  });
}

/**
 * The whole version-bump precondition as one pure function: assert every package is bumped off the
 * `0.0.0` placeholder, assert the scaffold range is a shape we can verify, assert it satisfies every
 * distinct published version, and return the ONE summary line `release.sh` prints in its preflight
 * table. Throws on any fail-closed condition; the caller just captures stdout (or the thrown message).
 *
 * The scaffold pins EVERY `@lesto/*` dep at the one `depRange`, so it must satisfy every published
 * version. A coherent `fixed`-group release is a single version, but each distinct one is checked
 * defensively. A prerelease VERSION → `"unknown"` (via {@link caretSatisfies}) → WARN in the summary
 * note, never a hard fail (the range-shape fail-closed guard is {@link assertCaretRangeShape}).
 *
 * @param {{nodes:{name:string,version:string}[], depRange:string}} input the publishable nodes +
 *        the scaffold's `LESTO_DEP_RANGE`
 * @returns {string} the preflight summary line, e.g.
 *          `49 publishable packages @ 0.1.7 (scaffold LESTO_DEP_RANGE "^0.1.0" satisfies the surface)`
 * @throws {Error} if any package is un-bumped, the range shape is unverifiable, or a version is
 *         outside the range
 */
export function buildPreflightSummary({ nodes, depRange }) {
  assertVersionsBumped(nodes);
  const versions = [...new Set(nodes.map((n) => n.version))].toSorted();

  assertCaretRangeShape(depRange);
  const unsatisfied = versions.filter((v) => caretSatisfies(v, depRange) === "unsatisfied");
  const unknown = versions.filter((v) => caretSatisfies(v, depRange) === "unknown");
  if (unsatisfied.length > 0) {
    throw new Error(
      `scaffold LESTO_DEP_RANGE "${depRange}" does NOT satisfy release version(s) ` +
        `${unsatisfied.join(", ")}. A freshly-scaffolded app pins every @lesto/* dep at that range, ` +
        `so publishing this surface would leave new apps on the OLD line ("^0.1.0" resolves 0.1.x ` +
        "only, never 0.2.x). Bump LESTO_DEP_RANGE in packages/create-lesto/src/scaffold.ts to " +
        "match, commit, and re-run. (ci.yml install-proof pins file:/overrides tarballs, not this " +
        "published range, so it cannot catch a stale pin -- that is why this check lives here.)",
    );
  }

  // Surface the range + verdict on the summary line. `unknown` here means a prerelease VERSION, not
  // an unverified range — the range shape is already fail-closed above, so this only fires when a
  // published version carries a `-prerelease` tag.
  const note =
    unknown.length > 0
      ? `scaffold LESTO_DEP_RANGE "${depRange}" set, but prerelease version(s) present -- not caret-checkable, EYEBALL`
      : `scaffold LESTO_DEP_RANGE "${depRange}" satisfies the surface`;
  return `${nodes.length} publishable packages @ ${versions.join(", ")} (${note})`;
}
