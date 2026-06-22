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
resolve. The closure is **auto-derived**, not maintained by hand: `scripts/pack-and-boot.mjs`
packs every package that is `private !== true` with `version === "0.1.0"`, and fails if any
`@lesto/*` dep a scaffolded app pins is missing from that set — so a new published package
joins the closure simply by being non-private at `0.1.0`. The set is roughly:

```
assets auth cli content-core content-embeddings content-markdown content-search
content-shared content-store content-umbra cors csrf db deploy env errors kernel mcp
migrate observability openapi queue ratelimit router runtime sites storage ui web
```

> Note: the closure currently drags in several `content-*` packages tagged **preview**
> in `ARCHITECTURE.md`. Trimming the supported surface so a hello-world app does not
> pull preview packages is tracked separately (it is a dependency-shape change, not a
> release-tooling one).

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
4. **Arm + publish.** Set the `RELEASE_ENABLED` repository variable to `true` and add
   the `NPM_TOKEN` secret. `bun run release` (`changeset publish`) publishes the bumped
   packages to npm with provenance — in CI this is the `changesets/action` step in
   `.github/workflows/release.yml`, which stays skipped until `RELEASE_ENABLED` is set.

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
