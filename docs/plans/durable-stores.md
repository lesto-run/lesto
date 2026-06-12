# Durable SQL-backed session + rate-limit stores — implementation plan

**Execute top-to-bottom.** Each numbered item is **one commit on `main`** (never a side branch). This implements ADR 0013 (`docs/adr/0013-durable-stores.md`); read it first, then ADR 0006 §1/§4 for the seam contract, and `packages/cache/src/sql-store.ts` as the house pattern for a SQL-backed store. Items are ordered by risk: the substrate fix first, then the two interface flips (each with its full ripple), then the additive stores, then the dogfood + the cross-driver proof.

## The bar (non-negotiable, every commit)

- TypeScript, ESM, Bun. `oxlint` and `oxfmt` clean.
- **100% vitest coverage per touched package** — statements, branches, functions, lines. No threshold carve-outs. New branches ship with the tests that exercise them.
- Every refusal is a **coded error** (stable code added to the package's error-code union); callers branch on codes, never message strings.
- Before each commit: `bun run ws:typecheck` AND the **serial coverage gate** — `bun scripts/coverage-gate.ts` — both green. Do not parallelize the gate. Typecheck matters doubly here: the gate has no `tsc`, so typecheck is what catches a half-flipped async interface.
- Doc comments must still tell the truth after your change. Several module headers below currently promise things this plan makes false (e.g. "Synchronous by design — a check is hot" in `packages/ratelimit/src/types.ts:15`); updating that prose is part of the item, not polish.
- Commit messages: conventional (`feat(auth): …`, `fix(runtime): …`), ending with the repo's Claude co-author trailer.
- **No sync escape hatches, no `void | Promise` unions** on the flipped interfaces (ADR 0006 discipline).

---

## Item 1 — `@keel/runtime`: serialize SQLite transactions (FIFO) + flat nesting

**Why (verified):** `openSqlite`'s `transaction()` (`packages/runtime/src/sqlite.ts:93–111`) issues `raw.exec("BEGIN")` with no queue on the single shared connection. Two concurrent `transaction()` calls interleave at the `await fn(db)` microtask boundary; the second `BEGIN` throws `cannot start a transaction within a transaction`. Today only the serial migrator transacts; item 5's rate-limit store runs **one transaction per request**, making concurrent transactions steady-state on the default dev driver. Fix the substrate once, here, instead of patching every consumer. (`@keel/pg` is already correct — each transaction checks out its own pooled client.)

**Change** — `packages/runtime/src/sqlite.ts`:
- Add an internal promise chain (`let chain: Promise<unknown> = Promise.resolve()`); `transaction(fn)` enqueues onto it so each transaction's `BEGIN…COMMIT/ROLLBACK` span fully settles before the next begins. A rejected (rolled-back) transaction must **not** poison the chain — append via a link that swallows the previous link's rejection for sequencing purposes while still rejecting the caller's returned promise with the original error.
- Inside the span, hand `fn` a **tx-scoped handle**: same `exec`/`prepare` closures (one connection — they already hit the same handle), but `transaction: (inner) => inner(tx)` so a nested call runs **flat on the same span** instead of deadlocking against the queue. Mirror the shape in `packages/pg/src/adapter.ts:107–110` and say so in the comment.
- Update the module header + `transaction` doc comment: single-connection FIFO; nested transactions compose flat; cross-process writers remain out of scope.

**Tests** — `packages/runtime/test/` (existing sqlite suite):
- Two concurrent `transaction()` calls (the first held open across an awaited tick) both commit, effects serialized, no `cannot start a transaction` error.
- A transaction that rolls back, followed by another that commits — the queue is not poisoned, the second sees a clean connection.
- Nested `tx.transaction(inner)` runs flat: inner writes are visible after the single outer COMMIT; an inner throw rolls back the whole span.
- Existing commit/rollback branch coverage stays at 100%.

---

## Item 2 — `@keel/auth` + `@keel/identity` + estate handler: the async `SessionStore` flip (one commit — typecheck couples them)

**Why:** `SessionStore` (`packages/auth/src/types.ts:23–29`) is sync, so no SQL store can ever satisfy it. Flipping it ripples into `Sessions` (`packages/auth/src/sessions.ts`), `createIdentity` (`packages/identity/src/identity.ts` — which calls `sessions.create/verify/revoke` at lines 355, 439, 445), and estate's sign-out handler (`examples/estate/src/controllers.ts:264`). `ws:typecheck` compiles the workspace, so these cannot land separately.

**Change:**
- `packages/auth/src/types.ts`: `SessionStore.save/find/delete` → `Promise<void>` / `Promise<Session | undefined>` / `Promise<void>`. Update the interface doc ("a Map or a table both fit" stays true — say the shape is async even when the work is not, per the `CacheStore` precedent).
- `packages/auth/src/sessions.ts`:
  - `MemorySessionStore` methods become `async` (bodies unchanged).
  - `Sessions.create(userId, ttlMs): Promise<Session>` (awaits `store.save`); `verify(token): Promise<Session | undefined>` (awaits `find`, awaits the expiry-sweep `delete`); `revoke(token): Promise<void>`.
  - Module header: the "verification is also the sweep" prose stays true; note the store may now be a table shared across nodes.
- `packages/auth/src/index.ts`: exports unchanged in name; no new symbols this item.
- `packages/identity/src/identity.ts`:
  - `login`: `const session = await sessions.create(...)`.
  - `currentUser`: `const session = await sessions.verify(token)`.
  - **`logout(token: string | undefined): Promise<void>`** — the one public interface break (ADR 0013 §6). Update the `Identity` interface (line 214) and the implementation (`async logout(token) { if (token !== undefined) await sessions.revoke(token); }`).
  - Update the `revokeUserSessions` doc comment (lines 181–190): the "no by-user index" sentence becomes "wire `sqlSessionStore`'s `deleteByUserId` (item 3), or one `DELETE … WHERE user_id = ?` on a custom store".
- `examples/estate/src/controllers.ts`: the `/mls/api/sign-out` handler becomes `async (c) => { … await identity.logout(sessionToken); … }`.
- Grep for other `\.logout\(` / `sessions\.(create|verify|revoke)\(` call sites (`packages/`, `examples/`, `packages/create-keel/src/templates.ts`) and await them; expected hits are identity tests, auth tests, estate.

**Tests:** `packages/auth/test/auth.test.ts` — awaits added; expired-token sweep branch, unknown token, revoke-twice all still covered. `packages/identity/test/identity.test.ts` — `logout` assertions (lines ~589–599) become awaited; the injected-`sessionStore` seam now takes an async fake. Estate's test suite re-runs green (sign-out journey).

---

## Item 3 — `@keel/auth`: `sqlSessionStore` + `installSessionSchema` (additive)

**Why:** the durable store itself, on the ADR 0006 seam. Additive — nothing else changes behavior.

**Change:**
- `packages/auth/src/types.ts` (or the new module): declare the package-local structural seam, cache-precedent style (`packages/cache/src/types.ts:44+`): `SqlStatement { run/get/all → Promise }`, `SqlDatabase { exec; prepare }` — sessions never transact, so do **not** declare `transaction` here. Type-only; **no** `@keel/db` dependency added to `packages/auth/package.json`.
- New `packages/auth/src/sql-session-store.ts`:
  - `installSessionSchema(db): Promise<void>` — three awaited `exec` calls, exactly the DDL in ADR 0013 §4 (`keel_sessions`: `token TEXT PRIMARY KEY`, `user_id TEXT NOT NULL`, `expires_at BIGINT NOT NULL`; indexes on `user_id` and `expires_at`; all `IF NOT EXISTS`). **`BIGINT`, not `INTEGER`** — epoch-ms overflows PG int4; the comment must say so.
  - `sqlSessionStore(db): SqlSessionStore` — closure factory. Statements prepared **eagerly at construction** (`prepare` is sync; sessions never transact, so pool-level statements are correct — contrast with item 5, and say so in a comment).
    - `save`: `INSERT INTO keel_sessions (token, user_id, expires_at) VALUES (?, ?, ?) ON CONFLICT(token) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at` (idempotent save; same upsert shape as `keel_cache`).
    - `find`: SELECT by token; map the row with **`Number(row.expires_at)`** (pg returns BIGINT as a string — ADR 0013 §4) and `String(row.user_id)`; `undefined` on miss.
    - `delete`: DELETE by token.
  - `SqlSessionStore extends SessionStore` with two concrete extras (NOT on the core interface): `deleteByUserId(userId: string): Promise<number>` and `deleteExpired(now: number): Promise<number>` (both return `changes`).
- `packages/auth/src/index.ts`: export `sqlSessionStore`, `installSessionSchema`, and the `SqlSessionStore` type.

**Tests** — `packages/auth/test/` (new `sql-session-store.test.ts`): drive a small in-memory fake implementing the local seam (a Map of rows + a tiny SQL-keyed dispatch — auth stays dependency-free; the real-engine proof is item 7). Cover: install idempotence (exec call shapes), save/find round-trip, upsert-on-resave, find-miss, string-typed `expires_at` coerced to number, delete, `deleteByUserId` count, `deleteExpired` boundary (`< now` vs `>= now`). Plus a `Sessions`-over-`sqlSessionStore` journey: create → verify → expire via injected clock → verify deletes the row.

---

## Item 4 — `@keel/ratelimit`: the atomic `update` interface + async limiter + middleware await (one commit)

**Why:** `get`/`set` is an unfixable read-modify-write race against any shared backend (ADR 0013 §2); the interface must become one atomic verb before a SQL store can exist. Ripple is package-local plus one awaited call in the middleware; `@keel/kernel`'s secure-stack passes options only (`packages/kernel/src/secure-stack.ts:92–93`) and needs no change.

**Change:**
- `packages/ratelimit/src/types.ts`: replace `RateLimitStore.get/set` with `update(key, mutate): Promise<BucketState>` exactly as specified in ADR 0013 §2, including the doc contract: *mutate is synchronous, pure over its input, and may be invoked more than once*. `BucketState`, `Clock`, `RateLimitResult` unchanged. Rewrite the module header — "Synchronous by design — a check is hot" is now false; the new truth: the store owns atomicity, the limiter owns the math, and the shape is async so a table can satisfy it.
- `packages/ratelimit/src/store.ts`: `MemoryRateLimitStore.update` — `const next = mutate(this.buckets.get(key)); this.buckets.set(key, next); return next;` (async method). Header comment: atomic by construction (single-threaded JS + sync mutate).
- `packages/ratelimit/src/limiter.ts`: `check(key, cost = 1): Promise<RateLimitResult>`. Move the existing math *unchanged* into the `mutate` closure: refill (first-seen = full; else accrue, cap), spend-or-deny, persist `{ tokens, updatedAt: now }` in both branches (the deny path persists accrued tokens with the new timestamp, exactly as today — `limiter.ts:60–66`). Capture the `RateLimitResult` in a closure variable per invocation; the last invocation wins (retry-safe). `refilled`/`persist` private helpers fold into the closure or stay as pure functions — engineer's choice, but the math must be byte-equivalent (same `Math.floor`/`Math.ceil` placement).
- `packages/ratelimit/src/middleware.ts:150`: `const result = await limiter.check(keyFor());` — nothing else moves (keying, warn-once, 429 + `Retry-After` untouched).
- `packages/ratelimit/src/index.ts`: exports unchanged this item.
- Grep for direct `RateLimiter`/`check(`/`RateLimitStore` consumers outside the package: expected = `packages/kernel/src/secure-stack.ts` (options-only, no change), `packages/kernel/test/secure-stack.test.ts`, `packages/create-keel/src/templates.ts` (audit; options-only expected).

**Tests:** `packages/ratelimit/test/` — limiter suite awaits `check`; all existing branches (first-seen full bucket, accrual cap, deny + `retryAfterMs` ceil, cost > 1) keep 100%. New: a store fake whose `update` invokes `mutate` twice proves the result is consistent (retry contract). Middleware suite: allowed/denied paths re-covered with the awaited check. Kernel's secure-stack tests re-run untouched.

---

## Item 5 — `@keel/ratelimit`: `sqlRateLimitStore` + `installRateLimitSchema` + coded conflict error (additive)

**Why:** the durable, fleet-correct limiter — the single transaction/locked-read/bounded-retry design of ADR 0013 §5. This is the riskiest *logic* in the increment; it lands after the interface is proven (item 4) and on a substrate that can take it (item 1).

**Change:**
- `packages/ratelimit/src/types.ts`: add the package-local structural seam — here it **must include `transaction`** (`SqlDatabase { exec; prepare; transaction<T>(fn) }`).
- New `packages/ratelimit/src/errors.ts`: `RateLimitError extends KeelError<RateLimitErrorCode>` with `RateLimitErrorCode = "RATELIMIT_STORE_CONFLICT"`; add `@keel/errors` to `packages/ratelimit/package.json` dependencies. (House pattern: `packages/auth/src/errors.ts`.)
- New `packages/ratelimit/src/sql-store.ts`:
  - `installRateLimitSchema(db): Promise<void>` — the ADR §4 DDL (`keel_rate_limits`: `key TEXT PRIMARY KEY`, `tokens DOUBLE PRECISION NOT NULL`, `updated_at BIGINT NOT NULL`; index on `updated_at`; `IF NOT EXISTS`), one awaited `exec` per statement.
  - `sqlRateLimitStore(db, options?: { dialect?: "sqlite" | "postgres" }): SqlRateLimitStore` (default `"sqlite"`). `update` implements the ADR §5 algorithm verbatim:
    - One `db.transaction` per attempt; **`tx.prepare`, never a pool-level prepared statement** — a statement prepared on the pool queries through the pool and silently escapes the transaction on PG. Put this sentence in the code comment.
    - SELECT with `" FOR UPDATE"` appended iff `dialect === "postgres"`.
    - Row present → `Number()`-coerce both columns, `mutate(state)`, `UPDATE`. Absent → `mutate(undefined)`, plain `INSERT` (no upsert — the conflict is the signal).
    - Unique-violation predicate `isUniqueViolation(error)` (exported for tests): PG `code === "23505"`, SQLite message containing `UNIQUE constraint failed` or code `SQLITE_CONSTRAINT*`. First conflict → retry the whole `update` once; second → `throw new RateLimitError("RATELIMIT_STORE_CONFLICT", …, { key })`. Any other error propagates untouched (fail-closed: the request errors; never fail-open).
  - `SqlRateLimitStore extends RateLimitStore` with concrete `sweep(before: number): Promise<number>`; its doc comment states the safety condition (`before ≤ now − capacity/refillPerSecond·1000` ms ⇒ deletion is invisible to the limiter) — the caller owns the cadence; no framework timer.
- `packages/ratelimit/src/index.ts`: export `sqlRateLimitStore`, `installRateLimitSchema`, `RateLimitError`, `RateLimitErrorCode`, `SqlRateLimitStore`.

**Tests** — new `packages/ratelimit/test/sql-store.test.ts` against a scripted fake `SqlDatabase` (fake `transaction` hands out a recording `tx`): row-present path (SELECT→mutate→UPDATE param shapes; PG-string `tokens`/`updated_at` coerced); row-absent path (INSERT); `FOR UPDATE` present iff dialect postgres; conflict-once → retry → success (and `mutate` ran twice); conflict-twice → `RATELIMIT_STORE_CONFLICT` with `details.key`; non-conflict error propagates without retry; `isUniqueViolation` truth table (pg code / sqlite message / unrelated error / non-object); `sweep` delete shape + count. End-to-end within the package: `RateLimiter` over `sqlRateLimitStore` over the fake — admit/deny/refill behavior byte-matches the memory store under an injected clock.

---

## Item 6 — estate dogfood: node path on `sqlSessionStore`

**Why:** the framework's own example must exercise the durable path (it is how friction gets found), and estate is the launch-hardening surface. The demo DB is `:memory:` so durability is moot in the demo itself — but the *wiring* (install → store → identity) is exactly what a production app copies, and the e2e suite now exercises it on every PR.

**Change** — `examples/estate/src/identity.ts` (`buildIdentity`):
- After `Migrator(...).migrate()`: `await installSessionSchema(sql);`
- `createIdentity({ …, sessionStore: sqlSessionStore(sql) })`.
- Update the module header (the session rows now live in the same SQLite handle as users; a file-backed SQLite or Postgres makes both durable for real).
- The edge path (`edge.ts`, `SignedSessions`) is **deliberately untouched** — ADR 0013 §8.

**Tests:** estate's existing suites (sign-in/sign-out journey, security tests) re-run green; add one assertion that a session minted by login is revoked by sign-out (a second `currentUser` with the old cookie yields signed-out) — which now exercises the SQL store's delete path through the full HTTP journey.

---

## Item 7 — `@keel/integration`: durable-stores cross-driver suite (SQLite always; Postgres in the `db-parity-postgres` CI leg)

**Why:** the package fakes prove logic; only a real socket proves the atomicity claims (ADR 0006's "fake-for-coverage blind spot"). The CI job already exists and runs `bun run test` in `packages/integration` with `KEEL_PG_URL` set (`.github/workflows/ci.yml:92–125`) — a new test file there runs on both legs with **zero CI edits**.

**Change:**
- `packages/integration/package.json`: add `"@keel/auth": "workspace:*"`, `"@keel/ratelimit": "workspace:*"`.
- New `packages/integration/test/durable-stores.integration.test.ts`, mirroring `db-parity.integration.test.ts`'s driver harness (`drivers` array, PG leg behind `KEEL_PG_URL`, per-test `DROP TABLE IF EXISTS` + install fns; `dialect` passed to `sqlRateLimitStore` per driver):
  1. **Session durability:** `installSessionSchema` twice (idempotent); `Sessions` over `sqlSessionStore` — create → verify → reopen a *second store over the same handle* and verify again (the row, not the process, is the truth) → revoke → gone; expiry via injected clock deletes the row; `deleteByUserId` kills exactly that user's sessions; `deleteExpired` count.
  2. **Identity journey over the SQL store:** per-dialect hand-written `users` DDL (SQLite `AUTOINCREMENT` / PG `SERIAL` — same pattern as `db-parity`'s `items`; comment pointing at the dialect-drift follow-up, since `usersMigration` cannot run on PG) → seed a user → `login` → `currentUser` → `logout` → `currentUser` is undefined. This is the first identity-shaped flow ever proven over a real Postgres socket.
  3. **THE ATOMICITY PROOF:** `RateLimiter` (fixed injected clock, capacity C=5, any refill) over `sqlRateLimitStore`; fire **N=12 concurrent `check`s on one key via `Promise.all`** — exactly 5 allowed, 7 denied, final row `tokens = 0`. On PG this exercises `FOR UPDATE` + the first-insert retry across real pooled connections; on SQLite it exercises item 1's transaction queue. This single test is the increment's reason to exist — if it flakes, the design is wrong; do not retry it into submission.
  4. Refill over advancing injected clock; `sweep` deletes a fully-refilled key's row and the next check sees a fresh full bucket.

**Acceptance:** suite green locally (SQLite leg); `db-parity-postgres` leg green in CI with the new describes visibly executed (check the job log lists `durable-stores.integration.test.ts` under the postgres driver). `@keel/integration` declares no coverage thresholds (unchanged posture).

---

## Item 8 — docs truth-up

**Why:** anti-aspirational discipline — claim it only once it is true.

**Change:** flip ADR 0013's status line to `Implemented (YYYY-MM-DD)`; one-line pointers from `docs/adr/0003-auth-strategy.md` (sessions now durable via 0013) if and only if its prose contradicts reality; verify ADR 0006's status note (already truth-flipped alongside this plan) still reads correctly given item 7 landed the first identity-on-PG journey — amend its "outstanding edges (a)" to say the *login* journey now runs on PG via hand-rolled DDL while migration-driven DDL remains blocked.

---

## After this increment — the substrate through-line (verdict, not a plan)

1. **PG hardening / the dialect seam** — the next increment. The evidence is now concrete: `createTableSql`'s `AUTOINCREMENT` blocks every migration-driven table on PG (items 7.2 had to hand-roll DDL); `LIMIT -1` and the missing int8 parser are known. Scope: a small dialect parameter on DDL rendering + the parser + promoting the identity/queue journeys into `db-parity-postgres` on migration-driven schema. That increment ends with "a Keel app boots, migrates, and serves on Postgres" being literally true.
2. **Delete `@keel/orm`** — immediately after this lands, as its own tiny commit (zero coupling, dead but gated; removal shrinks the seam-declaration count and the gate's runtime). It needs no ADR — ADR 0004 already declared it legacy.
3. **Edge-durable KV** — only after 1: a `KeyValueStore`-shaped seam with a Cloudflare KV/D1 backing, which is what lets `SignedSessions` gain an optional revocation list and the rate limiter run *at* the edge. Designing it before PG hardening would mean two half-proven substrates; the SQL tier must be boringly solid first.
