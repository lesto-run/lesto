# Changesets

This directory holds [Changesets](https://github.com/changesets/changesets) — the
release tooling for the Volo monorepo. Every change that affects a published
`@volo/*` package should add a changeset describing the bump:

```sh
bun changeset          # interactively record what changed and the semver bump
```

This writes a markdown file here. At release time `bun run version` consumes the
queued changesets (bumping versions + writing changelogs) and `bun run release`
publishes. See [`RELEASING.md`](../RELEASING.md) for the full sequence and the
list of the published surface.
