# Releasing Volo

Volo publishes its public `@volo/*` surface to npm with [Changesets](https://github.com/changesets/changesets).
This is the source of truth for **how a release happens** and **what gets published**.

> **Status:** the pipeline (Changesets config, scripts, and `.github/workflows/release.yml`)
> is wired, but **nothing has been published yet** — the public surface is still
> `private`, and the publish workflow is **skipped** until the `RELEASE_ENABLED`
> repository variable is set to `true` (and an `NPM_TOKEN` secret exists). Publish day is
> gated on a rename first (the current names are taken — see §0), then the
> de-privatization step below.

## 0. The names must be free — confirm FIRST (gate)

A release is impossible until the names it would publish under are actually available on
npm. **As of 2026-06-17 they are not:**

- `create-volo` is **taken** — `npm view create-volo version` → `1.0.0`. So `npm create volo`
  would run a stranger's package, not this scaffold. This alone blocks the entrypoint.
- `volo` is **taken** — `npm view volo version` → `0.458.0`.
- the `@volo/<pkg>` member names read as free today, but the scope is moot the moment the
  brand changes.

So **publish day starts with a rename**, not de-privatization. Choose the brand + npm
scope, confirm every name a publish would claim is free, then rename the workspace before
any step below:

```sh
# nothing printed = free to claim:
npm view @<scope>/cli version
npm view @<scope>/db version
npm view create-<name> version   # the `npm create <name>` entrypoint
```

The rename is mechanical but wide — ~2,760 `@volo/` occurrences across ~520 files, the
`volo` CLI bin (`packages/cli` → `bin`), and the `create-volo` package name/scaffold — so
it lands as one sweep, gated green, ahead of de-privatization. Until it does, leave
`RELEASE_ENABLED` unset.

## The published surface

A scaffolded app (`create-volo`) installs `@volo/cli`, `@volo/assets`, `@volo/db`,
`@volo/kernel`, `@volo/migrate`, `@volo/runtime`, `@volo/ui`, and `@volo/web`. Their
transitive `@volo/*` closure — **28 packages** — must all be public for an install to
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
2. **Align the dependency range.** `create-volo` pins scaffolded apps at
   `VOLO_DEP_RANGE` (`packages/create-volo/src/scaffold.ts`, currently `^0.1.0`). It
   must satisfy the published versions — for a `0.x` line, `^0.1.0` resolves `0.1.x`
   only, so bump `VOLO_DEP_RANGE` in lockstep when the surface's minor moves.
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

In the monorepo, scaffold with `create-volo --local`: it pins `@volo/*` at in-repo
`file:` paths so `bun install` resolves against the workspace before anything is
published. The default (no `--local`) emits the published `^0.x` ranges an outsider
gets.
