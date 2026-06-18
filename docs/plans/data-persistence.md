# Data & Persistence — v1 plan

Derived from `docs/reviews/data-persistence.md`, reconciled with `docs/ROADMAP-V1.md` (which rules).
Packages: `@lesto/db`, `@lesto/pg`, `@lesto/migrate`, `@lesto/cache`, `@lesto/storage`, `@lesto/queue`,
`@lesto/pubsub`, `@lesto/workflows`, `@lesto/admin` (+ deletion of `@lesto/orm`).
ADR 0013 durable stores are **done** — verified in code and CI; nothing here re-lists that work.
This plan **owns the Postgres dialect layer** for the whole repo; other plans reference it.

**The bar, every increment:** TS/ESM/Bun; oxlint/oxfmt clean; 100% vitest coverage on touched
packages; `bun run ws:typecheck` + the serial coverage gate green; coded errors; truthful doc
comments; one conventional commit on `main`.

## Increments (ordered)

1. **The dialect layer** — `[Wave 1 | P0 | blocker #6]`
   Files: `packages/db/src/ddl.ts` (`Dialect = "sqlite" | "postgres"` parameter on `createTableSql`: `AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY`; epoch-ms columns → `BIGINT`), threaded through `packages/migrate` (see item 4), `packages/queue/src/queue.ts:36` (`installSchema`), `packages/cache/src/sql-store.ts:17` (`installCacheSchema`, int4 fix), `packages/workflows` (`installWorkflowSchema`). Fix `LIMIT -1` rendering (`packages/db/src/queries.ts:139` — bare `OFFSET`/`LIMIT ALL` on PG). Follow the pattern `@lesto/ratelimit` already proves (`packages/ratelimit/src/sql-store.ts:28`).
   Acceptance: every schema installer + the migrator runs in the `db-parity-postgres` CI job against real Postgres; the hand-written per-dialect DDL workarounds in `packages/integration/test/db-parity.integration.test.ts:35` and `durable-stores.integration.test.ts:12` are deleted; offset-without-limit parity-tested.

2. **Postgres-safe queue claim** — `[Wave 1 | P0 | blocker #7]`
   Files: `packages/queue/src/queue.ts` — `FOR UPDATE SKIP LOCKED` inside the claim subselect on PG; fence `complete()`/`fail()` with `AND status = 'running' AND locked_until = ?` (claim lock as fencing token; 0 changes = lost the claim, do nothing); route poison-payload `JSON.parse` failures through `fail()` so `maxAttempts` applies.
   Acceptance: a 12-concurrent-workers claim test in the PG CI leg admitting each job exactly once (mirror the rate-limit atomicity proof); a stalled-worker-then-fail test proving a completed job is never resurrected; poison-row test terminates at `maxAttempts`.

3. **Migration lock + fleet boot mode** — `[Wave 1 | P1]`
   Files: `packages/migrate/src/migrator.ts` (`pg_advisory_lock` on PG behind a seam method; SQLite relies on the FIFO single connection — documented), `packages/kernel/src/kernel.ts` (`migrations: "skip"` boot option for fleets; coordinate the kernel touch with core-runtime).
   Acceptance: concurrent-boot integration test (two migrators, one PG) — one runs, one waits, zero DDL collisions.

4. **Delete `@lesto/orm`; one DDL system** — `[Wave 1 | P1]`
   Remove `packages/orm` entirely (zero consumers, verified). Fold `@lesto/migrate`'s string-building `TableBuilder` into schema-as-value DDL: migrate keeps ordering/bookkeeping + `s.execute(createTableSql(table, dialect))`; the `references("category")` pluralization footgun dies with it.
   Acceptance: workspace compiles; coverage gate shrinks; ADR 0004 Phase 7.6 (data half) marked done.

5. **`db.raw(sql, params)` + condition vocabulary** — `[Wave 1 | P1]`
   Files: `packages/db/src/queries.ts` (parameterized raw escape hatch beside the unparameterized `exec`), `packages/db/src/conditions.ts` (add `gt/lt/gte/lte/inList/like`).
   Acceptance: parity-tested on both drivers; `exec` doc comment warns it is DDL-only and points at `raw`.

6. **Admin hardening** — `[Wave 3 | P1]`
   Files: `packages/admin/src/admin.ts` — `list()` gains `limit`/`offset` (default page size) and projects only `fields` + pk; optional `onMutation(event)` audit hook (actor, resource, id, patch); map `DB_EMPTY_UPDATE` to an admin-coded error. Wire estate's admin routes through the hook as the dogfood.
   Acceptance: pagination + projection + hook covered; estate audit events observable in tests.

7. **Storage S3/R2 backend** — `[Wave 3 | P1]`
   Files: new `packages/storage/src/s3.ts` — fetch + SigV4, no SDK; `url()` (public + presigned) on the facade; mark memory/file backends "local/dev only" in the package docs.
   Acceptance: backend runs under a Workers-shaped runtime (no node:fs/Buffer); signed-request fixtures pinned; traversal guard parity with `FileBackend`. (edge-deploy's remote `ReleaseStore` builds on this SigV4 core — coordinate, don't duplicate.)

8. **Observability seams** — `[Wave 4 | P1]` (seams owned here; OTLP wiring owned by operability-dx item 3)
   Files: `packages/db` (`onQuery({ sql, durationMs })` on `createDb`), `packages/queue` (`onJob` hook; coerce `stats()` counts via `Number()` for PG int8; add queue-depth + oldest-ready-age), `packages/workflows` (`onStep`), `packages/runtime/src/worker.ts` (forward `onError` — today it is silently dropped).
   Acceptance: each seam covered with a fake sink; `runWorker` poll-loop faults reach the sink by default (structured stderr).

9. **Workflows honesty** — `[Wave 5 | P1 pre-launch doc fix; build post-1.0]`
   Pre-launch: rename the package claim to "resumable step memoization"; document that `run()` must be re-invoked with the same runId; `INSERT … ON CONFLICT DO NOTHING` + re-read on the step-journal race (cheap correctness).
   Post-1.0 (deliberate deferral): `lesto_workflow_runs` journal, queue-backed resume driver, durable sleep-as-step, `waitForEvent`.

10. **Scheduler constraint** — `[Wave 5 | P1 doc; build post-1.0]`
    Pre-launch: document single-scheduler-instance as a hard deployment constraint (cron dedupe is in-process memory).
    Post-1.0: persisted, atomically-claimed cron firings.

11. **Retention & sweeps** — `[Wave 5 | P2]`
    `queue.prune(olderThanMs)`, `cache.sweep(now)` (pattern exists in ratelimit), reclaim on its own cadence instead of per-poll, partial index `WHERE status='ready'` on PG, session/rate-limit sweep wiring — one scheduler-recipe increment.

## Owned elsewhere (do not duplicate)

- Kernel default-wiring of `sqlSessionStore`/`sqlRateLimitStore` → **auth-security** item 5.
- `content-store` transactional persist → **content-cms** item 2.
- Tracer construction + flush lifecycle → **operability-dx** item 3.

## Deferred post-1.0 (deliberate)

- Pub/sub PG transport (LISTEN/NOTIFY): pre-launch the docs rescope `@lesto/pubsub` as in-process events and drop the fictional `test/durability-demo.js` citation (Wave 5 docs truth-up); the transport is a post-1.0 ADR. Listener-failure aggregation lands with it.
- Canonical `SqlDatabase` seam consolidation (8+ declarations) — post-1.0 alongside the error-code registry; ADR 0013 explicitly accepted the duplication for now.
- Cache `set(undefined)` coalescing; storage `list(prefix)` subtree descent; migrate identifier quoting unification — batch as a post-1.0 polish PR.
