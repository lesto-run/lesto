# ADR 0006 — Async data layer (the Postgres-backable substrate)

- **Status:** Accepted (design); implementation in progress
- **Date:** 2026-06-10
- **Supersedes the sync assumption of:** ADR 0004 (`@keel/db` stays the data layer; only its driver seam goes async)
- **Relates to:** ADR 0004 (`@keel/db` query layer), ADR 0005 (validation at the boundary); `docs/readiness/PLAN.md` Phase 1; `docs/readiness/2026-06-10.json`
- **Coordination:** in-flight `keel()`-router rewrite of `@keel/router` + `@keel/web` (see "Kernel ↔ router coordination" below)
- **Origin:** designed via a 5-agent adversarial panel (2 drafts → 2 critics → synthesis); full record in `docs/readiness/keystone-async-design.json`.

## Context

`@keel/db`'s driver seam is **synchronous**: `SqlStatement.run/get/all` return values and `SqlDatabase.exec` returns a value (`packages/db/src/sql.ts`). The same shape is re-declared, structurally, in **eight** independent places — `packages/db/src/sql.ts`, `packages/migrate/src/types.ts`, `packages/cache/src/types.ts`, `packages/queue/src/types.ts`, `packages/workflows/src/types.ts`, `packages/orm/src/types.ts`, `KernelDatabase` in `packages/kernel/src/kernel.ts`, and the raw `SqliteHandle` in `packages/runtime/src/sqlite.ts`.

A synchronous seam can only ever be backed by an in-process engine (better-sqlite3 / bun:sqlite). A networked Postgres pool — the #1 production-readiness blocker — speaks over a socket and is fundamentally asynchronous. There is **no honest way to back a synchronous surface with a network pool** short of a sync-over-async shim (`deasync`, `Atomics.wait`), which re-introduces event-loop blocking — the exact footgun this work exists to remove.

We must flip the I/O boundary to Promises and propagate `await` through every consumer, then add an additive Postgres adapter.

## Decision

### 1. The async seam (no sync escape hatch)

All four driver I/O verbs become Promise-returning; `prepare()` **stays synchronous** (it only builds a statement handle — binding + execution is what touches the wire). We add a **first-class `transaction()`** primitive to the seam now, rather than leaving transactions to raw `exec("BEGIN")` string DDL.

```ts
export interface SqlStatement {
  run(params?: unknown[]): Promise<{ changes: number; lastInsertRowid?: number | bigint }>;
  get(params?: unknown[]): Promise<unknown>;
  all(params?: unknown[]): Promise<unknown[]>;
}

export interface SqlDatabase {
  exec(sql: string): Promise<void>;                                // was `unknown`; no caller reads it
  prepare(sql: string): SqlStatement;                              // STAYS SYNC
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>; // NEW — first-class
}
```

Decisions baked into the seam:

- **`prepare()` stays sync.** `packages/cache/src/sql-store.ts` caches four prepared statements at `sqlStore()` construction time; forcing `prepare()` async would require top-level `await` in a synchronous factory. Keep `prepare()` sync, terminals async. The Postgres adapter makes `prepare()` *lazy* (translate-and-cache on first terminal call).
- **`exec()` settles to `Promise<void>`** — verified no product code reads `exec()`'s return.
- **`lastInsertRowid` becomes OPTIONAL.** Postgres has no implicit row id. Making it required would force the PG adapter to synthesize `NaN`/`0` for plain inserts. The only consumer that reads it is `@keel/queue.enqueue` (`queue.ts:200`), which moves to `RETURNING id` (see §4).
- **`transaction(fn)` is added NOW, not deferred.** The migrator needs atomic per-migration BEGIN/COMMIT/ROLLBACK. On a `pg.Pool`, three separate `exec("BEGIN")`/`exec("COMMIT")`/`exec("ROLLBACK")` calls land on *different pooled connections* — so the transaction silently no-ops while SQLite (single connection) hides the bug. `transaction(fn)` pins one connection for the whole span. This is a correctness requirement, not a convenience.
- **No sync-over-async shim, ever.** Any `getSync()`-style backdoor must be rejected in review.

### 2. `@keel/db` terminals

The six terminals in `packages/db/src/queries.ts` become `async` and `await` the driver: `SelectQuery.get/all/count`, `InsertValues.run`, `InsertReturning.get`, `UpdateSet…run`, `DeleteBuilder…run`, plus `Db.exec`. The public `Db` type's terminals return Promises:

```ts
get(): Promise<InferRow<T> | undefined>;
all(): Promise<InferRow<T>[]>;
count(): Promise<number>;
run(): Promise<{ changes: number }>;       // insert/update/delete
returning().get(): Promise<InferRow<T>>;
exec(sql: string): Promise<void>;
```

Pure value code is **byte-for-byte unchanged**: `bind`, `hydrate`, `renderSelect`, `compileInsert`, `quoteIdentifier`, columns, conditions, table. Chain *modifiers* (`where`/`orderBy`/`limit`/`offset`, `.values`, `.set`, `.returning`) stay synchronous and return builders; only the terminal verbs `await`. `createDb(sql)` keeps its signature — it only wires closures.

### 3. SQLite driver plan (the dev default, stays zero-config)

The two SQLite engines are synchronous; they present the async interface by trivially wrapping each terminal in an already-resolved Promise. Adaptation stays in `packages/runtime/src/sqlite.ts` `openSqlite()`. `SqliteHandle` (the raw engine shape) and `sqlite-drivers.ts` (the coverage-excluded native loader) are **unchanged** — only the wrapper gains `async`:

```ts
const db: KernelDatabase = {
  exec: async (sql) => { raw.exec(sql); },
  prepare: (sql) => {
    const statement = raw.prepare(sql);                 // sync, once
    return {
      run: async (params = []) => statement.run(...params),
      get: async (params = []) => statement.get(...params),
      all: async (params = []) => statement.all(...params),
    };
  },
  transaction: async (fn) => {
    raw.exec("BEGIN");
    try { const out = await fn(db); raw.exec("COMMIT"); return out; }
    catch (e) { try { raw.exec("ROLLBACK"); } catch { /* preserve original */ } throw e; }
  },
};
```

`async`-wrapping a sync return yields a resolved Promise — zero added latency on the dev path. SQLite is single-connection, so `transaction()` over one handle is correct; nested/concurrent transactions are an explicit non-feature on SQLite (the migrator runs serially). The injected `SqliteEngines` fakes stay **sync**; the wrapper makes them async, so the better→bun fallback branch stays covered under Node without ever loading `bun:sqlite`.

### 4. Postgres adapter plan — new `@keel/pg`

A new, additive package `packages/pg` peer-depending on `pg` (node-postgres), a sibling to `openSqlite` (keeps `@keel/db` driver-free). Exports `openPostgres(config): Promise<{ db: SqlDatabase; close: () => Promise<void> }>`, mirroring `OpenSqlite`'s shape.

- **Placeholder translation (the one PG-specific concern the seam owns):** `@keel/db`/`@keel/migrate` emit SQLite-style positional `?`. `prepare(sql)` translates `?` → `$1..$n` in a single left-to-right pass, skipping `?` inside string literals/comments (defensive — Keel only ever interpolates owned identifiers; every value rides `?`). Memoized per prepared sql string. Lives in one function (`src/translate.ts`), unit-tested exhaustively.
- **Lazy prepare:** `prepare(sql)` returns a statement closure; first terminal call translates + caches text and a stable `name` for pg's server-side prepared-statement cache. `run` → `pool.query({ text, values, name })`; `get` → `rows[0] ?? undefined`; `all` → `rows`.
- **`lastInsertRowid` reconciliation:** the adapter exposes `lastInsertRowid` only when a statement `RETURNING id` produced a row (`rows[0].id`); otherwise `undefined`. SQLite supplies it natively; **Postgres requires `RETURNING id`**. `@keel/queue.enqueue` adds `RETURNING id` to its INSERT (§ consumer ripple). `@keel/db`'s plain `insert.run()` returns only `{ changes }` (safe), and `.returning().get()` already emits `RETURNING *` which PG honors natively.
- **`transaction(fn)`:** checks out ONE client via `pool.connect()`, `client.query("BEGIN")`, builds a tx-scoped `SqlDatabase` bound to that single client so every query in `fn` runs on the same connection, then COMMIT/ROLLBACK and `client.release()` in `finally`. This is the pool-correct transaction; the SQLite version is the degenerate single-connection case.
- **Row/type mapping:** pg returns snake_case keys matching our DDL, so `hydrate()` (snake→camel) works unchanged. `count()` already does `Number(row.c)`, coercing pg's string-typed `COUNT(*)`. Register an `int8`→Number type parser as a guard (no BIGINT columns today).
- **Real `new Pool()` wiring is quarantined** in a tiny `src/pg-driver.ts` excluded from coverage, mirroring the existing `sqlite-drivers.ts` exclusion — so `@keel/pg`'s 100% gate is reachable against a fake Pool with no live container.

### 5. Migrator + `createApp` async ripple

**`@keel/migrate`:** `migrate()/rollback()/status()` return Promises; `ensureTable`/`appliedVersions` await; `Schema` methods (`createTable`/`dropTable`/`addColumn`/`addIndex`/`execute`) become `async` (each is one `await this.db.exec(...)`). The hand-rolled `exec("BEGIN")…COMMIT/ROLLBACK` loop is **replaced** with `await this.db.transaction(async (tx) => { ... })`, building a `Schema` bound to `tx`.

**The `up()/down()` DDL-ordering trap (must be fixed here, not just named):** existing migration bodies are synchronous and issue *multiple sequential* `schema.*` calls with no `await` (e.g. `content-store/src/migration.ts` does `createTable` then three `addIndex`; `identity/user.ts`, `mailing-lists/models.ts` call `schema.execute` twice). Once `Schema` methods return Promises, a sync `up()` fires **unawaited** Promises — on SQLite the resolved-Promise microtask ordering hides it, but on Postgres `CREATE INDEX` can hit the wire before `CREATE TABLE` resolves → "relation does not exist", and the bookkeeping INSERT can race the DDL. Resolution (both halves required):

1. Widen the callback signature: `Migration.up(schema): void | Promise<void>` and `down?(schema): void | Promise<void>`; the migrator `await`s the result.
2. **Rewrite every existing migration body** to `async up(schema)` + `await schema.x(...)` for each call (content-store, identity, mailing-lists, plus any in `create-keel` templates / examples / cli fixtures).

**`createApp` (`packages/kernel/src/kernel.ts`):** becomes `async` because migration is now awaited:

```ts
export async function createApp(config: AppConfig): Promise<App> {
  const migrationsApplied = config.migrations === undefined
    ? [] : await new Migrator(config.db, config.migrations).migrate();
  // ...construct the web core AFTER migrations resolve...
}
```

`KernelDatabase` is updated to the async seam. `App.handle` is already `Promise<KeelResponse>` — unchanged.

### Kernel ↔ router coordination (do NOT design their side)

A concurrent agent is rewriting `@keel/router` + `@keel/web` into a code-first `keel()` router that **deletes `Application`/`Controller` and reshapes `AppConfig`**. `createApp`'s body (`new Application({...})` + the `Migrator` call) is *exactly* the function they are replacing — so this is a **merge-collision function, not a divisible seam**. The honest contract this ADR fixes (everything else is theirs):

1. **Migrations are now awaited.** Whatever boot path replaces `createApp` MUST be `async`/return a Promise and must construct the web core *after* `await migrator.migrate()`.
2. **The db seam is async.** `AppConfig.db` stays the `SqlDatabase` seam (now Promise-returning). Handlers that call `db…get()/.all()/.run()/.count()` must add `await` — a pure additive `await`, no shape change to what a query returns.
3. **Identity methods are now async** (see §6): handlers calling `login`/`currentUser`/`verifyEmail` must `await`.
4. **Ownership:** whoever lands second owns the final `createApp`/boot rewrite. This work lands the type-only `KernelDatabase` flip and the await-migrate body; if the router rewrite lands first, this work rebases its await-migrate onto their boot fn. Do not race two diffs on the same lines — sequence the merge.

### 6. Consumer ripple — and where the gate CANNOT stay green incrementally

Critical, verified reality: consumer test suites boot a **real `better-sqlite3`** and drive either the real `createDb` (`identity`, `admin`, `mailing-lists`) or the package's own real DB functions / a raw engine cast as `SqlDatabase` (`queue`, `cache`, `workflows`, `content-store`). **`test:cov` is `vitest run --coverage` with NO `tsc`**, and workspaces symlink to `./src` (no build). Therefore a half-flipped seam does **not** produce a compile error — it leaks an unawaited Promise that fails value assertions at runtime. Draft A's "green after each commit" is **false** for these consumers.

The minimal green-preserving units are:

- **Independently flippable (own their seam + own sqlite wrapper, not driven via real `createDb`/`Queue`):** `@keel/migrate`, `@keel/cache`, `@keel/content-store`, `@keel/workflows`, `@keel/runtime`(openSqlite), and the new `@keel/pg`. Each can land green on its own commit.
- **ONE atomic commit — `{@keel/db + @keel/queue + @keel/identity + @keel/admin + @keel/mailing-lists}` + their tests** — because: `identity`/`admin`/`mailing-lists` drive the real `createDb` and break the instant db terminals return Promises; `mailing-lists` *also* drives the real `Queue` (`installSchema` + `Queue`), coupling the queue flip into the same unit. No `tsc` means the breakage is a silent runtime Promise-leak, caught only by value assertions — so these cannot be split.
- **`@keel/identity` public interface break:** `verifyEmail`, `login`, `currentUser` are **synchronous** today (interface lines 210–215) and call repo helpers that become async — they MUST become async (`verifyEmail(): Promise<User>`, `login(): Promise<{user,session}>`, `currentUser(): Promise<User|undefined>`). This is the cross-agent signal in §5(3).
- **`@keel/queue` named→positional normalization (in scope, not optional):** queue is the ONLY consumer using named params (`@queue`, `@now`, …) over `Record<string,unknown>` (`queue/types.ts:76`), which is why it is wired to a raw engine, not `openSqlite` (whose `...params` spread cannot bind named objects). pg binds `$n` positionally. Convert queue to positional `?` + arrays, repeating reused values at each position, and add `RETURNING id` to `enqueue`.
- **`@keel/orm` is a dead but gated seam:** it has `test:cov` but is imported by no consumer. A careless global seam edit will red its gate. Either flip its `types.ts` to async in lockstep, or leave it untouched (it is self-contained) — but it must be consciously handled, not forgotten.

### 7. Test matrix (keep the gate green; prove parity separately)

- **Coverage gate (`scripts/coverage-gate.ts`, serial, Node/vitest, no container):** unchanged in scope. The async flip does not change which branches exist — `get()`'s `row == null` hit/miss still both execute behind `await`. Each suite's existing real-better-sqlite3 / fake engine executes every line; assertions add `await`. The `bun:sqlite` branch still never runs under Node and stays covered via sync `SqliteEngines` fakes. `transaction()` commit + rollback branches are covered with a fake that throws to force ROLLBACK. `@keel/pg` reaches 100% against a **fake Pool** (stub `query`/`connect`/`release`); real `new Pool()` is in the coverage-excluded `pg-driver.ts`.
- **Parity (NON-gated, its own CI step, like `@keel/integration`/`@keel/e2e`):** a cross-driver conformance suite — ONE test body, `describe.each([openSqlite, openPostgres])` — covering insert→get, all+orderBy+limit+offset, count, update/delete change-counts, transaction commit-visible / rollback-invisible, `?`→`$n` round-trip with a reused-position param, `RETURNING id`→`lastInsertRowid`, snake→camel hydrate, null/boolean binding. Plus the identity register→verify→login and queue enqueue→claim→complete journeys on both engines. The Postgres leg is gated behind `KEEL_PG_URL` (skipped locally) so the coverage gate never depends on a container.

## Consequences

- A single, honest async substrate; Postgres becomes backable without a blocking shim.
- Wider ripple: every db consumer + `createApp` + every `createApp` caller goes async.
- New correctness surface (interleaving, cancellation) — see hazards/open questions.
- `@keel/pg` lands additively; the SQLite dev default is untouched and stays zero-config.
- Real PG portability is **not complete** at the end of this work: SQL dialect drift (`LIMIT -1`, `AUTOINCREMENT`, `FOR UPDATE SKIP LOCKED`) is out of scope and tracked as follow-up — the parity suite will surface, not fix, these.

---

## Decisions on the design panels open questions (resolved by maintainer + main agent)

1. **AbortSignal / query cancellation** — **follow-up**, not in 0006. The pooled-connection-exhaustion-on-deadline gap is real but threading `context.signal` into the seam + pg cancellation is its own change; tracked for a later ADR. Documented as a known hazard.
2. **`createApp` ownership vs. the concurrent `keel()`-router agent** — this work lands only the **`KernelDatabase` async type-flip + await-migrate**; whoever lands the kernel/boot rewrite second owns the final `createApp`. Sequenced at Wave 3, not raced.
3. **`@keel/orm`** — **left untouched.** `@keel/db`s `sql.ts` seam is a *separate declaration* from `orm/src/types.ts`; flipping `@keel/db` does not reach orm, so its gate stays green with no work. orm remains LEGACY (ADR 0004); deletion is a separate decision.
4. **Parity CI** — the live-Postgres conformance suite is **non-gated** (behind `KEEL_PG_URL`, its own job). Recommended to be a **required check on data-layer PRs**; not unilaterally wired into shared CI while the router rewrite is in flight.
5. **Dialect drift** (`LIMIT -1`, `AUTOINCREMENT`→`SERIAL`, `FOR UPDATE SKIP LOCKED`, `ON CONFLICT`) — **explicit follow-up (ADR 0007).** Exit criterion of 0006 is *"the substrate is async and a translated PG adapter passes unit + conformance round-trips,"* **not** "real Postgres is production-complete."
6. **Driver** — default **`pg` (node-postgres)**: its `Pool`/`connect`/`release` maps cleanly onto the explicit `transaction(fn)` + pool seam. Confirm before Wave 4.


## Implementation checklist (waves)

### Wave 0 — ADR
- **Step:** Write and commit ADR 0006 (this document): async seam with sync prepare + first-class transaction(); no sync escape hatch; lastInsertRowid optional; queue named→positional + RETURNING id; up()/down() widened to Promise-capable AND existing bodies rewritten; createApp→async as a router merge-collision coordination point; the atomic-flip sequencing.
- **Files:** `/Users/ryan/crack/docs/adr/0006-async-data-layer.md (new)`
- **Acceptance:** ADR committed listing all 8 seam declarations, the atomic {db+queue+identity+admin+mailing-lists} unit, the lastInsertRowid/RETURNING reconciliation, and the keel()-router contract.

### Wave 1 — independent leaf flips (parallel) · parallelizable
- **Step:** Flip @keel/migrate: types.ts seam→async + add transaction(); Schema methods async; REPLACE exec('BEGIN')/COMMIT/ROLLBACK loop with db.transaction(async tx => …) building a tx-scoped Schema; widen Migration.up/down to void|Promise<void> and await them; migrate/rollback/status return Promises.
- **Files:** `/Users/ryan/crack/packages/migrate/src/types.ts, /Users/ryan/crack/packages/migrate/src/schema.ts, /Users/ryan/crack/packages/migrate/src/migrator.ts, /Users/ryan/crack/packages/migrate/test/*`
- **Acceptance:** @keel/migrate test:cov 100%; per-migration atomicity via db.transaction (not raw BEGIN); commit + rollback branches covered via a throwing-migration fake; migrate()/rollback() awaited in tests.

### Wave 1 — independent leaf flips (parallel) · parallelizable
- **Step:** Flip @keel/runtime openSqlite: wrap raw sync exec/run/get/all in async; implement transaction() via raw BEGIN/COMMIT/ROLLBACK on the single connection. SqliteHandle + sqlite-drivers.ts UNCHANGED; injected fakes stay sync.
- **Files:** `/Users/ryan/crack/packages/runtime/src/sqlite.ts, /Users/ryan/crack/packages/runtime/test/*`
- **Acceptance:** runtime test:cov 100%; better→bun fallback branch covered with async-wrapped sync fakes; transaction commit/rollback branches covered; bun:sqlite never loaded under Node.

### Wave 1 — independent leaf flips (parallel) · parallelizable
- **Step:** Flip @keel/cache: types.ts seam→async; sqlStore keeps eager prepare() at construction (prepare stays sync); get/set/delete/clear await terminals; installCacheSchema async; CacheStore interface + MemoryStore parity become Promise-returning; Cache facade awaits.
- **Files:** `/Users/ryan/crack/packages/cache/src/types.ts, /Users/ryan/crack/packages/cache/src/sql-store.ts, /Users/ryan/crack/packages/cache/src/index.ts, /Users/ryan/crack/packages/cache/test/*`
- **Acceptance:** @keel/cache test:cov 100% with awaited terminals; the 4 statements still cached at sqlStore() construction; MemoryStore async-shaped to match CacheStore.

### Wave 1 — independent leaf flips (parallel) · parallelizable
- **Step:** Flip @keel/content-store: imports SqlDatabase from @keel/migrate (now async); loadEntries/loadEntry/createEntry/updateEntry/deleteEntry/persistEntries/pruneEntries/hydrateRuntime become async and await prepare().all()/.run(); prune/persist loops await each statement.run sequentially. Rewrite content migration body (migration.ts) to async up/down awaiting createTable then each addIndex.
- **Files:** `/Users/ryan/crack/packages/content-store/src/{load,write,persist,hydrate,migration}.ts, /Users/ryan/crack/packages/content-store/test/*`
- **Acceptance:** @keel/content-store test:cov 100%; migration up() awaits createTable before addIndex (no dropped Promises); all helpers return Promises.

### Wave 1 — independent leaf flips (parallel) · parallelizable
- **Step:** Flip @keel/workflows: types.ts seam→async; installWorkflowSchema async; Engine #read/#write await; step memoization awaits; run loop already async.
- **Files:** `/Users/ryan/crack/packages/workflows/src/types.ts, /Users/ryan/crack/packages/workflows/src/engine.ts, /Users/ryan/crack/packages/workflows/test/*`
- **Acceptance:** @keel/workflows test:cov 100% with awaited terminals; installWorkflowSchema awaited.

### Wave 1 — independent leaf flips (parallel) · parallelizable
- **Step:** Handle @keel/orm dead seam: flip orm/types.ts SqlStatement/SqlDatabase to async (+transaction()) and await in connection/relation/model so its OWN gated suite stays green, OR consciously leave untouched if self-contained. Decide explicitly; do not let a global edit silently red it.
- **Files:** `/Users/ryan/crack/packages/orm/src/{types,connection,relation,model}.ts, /Users/ryan/crack/packages/orm/test/*`
- **Acceptance:** @keel/orm test:cov 100% (it has test:cov but no consumer); no unawaited-Promise value-shape failures in its suite.

### Wave 2 — THE ATOMIC FLIP (single commit, NOT splittable)
- **Step:** In ONE commit flip @keel/db + @keel/queue + @keel/identity + @keel/admin + @keel/mailing-lists together (they share real createDb/Queue and there is no tsc, so a partial flip leaks unawaited Promises at runtime). @keel/db: flip sql.ts seam (+transaction()), make queries.ts 6 terminals + Db.exec async; pure helpers untouched. @keel/queue: types.ts seam→async, DROP named-param Record overloads → positional unknown[], convert all SQL to ? + ordered arrays (repeat reused @now/@id), add RETURNING id to enqueue for lastInsertRowid, all methods + installSchema async. @keel/identity: user.ts repo helpers async; verifyEmail/login/currentUser become async (PUBLIC interface break). @keel/admin: list/get/create/update/destroy + fetchRow async. @keel/mailing-lists: models helpers + service + broadcast await; await the now-async Queue.
- **Files:** `/Users/ryan/crack/packages/db/src/{sql,queries}.ts, /Users/ryan/crack/packages/queue/src/{types,queue}.ts, /Users/ryan/crack/packages/identity/src/{user,identity,index}.ts, /Users/ryan/crack/packages/admin/src/admin.ts, /Users/ryan/crack/packages/mailing-lists/src/{models,*}.ts, and ALL of their test/* (flip fakes to resolved Promises + positional arrays for queue)`
- **Acceptance:** All five packages' test:cov 100% in the SAME commit; grep shows no '@'-named placeholders in queue; enqueue returns a real id via RETURNING id (no lastInsertRowid); Identity interface shows async verifyEmail/login/currentUser; queue tests use positional arrays.

### Wave 3 — kernel
- **Step:** Flip KernelDatabase to the async seam; make createApp async and await Migrator.migrate(); return Promise<App>. Treat the Application-construction body as the router merge-collision point — coordinate so only one agent rewrites it; this work owns the type flip + await-migrate.
- **Files:** `/Users/ryan/crack/packages/kernel/src/kernel.ts, /Users/ryan/crack/packages/kernel/test/*`
- **Acceptance:** @keel/kernel test:cov 100%; createApp awaited across all kernel + secure-stack tests; coordination note in ADR references the router agent's boot-fn ownership.

### Wave 4 — Postgres adapter (additive) · parallelizable
- **Step:** Build @keel/pg: pg.Pool adapter implementing the async SqlDatabase; ?→$n translator (src/translate.ts, skip string-literals/comments); lazy prepare with server-side prepared-statement names; get→rows[0]??undefined, all→rows, run→{changes:rowCount,lastInsertRowid from RETURNING id}; transaction() on a checked-out client with release in finally; int8→Number type parser guard; quarantine real new Pool() in coverage-excluded src/pg-driver.ts.
- **Files:** `/Users/ryan/crack/packages/pg/ (new: package.json, src/index.ts, src/adapter.ts, src/translate.ts, src/pg-driver.ts, test/*, vitest config excluding pg-driver.ts)`
- **Acceptance:** @keel/pg test:cov 100% against a FAKE Pool (no live DB in the gate); translator covers ?-in-string-literal skip + reused-position renumber; transaction commit/rollback + release-in-finally covered; openPostgres returns the KernelDatabase shape.

### Wave 5 — callers (after kernel)
- **Step:** Add await to every createApp caller, INCLUDING the two fire-and-forget sites cli/run.ts:165 and :219 which discard the result (must become `await createApp(config)` so migrations finish before persistEntries/deleteEntry hit the db). Await persistEntries/pruneEntries/deleteEntry. Update examples/blog, examples/estate (`return await createApp(...)`), create-keel templates, mcp/integration/kernel/secure-stack test harnesses, cli fixture keel.app.ts; rewrite any migration bodies in templates/examples to async up/down.
- **Files:** `/Users/ryan/crack/packages/cli/src/run.ts (119,137,165,169,177,219,221,272,302,347), /Users/ryan/crack/examples/blog/src/app.ts, /Users/ryan/crack/examples/estate/src/{app,identity}.ts, /Users/ryan/crack/packages/create-keel/src/templates.ts, /Users/ryan/crack/packages/mcp/test/*, /Users/ryan/crack/packages/integration/test/*, /Users/ryan/crack/packages/cli/test/fixture/keel.app.ts`
- **Acceptance:** Full coverage gate green end-to-end; no unawaited createApp anywhere (esp. run.ts:165/219 now awaited); examples boot and migrate+seed; ADR 0006 marked Implemented.

### Wave 6 — parity (non-gated) · parallelizable
- **Step:** Add the cross-driver conformance suite (ONE body, describe.each([openSqlite, openPostgres])) plus identity/queue/content journeys on both engines; Postgres leg gated behind KEEL_PG_URL. Add a CI job with a Postgres service container. Surface (do not fix here) dialect drift: LIMIT -1, AUTOINCREMENT, FOR UPDATE SKIP LOCKED, ON CONFLICT excluded.
- **Files:** `/Users/ryan/crack/packages/integration/test/db-parity.integration.test.ts (new), /Users/ryan/crack/.github/workflows/ci.yml (postgres service for the parity job only)`
- **Acceptance:** describe.each green on both engines; SQLite leg runs locally, PG leg in container; coverage gate untouched; dialect-drift items filed as follow-up tickets.


## Cross-cutting hazards (from adversarial review)

- THE GATE CANNOT STAY GREEN PER-PACKAGE for the createDb/Queue consumers. test:cov runs vitest with NO tsc, and identity/admin/mailing-lists drive the real createDb while mailing-lists also drives the real Queue. So {db+queue+identity+admin+mailing-lists} MUST flip in ONE commit; a partial flip leaks unawaited Promises that fail value assertions at runtime, not compile time. Draft A's 'green after each commit' is false.
- TRANSACTION-ON-A-POOL silent no-op: migrator.ts:80-101 issues exec('BEGIN')/COMMIT/ROLLBACK as separate calls; on a pg.Pool each lands on a possibly-different pooled connection, so the transaction wraps nothing and SQLite hides it. MUST move to a first-class db.transaction(fn) that pins one pool.connect() client. Single most dangerous correctness trap.
- up()/down() DDL-ORDERING TRAP: existing migration bodies are sync and call multiple schema.* methods with no await (content-store: createTable + 3 addIndex; identity/mailing-lists: 2x schema.execute). After Schema methods return Promises, a sync up() drops Promises — on PG, CREATE INDEX races CREATE TABLE. Fix requires BOTH widening Migration.up/down to void|Promise<void> AND rewriting every existing body to async/await.
- lastInsertRowid is SQLite-only: queue.enqueue (queue.ts:200) is the sole reader. Make the field OPTIONAL on the run() type; queue moves to INSERT ... RETURNING id and the pg adapter reads rows[0].id. Otherwise enqueue returns NaN on PG.
- NAMED→POSITIONAL fork: queue is the only named-param consumer (queue/types.ts:76, Record<string,unknown>), wired to a raw engine because openSqlite's ...params spread can't bind objects. pg binds $n positionally. Convert queue to positional ? + arrays; reused values (@now/@id appear twice in complete/fail) must be repeated at each position and renumbered for $n — a miscount only a live multi-param round-trip catches (the SQLite gate will NOT).
- createApp is a MERGE-COLLISION function, not a divisible seam. The concurrent keel()-router rewrite deletes the very Application-construction block this work would edit. Coordinate so ONE agent owns the final createApp/boot rewrite; this work lands only the KernelDatabase type flip + await-migrate, rebasing if the router lands first. Both diffs touching kernel.ts:92-112 will collide.
- @keel/orm is a DEAD but GATED seam (has test:cov, imported by no consumer) — both drafts forgot it. A careless global seam edit reds its gate. Plus workflows/types.ts and SqliteHandle are independent declarations: 8 seam shapes total, not 5.
- ABORT/DEADLINE → CONNECTION-EXHAUSTION GAP: runtime/server.ts withTimeout abandons the work promise on deadline; requestAbortSignal fires on hangup. The async db terminals + pg.Pool query take NO AbortSignal, so on timeout/hangup the in-flight pg query keeps holding its pooled connection until it completes naturally — under load this exhausts the pool. The SQLite dev path and Node gate cannot reveal it. Threading context.signal into the seam is unscoped here — flag as follow-up.
- CONCURRENCY/INTERLEAVING shift: sync→async means code that relied on a statement completing before the next now yields to the event loop between awaits. On PG, two awaited statements OUTSIDE a transaction can interleave with other requests. Anything needing atomicity (queue claim-then-update, persist loops) must use db.transaction(), not a sequence of awaits. Also: the persist loop is now N network round-trips on PG (was N sync calls) — a latency regression.
- SQL DIALECT DRIFT beyond placeholders is OUT OF SCOPE but BLOCKS real PG parity: renderSelect's LIMIT -1 OFFSET n (queries.ts:140, PG rejects), queue's claim needs FOR UPDATE SKIP LOCKED, queue/content DDL uses INTEGER PRIMARY KEY AUTOINCREMENT (PG needs SERIAL/GENERATED), cache upsert ON CONFLICT ... excluded (verify on PG). The parity suite's claim that 'identity/queue/content pass on PG' is aspirational until a dialect layer exists.
- NO SYNC ESCAPE HATCH: any deasync/Atomics.wait sync-over-async shim re-imports the blocking footgun and defeats the entire migration. Reviewers must reject any getSync()-style backdoor.
- FAKE-FOR-COVERAGE BLIND SPOT: fakes returning Promise.resolve(value) make `await` work but do not reproduce pg's real row/rowCount shape — coverage can hit 100% while a real ?→$n or missing-await bug ships. This is exactly why the live-PG parity step exists and why it must be a REQUIRED CI status (see open questions).
