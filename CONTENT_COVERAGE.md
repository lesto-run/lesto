# Content packages — coverage ratchet

The `@lesto/content-*` packages were folded in from Docks (`@usedocks/*`). They
arrived below Lesto's non-negotiable bar of **100% coverage**, so rather than
hold the fold-in hostage to a large up-front test-writing effort, we freeze
each package's coverage at its inherited baseline and ratchet it up in waves.

## The rule

- **New or modified content code is gated at 100%.** Any function you add or
  touch in a `@lesto/content-*` package ships fully covered — no exceptions.
  This is enforced in review, the same as everywhere else in Lesto.

- **Legacy content code is frozen, not exempt.** Each package's
  `vitest.config.ts` runs its inherited tests but does **not** enforce the 100%
  threshold yet. The threshold is removed, not lowered to a number we then
  forget — see the comment in each frozen config.

- **The ratchet only goes up.** When a package reaches 100%, its config is
  switched to the standard Lesto gate (thresholds: lines/functions/branches/
  statements = 100) and it can never regress.

## Status, by package

As of the fold-in's first reconciliation, **all twelve in-tree content
packages typecheck at 0 errors under Lesto's strict base and carry 0 oxlint
diagnostics** — the root `oxlint packages` gate is green across all 47
packages. What remains to ratchet is *test coverage*: six packages arrived
with substantial passing suites (frozen below the 100% gate), six arrived with
no tests at all (frozen at 0%, `passWithNoTests` so the command does not
hard-fail). A package graduates off this list when its config flips to the
enforced 100% gate.

| Package                    | tsc | oxlint | Tests           | Coverage status          |
| -------------------------- | --- | ------ | --------------- | ------------------------ |
| `@lesto/content-core`       | 0   | 0      | 681 passing     | frozen (has suite)       |
| `@lesto/content-shared`     | 0   | 0      | 377 passing     | frozen (has suite)       |
| `@lesto/content-prose`      | 0   | 0      | 155 passing     | frozen (has suite)       |
| `@lesto/content-umbra`      | 0   | 0      | 94 passing      | frozen (has suite)       |
| `@lesto/content-markdown`   | 0   | 0      | 61 passing      | frozen (has suite)       |
| `@lesto/content-query`      | 0   | 0      | 13 passing      | frozen (has suite)       |
| `@lesto/content-vite`       | 0   | 0      | 5 passing       | frozen (has suite)       |
| `@lesto/content-lint`       | 0   | 0      | none            | frozen at 0% — needs tests |
| `@lesto/content-mdx`        | 0   | 0      | none            | frozen at 0% — needs tests |
| `@lesto/content-search`     | 0   | 0      | none            | frozen at 0% — needs tests |
| `@lesto/content-seo`        | 0   | 0      | none            | frozen at 0% — needs tests |
| `@lesto/content-embeddings` | 0   | 0      | none            | frozen at 0% — needs tests |
| `@lesto/content-components` | 0   | 0      | none            | frozen at 0% — needs tests |
| `@lesto/content-mcp`        | 0   | 0      | none            | frozen at 0% — needs tests |

`@lesto/content-store` (DB bridge) is not in this table — it was written in-tree,
not folded in, and ships at the enforced 100% gate.

Not yet folded in (deferred to a later wave): `@lesto/content-studio` (the
14K-LOC visual editor).

> Dropped from the fold-in: `@usedocks/next` (Lesto ships its own runtime),
> `create-docks` (superseded by `create-lesto`), and `@usedocks/cli` (its
> content commands fold into `@lesto/cli` during integration, not as a second CLI).
