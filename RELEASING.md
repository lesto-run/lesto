# Releasing Lesto

Lesto publishes its public `@lesto/*` surface to npm with [Changesets](https://github.com/changesets/changesets).
This is the source of truth for **how a release happens** and **what gets published**.

> **Status:** the surface is **published**. `0.1.1` (2026-06-23) → `0.1.2` (2026-07-04) →
> `0.1.3` (2026-07-08) → **`0.1.4` is live on npm as of 2026-07-09** — **49 public packages**
> (48 `@lesto/*` + `create-lesto`), **all provenance-signed**, including the **13 headline
> batteries** (cache, workflows, identity, mail, mailing-lists, webhooks, forms, flags, admin,
> realtime, pubsub, i18n, feeds). `0.1.4` was the coordinated re-release that corrected the
> `router`/`ui` stale-lockfile pins, first-published `@lesto/styles` (its first npm version —
> no 0.1.1–0.1.3), and restored provenance across the whole surface. Published via **Trusted
> Publishing (OIDC)** from `github.com/lesto-run/lesto` with **no `NPM_TOKEN`**. The workflow (`.github/workflows/release.yml`) stays gated behind the
> `RELEASE_ENABLED` repo variable and fires only on explicit `workflow_dispatch`. This doc is
> now **"here's how we cut the next release,"** not "here's how we'd start."

## How to cut a release — READ THIS FIRST

Releases publish through **CI over OIDC trusted publishing** (`.github/workflows/release.yml`,
`workflow_dispatch`). **You do not run `npm publish` locally, and you never enter an OTP
per package. If you find yourself entering an OTP for each package — STOP, you are on the
wrong path.** The one and only local publish is the one-time bootstrap of a *brand-new package
name* (below); everything already on npm publishes through CI.

1. **Record changesets** for your changes (`bun changeset`), commit them.
2. **New package names?** For each publishable package, `npm view <name> version`. Any that
   returns **E404** has never been on npm → it needs a **one-time manual bootstrap** (see
   "First-publish bootstrap" — OIDC 403s on a package that doesn't exist yet). Bootstrap **only
   those new names**, in one `bun pm pack` + `npm publish --access public` batch — a **single OTP
   covers the whole rapid batch** (the 2FA prompt is time-boxed per session, *not* truly
   per-package). Then set each new package's trusted publisher on npmjs.com (org `lesto-run`,
   repo `lesto`, workflow `release.yml`, env blank). Every *already-published* package is
   untouched here — it ships in step 5.
3. **Version bump** — `bun run version` (`changeset version`). ⚠️ **DRAGON 1 (bun.lock):** this
   bumps `package.json`s but does **NOT** regenerate `bun.lock`'s workspace `version` fields.
   `bun pm pack` rewrites `workspace:*` deps from the *lockfile*, so a stale lockfile silently
   mispins internal deps (e.g. `mailing-lists@0.1.3 → mail@0.0.0`, an E404). **`bun install
   --force` does NOT re-sync it — you must `rm -f bun.lock && bun install`.** Commit the
   regenerated lockfile. (Verified 2026-07-08; the `0.1.3` wave shipped `router`/`ui` mispinned
   because they were bootstrapped before this was known.)
4. **Preflight — MUST be green before any publish:** `bun run test:pack-boot`. This packs all 49,
   installs + boots a scaffold, AND runs the cross-ref guard (`scripts/pack-and-boot.mjs`) that
   catches exactly the Dragon-1 mispin. The manual bootstrap loop **bypasses** this guard, so run
   it explicitly on the bumped tree.
5. **Publish everything via CI.** ⚠️ **DRAGON 3 (stale origin):** CI checks out **origin**, not
   your local tree. Before dispatching: `git fetch origin && [ "$(git rev-list --count
   origin/main..HEAD)" = 0 ]` — origin/main must be at the exact SHA you intend to release (the
   Studio daemon's auto-push has silently stalled before; a stale origin makes CI no-op
   "successfully"). Then arm `RELEASE_ENABLED=true`, and `gh workflow run release.yml --ref
   <exact-sha>` (**not** `--ref main`). Read the run's publish summary: `0 published, N skipped`
   when you expected new publishes means CI built a stale tree — investigate, don't assume
   success. Restore `RELEASE_ENABLED=false` after. **GREEN-CI GATE (L-69e905de):** the workflow's
   first step refuses to publish unless the `CI` workflow concluded `success` for the dispatched
   commit — so confirm CI is green for that exact SHA before arming, or the run fails fast at
   "Require green CI for this commit" without uploading anything.

> ⚠️ **DRAGON 2 (provenance):** `.github/workflows/release.yml` pins `npm@11.5.1` on purpose —
> `npm@latest` (now `12.0.0`) regressed provenance with `Cannot find module 'sigstore'`. Do not
> change it to `@latest` or a floating `^` range without confirming provenance still works.
>
> **NEVER publish already-existing packages one-at-a-time locally.** It is unsupported: it
> produces packages with **no provenance** and, against a stale lockfile, **mispinned deps**. The
> only correct local publish is the one-time bootstrap of a genuinely new name (step 2).

## 0. Names — claimed, no longer a gate — ✅ (historical)

A release was originally blocked on the names being free on npm. That gate is **closed**: the
`@lesto` scope is secured and every name a publish touches (`create-lesto`, `lesto`, and the
`@lesto/*` surface) is now **claimed by us** — the `0.1.1`/`0.1.2` publishes hold them. No
rename or name-availability check is required to cut the next release. (Historically, before
the first publish, you would `npm view <name> version` and expect `E404` for each unclaimed
name; that step is obsolete now that we own them.)

## The published surface

**The publishable set is a RULE, not a hand-list** (a hand-list is exactly what goes stale):

> **Publishable = every directory under `packages/*` whose `package.json` has `private !== true`.**

That single filter is the source of truth in three places that must agree — `scripts/publish.mjs`
(what actually publishes), `scripts/pack-and-boot.mjs` (what validates the packed shape), and this
doc. It is **version-agnostic**: each package's own `version` is its source of truth, so a
coordinated bump needs no edit to the publish scripts. A new package joins the surface simply by
**becoming non-private** — and, if it has never been on the registry, by the one-time
"First-publish bootstrap" below. (To scaffold one in the right shape: `bun run new-package`.)

`create-lesto` lives at `packages/create-lesto`, so the same `packages/*` + `private !== true`
filter picks it up alongside the `@lesto/*` packages.

**Current count: 36 public packages** = 35 `@lesto/*` + `create-lesto`. To regenerate this list
from the live tree rather than trusting the snapshot below, run:

```sh
# every publishable dir, exactly as scripts/publish.mjs selects them:
for d in packages/*/; do node -e "const p=require('./$d/package.json'); if(p.private!==true) console.log(p.name)"; done | sort
```

As of **0.1.2** the 35 public `@lesto/*` packages are (verified against the private flags in-tree):

```
assets auth authz cli cloudflare content-core content-embeddings content-markdown
content-search content-shared content-store content-umbra cors csrf db deploy env errors
island-dev kernel mcp migrate observability openapi pg queue ratelimit router runtime seo
sites storage styles ui web
```

> **Newer than the old snapshot:** `authz`, `seo`, `styles`, and `island-dev` were
> de-privatized after `0.1.1` (plus `cloudflare` and `pg`, which an earlier revision of this
> doc also omitted). Do not maintain this block by hand — regenerate it from the command above
> whenever a package flips non-private, and update the count.

**Required-to-install closure ⊆ publishable set.** A scaffolded `create-lesto` app installs only
a *subset* of the surface (its `@lesto/*` deps and their transitive `@lesto/*` closure); the rest
are publishable but not auto-installed. You do **not** track that subset by hand: `pack-and-boot.mjs`
throws if any `@lesto/*` dependency a scaffolded app pins is **missing from the packed public
closure**, so an install-breaking omission fails the preflight rather than shipping. The `content-*`
packages are **optional peers of `@lesto/mcp`** (the content trim, `a0d5f95`), so a hello-world app
does not pull them — they publish as opt-in add-ons (`npm i @lesto/content-core @lesto/content-store`).

Everything outside the non-private set stays `private` until it has a reason to publish.

## Adding a new package — use the generator

**Do not hand-roll a new package's `package.json`** — the publishable metadata (source
`exports`, `files:["src"]`, `publishConfig.access`, `repository.directory`, and the
current fixed-group version) is exactly the easy-to-get-wrong part, and a missing field
either breaks `npm install` or ships a wrong shape. Instead:

```sh
bun run new-package <shortname> ["one-line description"]   # scripts/new-package.mjs
```

It scaffolds `packages/<shortname>/` with the correct publishable shape (matching every
sibling), born **at the current line version** (not `0.0.0`, so it's lockstep-consistent
and never trips the `assertVersionsBumped` guard) — plus a placeholder module + test so the
package **passes typecheck + `vitest run` at 100% coverage out of the box** (`index.ts` is
coverage-excluded per the house config; replace the placeholder with the real thing). Then:

1. `bun install` — link the workspace **and refresh `bun.lock`** (see Dragon 1 above; a stale
   lockfile mispins deps at pack time).
2. Build it, keep 100% coverage, `bun changeset` (the `fixed` group moves it with the line).
3. **To publish it:** a brand-new name needs the **one-time first-publish bootstrap**
   (the "First-publish bootstrap for a BRAND-NEW package" section below) before the normal
   OIDC release can touch it — OIDC 403s on a name that doesn't exist on the registry yet.

## Day-to-day: record a changeset with every change

Any change that affects a published package adds a changeset describing the bump:

```sh
bun changeset
```

Commit the generated `.changeset/*.md` alongside the code.

## First-publish bootstrap for a BRAND-NEW package (the most dangerous gap)

**Trusted Publishing (OIDC) cannot create a package that does not yet exist on the registry**
([npm/cli#8544](https://github.com/npm/cli/issues/8544)). A package's **trusted-publisher config
cannot even be created on npmjs.com until the package exists** — there is no package page to attach
it to. So the very first version of any new public package cannot go out over OIDC/CI; the OIDC run
will **403** on it.

Therefore a brand-new public package must be **manually published once** to bring it into
existence, and only then wired for OIDC:

1. **De-privatize** the package (see the metadata checklist below).
2. **Manual first-publish with a classic token + OTP.** From the package dir, `npm publish` once
   with an npm account token and 2FA OTP (this is the *only* time we publish outside CI). Use a
   `bun pm pack`-produced tarball — **never a plain `npm publish` of the source dir** — because npm
   does not rewrite the `workspace:*` protocol (see the trap below).
3. **Configure the trusted publisher** on npmjs.com for the now-existing package: package →
   **Settings → Trusted publishing** → GitHub Actions, **Organization or user** = `lesto-run`,
   **Repository** = `lesto`, **Workflow filename** = `release.yml` (filename only), Environment blank.
4. **Thereafter, releases go through CI/OIDC** like every other package.

> ⚠️ **"Bump + install + dispatch the release workflow" is WRONG when a release introduces a NEW
> package.** The dispatched OIDC run will 403 on the package that has no trusted publisher yet.
> `scripts/publish.mjs` publishes **dependency-first and fail-closed** — it packs the whole set, then
> uploads in topological order and **stops at the first failed package**, before any dependent (which
> bun-pack exact-pins to it) can ship. So that 403 **halts the release** instead of leaving a partial
> closure that makes a scaffold's `npm create lesto` **404** on a missing transitive dep. The fail-closed
> stop is a safety net, **not** a substitute for bootstrapping: the run still fails, and any package
> already uploaded *before* the 403 is live on the registry (a re-run skips it idempotently). So
> bootstrap every new package first (steps 1–3), *then* run the normal release — the ordering is
> load-bearing, and the fail-closed stop just guarantees a broken half-closure never ships.

### Metadata checklist when de-privatizing a package

Drop `"private": true`, set a coherent version in line with the current surface, add
`"publishConfig": { "access": "public" }`, and add **`"files": ["src"]`** — without it `npm pack`
ships each package's `test/`, `tsconfig.json`, and `vitest.config.ts` (Lesto runs TS directly, so
the tarball needs `src/` and only `src/`). Set a correct `repository`/`homepage`/`bugs`. For any
`content-*` package, reconcile the re-badged "Docks" metadata (`repository` → `usedocks/docks`,
`main`/`types` → a `./dist` build that does not exist in the TS-direct model) before it publishes —
this was done for the content packages that shipped in `0.1.2`, but a still-private `content-*` that
later goes public needs the same fix. See `docs/plans/publish-day.md` for the verified per-metric gaps.

## Cutting a release

1. **De-privatize any new package first** — and if it has never been on the registry, complete the
   **first-publish bootstrap** above *before* dispatching the workflow. For a release that only bumps
   already-published packages, skip straight to step 2.
2. **Align the dependency range.** `create-lesto` pins scaffolded apps at `LESTO_DEP_RANGE`
   (`packages/create-lesto/src/scaffold.ts`, currently `^0.1.0`). It must satisfy the published
   versions — for a `0.x` line, `^0.1.0` resolves `0.1.x` only (it satisfies the current `0.1.2`),
   so bump `LESTO_DEP_RANGE` in lockstep when the surface's minor moves.
3. **Version.** `bun run version` (`changeset version`) consumes the queued changesets, bumping
   versions and writing changelogs. Commit the result.

   > **⚠️ Pre-publish check — dispatch `scaffold-hoisted-preflight` on the release SHA (install/build
   > coverage ONLY — it is BLIND to the L-27285131 undici dev defect; a GREEN does NOT license publish).**
   > Run it against the exact release SHA to confirm the closure packs, hoisted-installs, and builds:
   >
   > ```sh
   > gh workflow run scaffold-hoisted-preflight.yml --ref <release-sha>   # install/build/hoisted-layout only
   > gh run watch   # or: gh run list --workflow=scaffold-hoisted-preflight.yml
   > ```
   >
   > **This preflight CANNOT catch the L-27285131 / L-3daa1173 defect** — published-0.1.2 `lesto dev`
   > (real npm-resolved hoisted closure) is unreachable to a Node undici `fetch()` client (curl/`node:http`
   > answer 200, but Node/Bun's DEFAULT `fetch()` client fails). It is a LOCAL pack (`packLestoClosure`
   > pins the whole `@lesto/*` graph to `file:` tarballs via `overrides`), so it GREENS on the very defect
   > it appears to gate (verified: overlay bisect greened at every SHA incl. published-0.1.2's own source).
   > The `scaffold-e2e-masks-real-resolution` trap — do NOT read its green as "the published default path
   > is fine." **There is NO automated pre-publish gate for the undici defect yet.** The faithful gate is
   > the re-scoped **L-513dd8a6** verdaccio check (publish HEAD's closure to a local registry → `create-lesto`
   > → hoisted install with NO `overrides` → undici `GET /`); until it lands, the undici defect is UNGATED —
   > and its fix-status at HEAD is UNPROVEN, so a 0.1.3 that bumps `create-lesto` will auto-un-skip
   > `scaffold-real-install` leg-a and re-red post-publish if still broken (gate the bump on the verdaccio
   > check, not the version string). Blocking-gate follow-up: **L-e6a86c59** (must `needs:` the verdaccio job,
   > not this blind preflight). ⚠️ Real-user exposure is NARROWER than "dev hangs" but WIDER than "harness
   > only": browsers were NOT tested against the published closure, and the agent-native dev-MCP path runs on
   > the same undici-rejecting stack — see L-513dd8a6.
4. **Publish via Trusted Publishing (OIDC) in CI — the supported path.** Releases run from
   `.github/workflows/release.yml` on `github.com/lesto-run/lesto`, authenticated by GitHub's
   OIDC identity (**NO `NPM_TOKEN`**), matched against each package's **trusted publisher** config
   on npmjs.com. Arm with the `RELEASE_ENABLED=true` repo variable, then trigger EXPLICITLY from the
   Actions tab ("Run workflow" → `workflow_dispatch`). There is deliberately **no `push` trigger**:
   this repo's Studio daemon auto-pushes to main, so an on-push release could let a stray push publish
   whatever is at HEAD the moment `RELEASE_ENABLED` flips on. The job runs `bun run release`
   (**`node scripts/publish.mjs`**), which `bun pm pack`s each public package and hands the tarball to
   `npm publish`. It is **idempotent**: a version already on the registry is skipped, so a re-run after
   a partial failure only publishes what's missing. Provenance is automatic.

   **One-time setup (per package, no bulk API):** for every published package, npmjs.com →
   the package → **Settings → Trusted publishing** → GitHub Actions, with **Organization or
   user** = `lesto-run`, **Repository** = `lesto`, **Workflow filename** = `release.yml`
   (filename only), Environment blank. Requires **npm CLI ≥ 11.5.1** + **Node ≥ 22.14** (the
   workflow upgrades npm — the Node-22 bundled npm ~10.9 is too old). A package **without** a
   trusted publisher configured **403s** — which is exactly the new-package trap the bootstrap
   section above exists to prevent.

   > ⚠️ **Two traps, both already hit:**
   > 1. **Never publish with `changeset publish` / plain `npm publish` from the package dir.**
   >    Internal deps are `"workspace:*"` and **npm does not rewrite the `workspace:` protocol**
   >    — it uploads the literal `workspace:*`, so every package fails to install with
   >    `EUNSUPPORTEDPROTOCOL`. This bit the first `0.1.0` publish (2026-06-23, superseded by
   >    `0.1.1`). `bun pm pack` rewrites it; `scripts/publish.mjs` publishes the SAME tarball
   >    `scripts/pack-and-boot.mjs` validates. `release:changeset` is kept for reference only.
   > 2. **Local/token publishing requires an OTP** when the account 2FA is "Authorization and
   >    writes" — and Classic Automation tokens (which bypassed it) are gone. It is **not** truly
   >    per-package: the 2FA code is time-boxed per session, so a **single OTP covers a rapid
   >    `npm publish` batch** (verified 2026-07-08 — one code covered the 13-package bootstrap in
   >    ~25s). Trusted Publishing sidesteps tokens and 2FA entirely, which is why it's the supported
   >    path (the token+OTP route survives only for the one-time new-package bootstrap). There is
   >    intentionally **no committed `.npmrc`**: an `${NPM_TOKEN}` authToken line expands empty
   >    under OIDC and shadows trusted-publishing auth.

## Verifying the published shape without a registry

Before a real publish, prove the *packaged* shape resolves and runs:

```sh
# pack each public package, then scaffold an app pinned at the tarballs and boot it.
bun run test:pack-boot   # node scripts/pack-and-boot.mjs
```

`pack-and-boot.mjs` packs the full non-private closure (same filter as `publish.mjs`), pins a
scaffolded app at those tarballs via `overrides`, and boots it — and fails if any `@lesto/*` dep the
scaffold pins is missing from the packed closure. The in-repo e2e (`packages/e2e/scaffold-loop.spec.ts`)
already proves the `--local file:` path builds + boots; the tarball path is the registry stand-in.

> **Known blind spot:** this local pack pins the graph to `file:` tarballs via `overrides`, so it is
> NOT the real registry-resolved closure and CANNOT catch the L-27285131/L-3daa1173 undici defect (see
> the step-3 preflight note). The faithful registry-fidelity gate is the verdaccio check tracked under
> **L-513dd8a6**.

## Local development

In the monorepo, scaffold with `create-lesto --local`: it pins `@lesto/*` at in-repo
`file:` paths so `bun install` resolves against the workspace before anything is
published. The default (no `--local`) emits the published `^0.x` ranges an outsider
gets.
