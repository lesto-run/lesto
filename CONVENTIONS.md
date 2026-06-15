# Keel Engineering Conventions

The bar, written down. `packages/queue` is the reference implementation — every other
module migrates to match it.

## Estate is the living dogfood — update it WITH every change

`examples/estate` is the canonical proof the framework works end-to-end and the surface
we actually test against. **Every feature or refactor MUST keep estate current in the
SAME change — never as a follow-up:**

- Add or change a battery / API / seam → wire it into estate so it's exercised, and keep
  estate **building** (`cd examples/estate && KEEL_DEMO=1 bun run build`) with its tests +
  the scaffold/e2e green.
- Delete or migrate surface → migrate estate off it in the same change; estate must never
  depend on something you removed.
- A change that leaves estate broken or lagging the architecture is **NOT done**, even if
  every package gate is green. Estate lagging is exactly how "passes the unit tests, broken
  in a real app" ships.

Estate is where a regression or an awkward API shows up first. Keep it real, keep it current.

## Toolchain

| Concern | Choice |
|---|---|
| Language | **TypeScript** (latest), strict everywhere |
| Modules | **ESM** only — `import` / `export`, never `require` |
| Runtime | **Bun** (latest); target **Node ≥ 22** for compatibility |
| Lint | **oxlint** (`.oxlintrc.json`) |
| Format | **oxfmt** — the formatter owns whitespace; never hand-fight it |
| Tests | **vitest**; coverage via `@vitest/coverage-v8` |
| Coverage | **100%** lines / functions / branches / statements — enforced in `vitest.config.ts` thresholds |

Packages run their TypeScript **directly** (Bun + vitest); `exports` point at `./src/index.ts`.
Module resolution is `Bundler`, so imports are extensionless.

## TypeScript settings (tsconfig.base.json)

`strict` plus: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`,
`verbatimModuleSyntax`, `isolatedModules`.

- **No `any`.** Use `unknown` + a narrowing guard, or a precise generic.
- **No casts to dodge the type system.** A cast must be *true* (e.g. a DB row to its `Row` type).
- Type-only imports use `import type` (enforced by `verbatimModuleSyntax`).

## Errors carry codes

Every failure is a `KeelError` subclass with a stable, machine-readable `code` and a frozen
`details` bag. Logs, tests, API responses, and the MCP surface branch on `code` — **never** on a
message string. Messages are for humans and may change freely.

```ts
throw new QueueError("QUEUE_HANDLER_NOT_FOUND", `No handler for job "${name}".`, { name });
```

## Logs

- **Server & CLI logs are first-class output**, not debug noise. Structured, leveled, and quiet by
  default; an operator should be able to read them like prose.
- Each log line states *what happened* and carries the ids needed to act (`job_id`, `queue`, `code`).

## Distributed-systems defaults

- **At-least-once, idempotent by convention.** Anything that can run twice is written to be safe to
  run twice (visibility-timeout reclaim means a crashed worker's job re-runs).
- **State lives in the database**, never in process memory — so the web/worker tier is stateless and
  deploys are zero-downtime rolling restarts.
- **Graceful drain** on `SIGTERM`: stop accepting, finish in-flight, exit.
- **Depend on interfaces, not drivers** (`SqlDatabase`, not better-sqlite3) so the substrate can swap
  (SQLite → Postgres) without touching callers.

## Testability

- **Inject what varies.** Time is a `Clock`, the database is an interface, the poll loop's `sleep` is
  a parameter. Tests are deterministic; no real waiting, no flakiness.
- **Separate deciding from timing.** The scheduler's `tick(now)` is pure logic, fully tested; `start()`
  is the thin timer wire.
- 100% coverage is the floor — a line we cannot reach is a line we should not have written.

## Readability — code should read like poetry

- Not a character or line out of place. **Generous vertical spacing**: a blank line between logical
  beats inside a function, between methods, around control flow.
- One idea per line. Early returns over nesting. Guard clauses up top.
- Prefer pure transformations (`map`/`filter`/`reduce`) over mutable accumulators, except where a hot
  path demands it — and then say why in a comment.
- Comments explain *why*, set the frame, and name the invariant. They earn their place or they go.
- Names read as plain English: `reclaim`, `visibilityMs`, `lockedUntil`, `runOnce`.

## Migration status

| Module | State |
|---|---|
| `@keel/queue` | ✅ reference: TS · ESM · 100% coverage · oxfmt-clean |
| `@keel/orm` | ❌ DELETED — superseded by `@keel/db` (schema-as-value + async query layer); see ADR 0004 |
| `@keel/mail` | ✅ `defineMailer`, queued delivery on `@keel/queue`, 100% coverage |
| `@keel/webhooks` | ✅ signed delivery + inbound verify on `@keel/queue`, 100% coverage |
| `@keel/cache` | ✅ TTL cache, memory + SQL stores, injected clock, 100% coverage |
| `@keel/hooks` | ✅ actions/filters extensibility core, 100% coverage |
| `@keel/migrate` | ✅ Tracks-style migrator over `@keel/db` value-DDL on a `SqlDatabase` interface, 100% coverage |
| `@keel/router` | ✅ RESTful router (`resources`, named routes), 100% coverage |
| Tracks server (`lib/*` router/controller/migrations, CJS) | ⏳ remaining to port → `packages/*` |
| Loom (`loom/*`, JS) | ⏳ to port → `packages/*` |
| Docks (`@usedocks/*`) | already TS/ESM/oxlint/vitest — folds into the same workspace |
