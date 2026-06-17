# Releasing Keel

Keel publishes its public `@keel/*` surface to npm with [Changesets](https://github.com/changesets/changesets).
This is the source of truth for **how a release happens** and **what gets published**.

> **Status:** the pipeline (Changesets config, scripts, and `.github/workflows/release.yml`)
> is wired, but **nothing has been published yet** — the public surface is still
> `private`, and the publish workflow is **skipped** until the `RELEASE_ENABLED`
> repository variable is set to `true` (and an `NPM_TOKEN` secret exists). The first
> publish is the de-privatization step below.

## The published surface

A scaffolded app (`create-keel`) installs `@keel/cli`, `@keel/assets`, `@keel/db`,
`@keel/kernel`, `@keel/migrate`, `@keel/runtime`, `@keel/ui`, and `@keel/web`. Their
transitive `@keel/*` closure — **28 packages** — must all be public for an install to
resolve:

```
assets auth cli content-core content-embeddings content-markdown content-search
content-shared content-store content-umbra cors csrf db deploy errors kernel mcp
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
   above: drop `"private": true`, set a coherent starting version (`0.1.0`), and add
   `"publishConfig": { "access": "public" }`. Keep every other package `private`.
2. **Align the dependency range.** `create-keel` pins scaffolded apps at
   `KEEL_DEP_RANGE` (`packages/create-keel/src/scaffold.ts`, currently `^0.1.0`). It
   must satisfy the published versions — for a `0.x` line, `^0.1.0` resolves `0.1.x`
   only, so bump `KEEL_DEP_RANGE` in lockstep when the surface's minor moves.
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

In the monorepo, scaffold with `create-keel --local`: it pins `@keel/*` at in-repo
`file:` paths so `bun install` resolves against the workspace before anything is
published. The default (no `--local`) emits the published `^0.x` ranges an outsider
gets.
