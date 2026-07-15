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
//   2. every INTRA-WORKSPACE peer range is an open `>=X.Y.Z` floor (or `workspace:>=X.Y.Z`), the only
//      shape that stays satisfied across an 0.x lockstep minor (`^`/`~`/`*`/exact all leave range at 0.x).
// Sufficiency: a peer edge is the ONLY source of a spurious `major` in `determineDependents` (the sole
// `type="major"` assignment sits inside `if (shouldBumpMajor(...))`; every other branch yields
// patch/none, and the fixed-group matcher only PROPAGATES the highest existing type). With (1)+(2),
// `shouldBumpMajor` returns false for every intra-group edge, so no phantom major can originate.
//
// WHY THIS FILE IS THE GUARD. `scripts/` is deliberately OUTSIDE the oxlint/oxfmt/typecheck/100%-coverage
// gates (they scan `packages/` + `@lesto/*` only), so the ONLY guard on this release-critical logic is
// the unit test `scripts/assert-no-phantom-major.test.mjs`, registered in ci.yml's `test:scripts-unit`
// step. Every export except `readWorkspaceManifests` is PURE (plain data in, no fs/network), mirroring
// the `scripts/lib/preflight-versions.mjs` house pattern. Do NOT assume the coverage/typecheck gate has
// your back when editing here — extend the test.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * True iff `range` keeps a fixed-group member IN-RANGE across an 0.x lockstep MINOR bump — the only
 * shape that stops `shouldBumpMajor` from forcing an intra-group peer-dependent to MAJOR. Strips an
 * optional `workspace:` prefix (changesets strips it before range-testing and keeps a valid `>=` range
 * verbatim; bun accepts both `workspace:>=x.y.z` and the bare literal, and both publish as the bare
 * floor), then requires an OPEN `>=X.Y.Z` floor. `workspace:*`/`^`/`~`, caret, tilde, and an exact pin
 * are all rejected — each leaves range on an 0.x minor (see the file header + ADR 0047).
 *
 * @param {string} range a peer-dependency range string
 * @returns {boolean}
 */
export function isSafeLockstepPeerRange(range) {
  return /^>=\d+\.\d+\.\d+$/.test(String(range).trim().replace(/^workspace:/, ""));
}

/**
 * The whole invariant as a pure function over plain data: the two ADR-0047 conditions checked against
 * the parsed config + every workspace manifest. An intra-group edge is detected by NAME MEMBERSHIP —
 * any peer whose name is itself a workspace package can cascade through the fixed group; a peer that is
 * NOT a workspace member (react/zod/pg/vue/…) is external, never released, and can never trigger
 * `shouldBumpMajor`. Keying on membership (not the `@lesto/` string) auto-covers `create-lesto`, any
 * future package, and any new edge, and needs no `fixed`-group parsing.
 *
 * @param {{ config: any, manifests: {name:string, peerDependencies?:Record<string,string>}[] }} input
 *   config: parsed `.changeset/config.json`; manifests: EVERY workspace package.json (public + private).
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

  const workspaceNames = new Set(manifests.map((m) => m.name));
  for (const m of manifests) {
    for (const [peer, range] of Object.entries(m.peerDependencies ?? {})) {
      if (!workspaceNames.has(peer)) continue; // external peer — never released, cannot cascade
      if (!isSafeLockstepPeerRange(range)) {
        problems.push(
          `${m.name} declares intra-workspace peer "${peer}": "${range}". A fixed-group peer range ` +
            'MUST be an open ">=X.Y.Z" floor (or "workspace:>=X.Y.Z"); this shape leaves range on an ' +
            "0.x lockstep minor and forces the whole fixed group to a phantom MAJOR. Use " +
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
 * `package.json` directly under `packagesDir`, reduced to `{ name, peerDependencies }`. Private packages
 * are included deliberately — the check is a safe SUPERSET (a private edge is inert in the release plan
 * but costless to hold to the floor, and including it means a future de-privatization cannot silently
 * reopen the bug, and the guard needs no private-detection logic).
 *
 * @param {string} packagesDir absolute path to the repo's `packages/` directory
 * @returns {{name:string, peerDependencies?:Record<string,string>}[]} one node per workspace package
 */
export function readWorkspaceManifests(packagesDir) {
  const out = [];
  for (const dir of readdirSync(packagesDir)) {
    try {
      const m = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
      if (m.name) out.push({ name: m.name, peerDependencies: m.peerDependencies });
    } catch {
      // not a package dir (no package.json / unreadable) — skip
    }
  }
  return out;
}
