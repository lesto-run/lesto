# Contributing to Lesto

Thanks for your interest in Lesto. This document is the practical companion to
[CONVENTIONS.md](./CONVENTIONS.md) — that file *is* the engineering bar; this one
tells you how to set up, run the gate, and open a change that meets it.

## Prerequisites

- **[Bun](https://bun.sh) 1.3.5** — the runtime and package manager (the version
  is pinned in `package.json`'s `packageManager`).
- **Node ≥ 22** — Lesto targets Node 22+ for runtime compatibility.

Packages run their TypeScript directly under Bun + vitest — there is no build
step for the source itself. Their `exports` point at `./src/index.ts`.

## Getting started

```sh
git clone <repo-url> lesto
cd lesto
bun install
```

A good smoke test that the workspace resolves is the canonical blog example:

```sh
bun run examples/blog/serve.ts   # boots an app, seeds it, listens on :3000
```

See [docs/guide/quickstart.md](./docs/guide/quickstart.md) for the full
first-app walkthrough.

## The bar (non-negotiable)

Every change ships to the standard in [CONVENTIONS.md](./CONVENTIONS.md). The
load-bearing rules:

- **Strict TypeScript, ESM only.** No `any`, no type-dodging casts; `import` /
  `export`, never `require`. Imports are extensionless (`Bundler` resolution).
- **100% vitest coverage** — lines, branches, functions, statements — on every
  touched, non-preview package. A line you cannot cover is a line you should not
  have written.
- **Errors carry codes.** Every failure is a `LestoError` subclass with a stable,
  machine-readable `code` and a frozen `details` bag. Callers branch on `code`,
  never on a message string.
- **Inject what varies.** Time is a `Clock`, the database is an interface, a poll
  loop's `sleep` is a parameter. Tests are deterministic — no real waiting.
- **Estate is the living dogfood.** A change that touches runtime behavior or
  public surface must be wired into `examples/estate` in the *same* change, and
  estate must keep building. Estate lagging the architecture means the change is
  not done.
- **Code reads like poetry.** Generous vertical spacing, one idea per line, early
  returns over nesting, comments that explain *why*.

`packages/queue` is the reference implementation — when in doubt, match it.

## Running the gate

Run the full gate from the repository root before you open or update a PR. It is
exactly what CI runs:

```sh
bun run ws:typecheck       # strict tsc across every @lesto/* package
bun run ws:lint            # oxlint
bun run ws:format:check    # oxfmt --check (the formatter owns whitespace)
bun scripts/coverage-gate.ts   # serial 100%-coverage gate
```

The coverage gate runs each package's `test:cov` **serially** on purpose — Bun's
`--filter` runs every package concurrently with no throttle, and v8 coverage
instrumentation oversubscribes the CPU enough to make timing-sensitive tests
report flaky *coverage %*. Serial is what makes the gate reproduce 100% on a busy
CI runner.

To fix formatting, **let the formatter own it** — never hand-fight whitespace:

```sh
bun run --filter '@lesto/*' format   # writes oxfmt's formatting
```

Per-package, while iterating on one module:

```sh
cd packages/<name>
bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```

## Commits and pull requests

- **Work in conventional commits**, one focused change per commit:
  `type(scope): summary` (e.g. `feat(queue): …`, `fix(auth): …`,
  `docs(guide): …`, `chore(release): …`).
- **Keep the subject one line.** Put detail in the body.
- **Keep the gate green.** A PR that reds any of the four commands above will not
  merge.
- **Wire estate** in the same PR when you change behavior or surface.
- **Describe the change**: what it does, why, and how you verified it (which gate
  commands you ran). The PR template prompts for this.

We review for correctness, adherence to the bar, and whether the change keeps the
pitch *true by default*. Small, focused PRs get reviewed fastest.

## Reporting bugs and proposing features

- **Bugs** — open an issue with the bug template: a minimal reproduction, what
  you expected, and what happened. A failing test is the best bug report.
- **Features** — open an issue with the feature template first so we can align on
  the design before code. Lesto is opinionated and batteries-included; a feature
  that fits the substrate-first, interface-driven model lands faster.
- **Security** — do **not** open a public issue. Follow
  [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).
