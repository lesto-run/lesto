# ADR 0047 — Stop the fixed-group **lockstep-minor → phantom-major** cascade: open `>=` floors on intra-group optional peers + `onlyUpdatePeerDependentsWhenOutOfRange`

- **Status:** **Accepted — ratified 2026-07-15** via the delegated chief-architect review the owner
  directed (board task `L-9eafaaaf`). Root cause and fix were verified against the real
  `@changesets/assemble-release-plan@6.0.10` dist, `semver` 7.8.5 (the copy that dist imports), and
  `bun` 1.3.5, and reproduced end-to-end: the real `assembleReleasePlan` fed the real manifests + a
  single synthetic **minor** changeset computes **1.0.0 ×49** before the fix and **0.3.0 ×49 / zero
  majors** after. This supersedes the one-time manual hack used to cut 0.2.0 (`L-9eafaaaf`:
  temporarily neutralize the intra-group peer edges for the version run, restore them, then `sed` the
  49 versions to 0.2.0), which was correct as an unblock but did nothing for the next minor.
- **Date:** 2026-07-15.
- **Deciders:** owner + chief architect (authored under `L-9eafaaaf`).
- **Builds on / touches:** the changesets **fixed lockstep group** (`.changeset/config.json`
  `fixed: [["@lesto/*", "create-lesto"]]`); the release-cut precondition module
  `scripts/lib/preflight-versions.mjs` (whose pure-function + `test:scripts-unit` pattern this ADR's
  regression gate follows); the publish-shape rewriter `scripts/lib/pack-public.mjs` (`rewriteDepRange`);
  the manifest-honesty gate `scripts/assert-isolated-node-modules.mjs` (`isExternalPeer` /
  `assertPeerHonesty`); ADR 0045 (isolated node_modules + peer-range honesty).
- **Grounded in (read 2026-07-15):**
  `node_modules/.bun/@changesets+assemble-release-plan@6.0.10/.../changesets-assemble-release-plan.esm.js`
  — `shouldBumpMajor` (~:317-333), `getDependencyVersionRanges` (~:279-316), `determineDependents`
  (~:171-272); the eight intra-workspace `@lesto→@lesto` peer edges across `packages/*/package.json`.

## Context

The published surface is 49 `@lesto/*` packages + `create-lesto`, released as a changesets **fixed
lockstep group** — every member always shares one version. Cutting **0.2.0** revealed that
`bun run version` (`changeset version`) computes a spurious **1.0.0 major** for the *entire group* on a
release carrying only **minor** changesets. 0.2.0 shipped only via a manual one-time hack. **The bug
recurs on every subsequent minor** — the next `0.3.0` would compute as `2.0.0` — and no automated gate
catches it; only a human reading the computed version does. `0.1.1`–`0.1.7` were patch-only, so this
latent bug surfaced on the first minor.

**Root cause (verified against the 6.0.10 dist).** Three facts compose:

1. The fixed-group matcher first promotes every group member to the highest bump present — here **minor**.
2. `shouldBumpMajor` returns true for a `peerDependencies` edge when the peer is bumped minor-or-more
   **and** (`!onlyUpdatePeerDependentsWhenOutOfRange` — default `false`, so *always* — **or** the
   incremented peer version leaves the dependent's declared range) **and** the dependent is not already
   major. It is the *only* place `determineDependents` assigns `type = "major"` (every other branch
   yields patch/none). → the dependent is forced to **major**, which re-propagates through the fixed
   group → the whole surface → **1.0.0**.
3. `getDependencyVersionRanges` rewrites the workspace protocol before that range test: `workspace:*` →
   the **exact** old version (`0.1.7`/`0.2.0`); `workspace:^`/`workspace:~` → `^`/`~oldVersion`. At 0.x
   semver, `^0.1.7` and `~0.1.7` both mean `>=0.1.7 <0.2.0`, and an exact pin is exact — so a minor bump
   is **out of range** under all three.

Seven **optional** (`peerDependenciesMeta.optional:true`) intra-group peer edges carried `workspace:*`:
`@lesto/identity→@lesto/mail`; `@lesto/mcp→@lesto/content-core,content-store`;
`@lesto/cli→@lesto/content-core,content-store,island-dev,styles`. (An eighth,
`@lesto/content-components→@lesto/content-mdx`, exists but is **inert** — both endpoints are
`private:true` and skipped when `privatePackages.version:false`.) Each of the seven forces a major that
cascades through the lockstep group.

**The crux.** Setting `onlyUpdatePeerDependentsWhenOutOfRange:true` *alone* does **not** fix it: while
the project is at 0.x, **no** standard workspace-protocol range (`*`, `^`, `~`) keeps a lockstep minor
in range (`semver.satisfies("0.2.0","^0.1.7") === false`, and `workspace:*`→exact is even tighter). Only
an **open floor** — `>=X.Y.Z` — stays satisfied across an 0.x minor *and* across the eventual real
`1.0.0`.

**Hard constraints.** The seven edges are `optional:true` **on purpose** (opt-in add-ons); converting
them to hard `dependencies` is unacceptable (it force-installs opt-in packages). The surface must land a
minor as a minor forever without human intervention. `scripts/` is outside the lint/type/coverage gates,
so any regression guard must be a **pure, unit-testable invariant** runnable in `test:scripts-unit`.

## Decision drivers

- **Native over bespoke:** prefer upstream-documented configuration to a script that tracks changesets
  internals or a patched dependency in the release path.
- **Correct published semantics for *optional lockstep* peers:** an opt-in add-on peer released in
  lockstep should advertise a compatibility **floor**, not an exact build pin — a floor is *more* honest
  here.
- **Fail-safe & gated:** the fix must be provably sufficient and backed by a committed, always-on
  invariant, since the only human backstop is reading the computed version at cut time.
- **Zero blast radius on local dev + publish:** must not change how bun links workspace packages, nor
  how the publish pipeline rewrites ranges.

## Decision

Adopt **Option A**:

1. `.changeset/config.json` sets
   `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH.onlyUpdatePeerDependentsWhenOutOfRange = true`.
2. Every intra-workspace `@lesto→@lesto` peer range becomes `workspace:>=0.1.0` (all eight edges,
   including the one inert private-to-private edge `content-components→content-mdx`, for uniformity so
   the guard needs no private-exemption and a future de-privatization cannot reopen the bug).
   `peerDependenciesMeta.optional` is unchanged.
3. `rm -f bun.lock && bun install`; commit the resynced lockfile.
4. A committed regression gate (`scripts/lib/assert-no-phantom-major.mjs` +
   `scripts/assert-no-phantom-major.test.mjs`, wired into `test:scripts-unit`) with **two layers**:
   - **Static diagnostic** over the publishable `packages/` set — flags the exact bad edge and how to
     fix it. An intra-group peer range is safe iff it is an open `>=X.Y.Z` floor **and** that floor is
     at or below the peer's current version (a floor *above* current, e.g. `>=0.5.0` at 0.2.0, is
     syntactically a floor but still leaves range on the next bump — a fail-open the wrap-up review
     caught and this layer now rejects).
   - **Behavioral proof** (authoritative) — loads the **full** workspace set (`packages/` + `site/` +
     `www/` + `examples/*`) via `@manypkg/get-packages`, injects a synthetic **minor** changeset, runs
     the real `assembleReleasePlan`, and asserts zero major bumps. It also pins the installed
     `@changesets/assemble-release-plan` major at 6. Because it recomputes the *real* release plan, it
     fails **closed** if any changesets upgrade renames/ignores the config option or changes
     `shouldBumpMajor` (the plan would show majors → red) — closing the residual below for the common
     cases, not just documenting it.

   The invariant the gate proves — a satisfied floor + out-of-range gating makes `shouldBumpMajor`
   false for every intra-group edge, and a peer edge is the only spurious-major originator (verified in
   `determineDependents`) — is jointly **necessary and sufficient** for changesets 6.x.

Verified harmless downstream: `rewriteDepRange` publishes `workspace:>=0.1.0` as the bare `>=0.1.0`
floor (no leftover `workspace:` for `publish.mjs`'s fail-closed guard); `isExternalPeer` exempts
`@lesto/*` siblings so the peer-honesty gate is unaffected; bun 1.3.5 accepts `workspace:>=0.1.0` and
links the local workspace package (a full `rm -f bun.lock && bun install` succeeded, changing the eight
peer-range lines **plus** one darwin-scoped `rollup/fsevents` optional-dep line — a macOS resolution
artifact bun records cross-platform-safely; `bun install --frozen-lockfile` stays green). If a future
bun regresses `workspace:>=`, fall back to the bare literal `>=0.1.0` — it resolves locally and
publishes identically, and the gate predicate accepts both.

## Consequences

- **Positive:** minors land as minors forever with no human intervention; the guard runs on every CI
  push (`test:scripts-unit`); no runtime script, no patched dependency; published optional-peer ranges
  become honest floors; local resolution and the publish pipeline are provably unaffected.
- **Negative / accepted:** the seven published optional-peer ranges widen from an exact pin to a loose
  `>=0.1.0` floor. **Trade-off (accepted):** an unbounded `>=` floor never advances, so post-1.0
  `@lesto/identity` still advertises compatibility with `@lesto/mail@0.1.0`; because these peers ship in
  lockstep the co-installed version always satisfies it, but a consumer independently pinning an old
  dependent against a much newer peer would see a looser-than-real compatibility claim. Acceptable for
  opt-in add-ons (lockstep publishing doesn't itself establish cross-version API compat); revisit with a
  bounded range at a genuine major if it ever matters. The fix also relies on
  `___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`, an API upstream marks as changeable in a patch
  (stable for years; see the residual + its behavioral mitigation below).
- **Residual risk (changesets upgrade):** the *static* layer's sufficiency proof is bound to changesets
  6.x. The **behavioral** layer closes the common cases — it recomputes the real release plan, so if any
  changesets upgrade (major *or* minor) renames/ignores `onlyUpdatePeerDependentsWhenOutOfRange` or
  changes `shouldBumpMajor`, the computed plan shows majors and the test goes **red**; it also pins the
  installed major at 6, so a major bump additionally trips a clear assertion. The un-closeable tail is a
  changesets change that *both* preserves the synthetic-minor's zero-major output *and* silently breaks
  some other release — vanishingly unlikely, and the human version-read at `release:cut` remains the
  backstop. A changesets major bump is a deliberate, reviewed event.

## Alternatives considered (and why not)

- **Hard `dependencies` instead of optional peers** — violates the opt-in contract (force-installs
  add-ons). Rejected by constraint.
- **`onlyUpdatePeerDependentsWhenOutOfRange:true` alone (keep `workspace:*`)** — insufficient:
  `workspace:*` rewrites to an exact old version that every 0.x minor leaves. Verified `false`.
- **`workspace:^` / `workspace:~`** — insufficient at 0.x (`^0.1.7`/`~0.1.7` = `>=0.1.7 <0.2.0`).
  Verified `false`.
- **Option B — script the version run** (permanent neutralize→run→restore→`sed`). Rejected: stateful,
  non-atomic (a mid-run crash corrupts the tree), and permanently couples a bespoke script to
  changesets' file-mutation order to preserve an exact-pin publish semantic Option A shows is not worth
  preserving.
- **Option C — patch `@changesets/assemble-release-plan`** to exclude intra-fixed-group peer edges from
  the major cascade. Rejected: most precise but forks release-critical tooling — every changesets
  upgrade must re-verify/re-apply the patch, versus a two-key config change expressible through an
  upstream option.
