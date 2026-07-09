# Lesto monorepo — agent guide

This is the source repository of [Lesto](https://lesto.run), the
batteries-included, agent-native fullstack TypeScript framework. Published
packages live under `packages/*` as `@lesto/*`. Source runs directly under Bun
(`exports` point at `./src/index.ts`) — there is no build step for the source.

[CONVENTIONS.md](./CONVENTIONS.md) **is** the engineering bar;
[CONTRIBUTING.md](./CONTRIBUTING.md) is setup + the gate;
[ARCHITECTURE.md](./ARCHITECTURE.md) is the canonical system map. This file is
the condensed, agent-oriented tour plus the traps that have actually cost time
here.

## Map

- `packages/*` — the `@lesto/*` batteries. `packages/queue` is the reference
  implementation: when in doubt about style or structure, match it.
- `examples/` — runnable apps. **`examples/estate` is the living dogfood**: a
  change to runtime behavior or public surface must be wired into estate in the
  same change, and estate must keep building.
- `packages/e2e` — Playwright e2e: scaffold loops, real-registry install
  smokes, the agent-activation gate. `dev-harness.ts` owns the spawn/probe
  discipline — reuse it, never hand-roll a dev-server spawn in a spec.
- `packages/create-lesto` — the scaffolder. Template content lives in
  `src/templates.ts` as pure functions; every generated app ships `AGENTS.md`,
  `CLAUDE.md`, and a `.claude/skills/lesto` skill.
- `site/` (docs.lesto.run) and `www/` (lesto.run) — both are Lesto apps.
- `docs/adr/` — architecture decisions. **Check an ADR's `Status` line before
  building on it** (Proposed ≠ shipped). `docs/plans/` — build plans.

## Commands (the gate — CI runs exactly this)

Bun 1.3.5 (pinned via `packageManager`) + Node ≥ 22. Then:

```sh
bun install
bun run ws:typecheck            # strict tsc across every @lesto/* package
bun run ws:lint                 # oxlint
bun run ws:format:check         # oxfmt --check — the formatter owns whitespace
bun scripts/coverage-gate.ts    # serial 100%-coverage gate
```

The coverage gate is **serial on purpose** — parallel `--filter` + v8 coverage
oversubscribes the CPU and flakes coverage percentages. Never "optimize" it.

Per package while iterating:

```sh
cd packages/<name>
bun run typecheck && bun run lint && bun run format:check && bun run test:cov
```

To fix formatting, run `bun run --filter '@lesto/*' format` — never hand-fight
whitespace.

## The bar (condensed — CONVENTIONS.md is authoritative)

- **Strict TypeScript, ESM only.** No `any`, no type-dodging casts,
  extensionless imports (`Bundler` resolution).
- **100% vitest coverage** (lines, branches, functions, statements) on every
  touched, non-preview package.
- **Errors carry codes.** Every failure is a `LestoError` subclass with a
  stable `code` and a frozen `details` bag. Branch on `code`, never on a
  message string.
- **Inject what varies.** Time is a `Clock`, the database is an interface, a
  poll loop's `sleep` is a parameter. Tests never really wait.
- **Commits are conventional**: `type(scope): summary`, one-line subject.

## Traps that have really bitten (check these before "fixing the product")

- **Vacuous tests.** An assertion that can never fire (absence checks,
  `not.toMatch`, a positive assert neutered by a stubbed double) is decorative.
  Construct the failure case and watch the test go RED before you trust it.
- **Fetch-blocked dev ports.** Never boot a dev server on a WHATWG
  restricted port (4190 cost days): undici `fetch()` and browsers refuse it
  pre-connect with `cause: "bad port"` while curl/`node:http` succeed — a
  perfect false-oracle split. `spawnDev` enforces `assertFetchablePort`; keep
  using it. When a fetch fails strangely, read `error.cause` first.
- **Undrained child pipes.** An unread `stdio: "pipe"` stream stalls a chatty
  long-lived child (a dev server) and masquerades as a product hang. Drain
  stdout+stderr and record the child's exit before theorizing.
- **CSRF on by default.** A non-browser `POST` (curl, `fetch` in a script)
  must send `Sec-Fetch-Site: same-origin` or the kernel's `originCheck`
  refuses it with 403. That's the feature working.
- **pg integration tests share one database** (`fileParallelism: false`).
  Teardown must drop every related table, or reused IDENTITY ids collide in a
  pg-only "product bug" that is really test isolation.
- **`rg` skips hidden directories** by default — audit `.github/` with
  `grep -r`.

## Keeping origin/main current (local infra)

The Studio daemon commits to `main` via `commit-tree` + `update-ref`, which does
**not** fire git hooks — so a post-commit push hook can never cover
daemon-authored commits, and origin/main once silently fell 51 commits behind
(L-f9ac64d8). The backstop is a per-user launchd agent that fast-forward-pushes
`main` every 120s regardless of author:

```sh
scripts/dev/install-push-agent.sh              # install / reinstall (idempotent)
scripts/dev/install-push-agent.sh --uninstall  # remove
```

The agent and its logic (`scripts/dev/push-main.sh`) are version-controlled;
only the generated plist is machine-local (it bakes in this clone's path), so
**re-run the installer after a fresh clone / on a second machine** or the
backstop is silently absent. The push is fast-forward-only (never `--force`), so
it cannot rewrite published history. Before each push it runs
`scripts/dev/secret-scan.sh` over the outgoing commits (`origin/main..main`) and
REFUSES to push — with an alert — if a likely secret would reach the public
origin (gitleaks when installed, else high-signal credential patterns;
L-e19bda73). A push that fails 3× in a row — for ANY reason (expired
credential / dead SSH key, a branch-protection reject, or a non-FF divergence) —
is logged to `~/.studio/push-main.log` and raises a rate-limited desktop alert,
and every success stamps
`~/.studio/.push-main-last-success` for a dead-man check. It supersedes the
interactive-only post-commit push hook (which can't see the daemon's
`update-ref` commits — that hook block is now redundant). **Before cutting a
release, quiesce it** — `touch ~/.studio/.push-main-paused` (lightest), or
`--uninstall` / `launchctl bootout` — so it can't advance `main` mid-CI and
cancel the release SHA's run (see RELEASING.md).

## Agent-facing surfaces (dogfood them)

- `lesto dev` boots a loopback **MCP control plane** — one stderr banner gives
  the URL and `x-lesto-dev-token`; sessions are read-only by default; call
  `describe_app` first. A scaffolded app's `AGENTS.md` documents the full
  recipe; the nightly `agent-activation` workflow proves the loop end-to-end
  on the published closure.
- Docs are agent-readable: https://docs.lesto.run/llms.txt, and every docs
  page has a Markdown twin at its path + `.md`.
