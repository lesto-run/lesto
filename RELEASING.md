# Releasing Lesto

Lesto publishes its public `@lesto/*` surface to npm with [Changesets](https://github.com/changesets/changesets).
This is the source of truth for **how a release happens** and **what gets published**.

> **Status:** the pipeline (Changesets config, scripts, and `.github/workflows/release.yml`)
> is wired, but **nothing has been published yet** — the public surface is still
> `private`, and the publish workflow is **skipped** until the `RELEASE_ENABLED`
> repository variable is set to `true` (and an `NPM_TOKEN` secret exists). The §0 rename
> gate is now **cleared**; what remains is the de-privatization batch below.

## 0. The names must be free — confirm FIRST (gate) — ✅ CLEARED 2026-06-19

A release is impossible until the names it would publish under are actually available on
npm. **The 2026-06-17 blocker (names taken under the prior brand) is resolved by the
Keel→Lesto rename**, which already landed (`@lesto` scope secured). A live check on
2026-06-19 returns `E404` (unclaimed) for every name a publish would touch:

```sh
# all return E404 = free to claim, as of 2026-06-19:
npm view create-lesto version    # E404
npm view lesto version           # E404
npm view @lesto/cli version      # E404  (and db / kernel / runtime / errors / …)
```

Names can be claimed by anyone until we take them, so **re-run this for the full closure on
the morning of publish**. But the rename sweep is done and no further rename is required;
proceed to de-privatization.

## The published surface

A scaffolded app (`create-lesto`) installs `@lesto/cli`, `@lesto/assets`, `@lesto/db`,
`@lesto/env`, `@lesto/kernel`, `@lesto/migrate`, `@lesto/runtime`, `@lesto/ui`, and
`@lesto/web`. Their transitive `@lesto/*` closure must all be public for an install to
resolve — **23 packages** after the content trim (`a0d5f95`), which made `content-*` an
optional peer of `@lesto/mcp` rather than a required dep. The **publishable** set is
broader than that **required-to-install** closure: it is **auto-derived**, not maintained
by hand — `scripts/pack-and-boot.mjs` packs every package that is `private !== true` with
`version === "0.1.0"`, and fails if any `@lesto/*` dep a scaffolded app pins is missing
from that set — so a new published package joins simply by being non-private at `0.1.0`.
The publishable set is roughly (the `content-*` entries publish as opt-in add-ons, not
auto-installed):

```
assets auth cli content-core content-embeddings content-markdown content-search
content-shared content-store content-umbra cors csrf db deploy env errors kernel mcp
migrate observability openapi queue ratelimit router runtime sites storage ui web
```

> Note: the content trim is **done** (`a0d5f95`) — `content-*` (tagged **preview** in
> `ARCHITECTURE.md`) are now optional peers of `@lesto/mcp`, so a hello-world app no
> longer pulls them (install dropped 410 → 157 packages). They stay public and
> publishable as opt-in add-ons: `npm i @lesto/content-core @lesto/content-store`.

Everything outside this closure stays `private` until it has a reason to publish.

## Day-to-day: record a changeset with every change

Any change that affects a published package adds a changeset describing the bump:

```sh
bun changeset
```

Commit the generated `.changeset/*.md` alongside the code.

## Cutting a release

1. **De-privatize the surface (first release only).** For each package in the closure
   above: drop `"private": true`, set a coherent starting version (`0.1.0`), add
   `"publishConfig": { "access": "public" }`, and add **`"files": ["src"]`** — without it
   `npm pack` ships each package's `test/`, `tsconfig.json`, and `vitest.config.ts` (Lesto
   runs TS directly, so the tarball needs `src/` and only `src/`). Also set a correct
   `repository`/`homepage`/`bugs`, and **reconcile the `content-*` packages**: they carry
   re-badged "Docks" metadata (`repository` → `usedocks/docks`, `main`/`types` → a `./dist`
   build that does not exist in the TS-direct model) that must be fixed before they publish.
   Keep every other package `private`. See `docs/plans/publish-day.md` for the verified
   per-metric gap counts.
2. **Align the dependency range.** `create-lesto` pins scaffolded apps at
   `LESTO_DEP_RANGE` (`packages/create-lesto/src/scaffold.ts`, currently `^0.1.0`). It
   must satisfy the published versions — for a `0.x` line, `^0.1.0` resolves `0.1.x`
   only, so bump `LESTO_DEP_RANGE` in lockstep when the surface's minor moves.
3. **Version.** `bun run version` consumes the queued changesets, bumping versions and
   writing changelogs. Commit the result.

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
   OIDC identity (NO `NPM_TOKEN`), matched against each package's **trusted publisher** config
   on npmjs.com. Arm with the `RELEASE_ENABLED=true` repo variable, then trigger from the
   Actions tab ("Run workflow") or by pushing to main. The job runs `bun run release`
   (**`node scripts/publish.mjs`**), which `bun pm pack`s each public package and hands the
   tarball to `npm publish`. Provenance is automatic.

   **One-time setup (per package, no bulk API):** for every published package, npmjs.com →
   the package → **Settings → Trusted publishing** → GitHub Actions, with **Organization or
   user** = `lesto-run`, **Repository** = `lesto`, **Workflow filename** = `release.yml`
   (filename only), Environment blank. Requires **npm CLI ≥ 11.5.1** + **Node ≥ 22.14** (the
   workflow upgrades npm; the Node-22 bundled npm is too old).

   > ⚠️ **Two traps, both already hit:**
   > 1. **Never publish with `changeset publish` / plain `npm publish` from the package dir.**
   >    Internal deps are `"workspace:*"` and **npm does not rewrite the `workspace:` protocol**
   >    — it uploads the literal `workspace:*`, so every package fails to install with
   >    `EUNSUPPORTEDPROTOCOL`. This bit the first `0.1.0` publish (2026-06-23, superseded by
   >    `0.1.1`). `bun pm pack` rewrites it; `scripts/publish.mjs` publishes the SAME tarball
   >    `scripts/pack-and-boot.mjs` validates. `release:changeset` is kept for reference only.
   > 2. **Local/token publishing requires OTP per package** when the account 2FA is
   >    "Authorization and writes" — and Classic Automation tokens (which bypassed it) are gone.
   >    Trusted Publishing sidesteps tokens and 2FA entirely, which is why it's the supported
   >    path. There is intentionally **no committed `.npmrc`**: an `${NPM_TOKEN}` authToken line
   >    expands empty under OIDC and shadows trusted-publishing auth.

## Verifying the published shape without a registry

Before a real publish, prove the *packaged* shape resolves and runs:

```sh
# pack each public package, then scaffold an app pinned at the tarballs and boot it.
# (The in-repo e2e — packages/e2e/scaffold-loop.spec.ts — already proves the
#  --local file: path builds + boots; the tarball path is the registry stand-in.)
```

A `bun pm pack`-based install-and-boot CI job is the next increment here.

## Local development

In the monorepo, scaffold with `create-lesto --local`: it pins `@lesto/*` at in-repo
`file:` paths so `bun install` resolves against the workspace before anything is
published. The default (no `--local`) emits the published `^0.x` ranges an outsider
gets.
