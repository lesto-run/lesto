# Content packages — coverage ratchet

The `@keel/content-*` packages were folded in from Docks (`@usedocks/*`). They
arrived below Keel's non-negotiable bar of **100% coverage**, so rather than
hold the fold-in hostage to a large up-front test-writing effort, we freeze
each package's coverage at its inherited baseline and ratchet it up in waves.

## The rule

- **New or modified content code is gated at 100%.** Any function you add or
  touch in a `@keel/content-*` package ships fully covered — no exceptions.
  This is enforced in review, the same as everywhere else in Keel.

- **Legacy content code is frozen, not exempt.** Each package's
  `vitest.config.ts` runs its inherited tests but does **not** enforce the 100%
  threshold yet. The threshold is removed, not lowered to a number we then
  forget — see the comment in each frozen config.

- **The ratchet only goes up.** When a package reaches 100%, its config is
  switched to the standard Keel gate (thresholds: lines/functions/branches/
  statements = 100) and it can never regress.

## Status, by package

As of the fold-in's first reconciliation, **all twelve in-tree content
packages typecheck at 0 errors under Keel's strict base and carry 0 oxlint
diagnostics** — the root `oxlint packages` gate is green across all 47
packages. What remains to ratchet is *test coverage*: six packages arrived
with substantial passing suites (frozen below the 100% gate), six arrived with
no tests at all (frozen at 0%, `passWithNoTests` so the command does not
hard-fail). A package graduates off this list when its config flips to the
enforced 100% gate.

| Package                    | tsc | oxlint | Tests           | Coverage status          |
| -------------------------- | --- | ------ | --------------- | ------------------------ |
| `@keel/content-core`       | 0   | 0      | 681 passing     | frozen (has suite)       |
| `@keel/content-shared`     | 0   | 0      | 377 passing     | frozen (has suite)       |
| `@keel/content-prose`      | 0   | 0      | 155 passing     | frozen (has suite)       |
| `@keel/content-umbra`      | 0   | 0      | 94 passing      | frozen (has suite)       |
| `@keel/content-markdown`   | 0   | 0      | 61 passing      | frozen (has suite)       |
| `@keel/content-query`      | 0   | 0      | 13 passing      | frozen (has suite)       |
| `@keel/content-vite`       | 0   | 0      | 5 passing       | frozen (has suite)       |
| `@keel/content-lint`       | 0   | 0      | none            | frozen at 0% — needs tests |
| `@keel/content-mdx`        | 0   | 0      | none            | frozen at 0% — needs tests |
| `@keel/content-search`     | 0   | 0      | none            | frozen at 0% — needs tests |
| `@keel/content-seo`        | 0   | 0      | none            | frozen at 0% — needs tests |
| `@keel/content-embeddings` | 0   | 0      | none            | frozen at 0% — needs tests |
| `@keel/content-components` | 0   | 0      | none            | frozen at 0% — needs tests |
| `@keel/content-mcp`        | 0   | 0      | none            | frozen at 0% — needs tests |

`@keel/content-store` (DB bridge) is not in this table — it was written in-tree,
not folded in, and ships at the enforced 100% gate.

Not yet folded in (deferred to a later wave): `@keel/content-studio` (the
14K-LOC visual editor).

> Dropped from the fold-in: `@usedocks/next` (Keel ships its own runtime),
> `create-docks` (superseded by `create-keel`), and `@usedocks/cli` (its
> content commands fold into `@keel/cli` during integration, not as a second CLI).
