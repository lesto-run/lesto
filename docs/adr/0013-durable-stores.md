# ADR 0013 — Durable SQL-backed session + rate-limit stores (async store interfaces)

- **Status:** Implemented (2026-06-11): both store interfaces are async, `sqlSessionStore`/`sqlRateLimitStore` ship on the SQL seam, the SQLite adapter serializes transactions FIFO, estate dogfoods the durable session path, and `@lesto/integration`'s `durable-stores.integration.test.ts` proves session/identity/rate-limit durability cross-driver (SQLite always; Postgres in `db-parity-postgres`). The implementation plan is `docs/plans/durable-stores.md`.
- **Date:** 2026-06-11
- **Builds on:** ADR 0006 (the async `SqlDatabase` seam — implemented; this is its first *product* consumer beyond the query layer), ADR 0003 (`@lesto/identity`), ADR 0004 (data-layer style: closure factories, explicit `db`)
- **Relates to:** ADR 0002 (edge target), `packages/auth/src/signed-sessions.ts` (the stateless edge tier this ADR deliberately does **not** absorb)

## Context

ADR 0006 is done: the driver seam is async, `@lesto/pg` backs it over a real socket, and CI proves cross-driver parity (`db-parity-postgres`). But the two stateful production primitives that sit *on top* of the substrate never moved onto it:

- **Sessions** — `packages/auth/src/sessions.ts` has exactly one `SessionStore`: the in-memory `MemorySessionStore`. The interface (`packages/auth/src/types.ts`) is **synchronous**: `save(session): void`, `find(token): Session | undefined`, `delete(token): void`.
- **Rate limits** — `packages/ratelimit/src/store.ts` has exactly one `RateLimitStore`: the in-memory `MemoryRateLimitStore`. The interface (`packages/ratelimit/src/types.ts`) is **synchronous**: `get(key): BucketState | undefined`, `set(key, state): void`.

Consequences today: every session dies on restart; every node in a fleet (or every Worker isolate) has its own session set and its own rate-limit buckets, so "logged in" is per-process and a client can multiply its rate limit by the number of nodes. For the multi-isolate Cloudflare/Node deploys Lesto targets, that is fatal. A synchronous interface can never be backed by the async SQL seam — so the interfaces must flip first, and the flip ripples (this ADR names every ripple).

A subtlety the rate limiter adds that sessions do not: `RateLimiter.check` (`packages/ratelimit/src/limiter.ts`) is a **read-modify-write** — `store.get(key)` → compute refill/spend → `store.set(key, next)`. In-process with a sync Map that is atomic by construction. Across two awaits against a shared database it is a classic lost-update race: two nodes read `tokens: 1`, both admit, both write `tokens: 0` — the limit silently leaks. ADR 0006's §Consequences flagged exactly this class ("anything needing atomicity must use `db.transaction()`, not a sequence of awaits"). So the rate-limit store cannot just become "async get + async set": **the interface shape must change so one store call owns the whole read-modify-write.**

## Decision

### 1. Both store interfaces go strictly async — no sync escape hatch, no unions

Mirroring `CacheStore` (`packages/cache/src/types.ts`), the shape is async even when the work is not; an in-memory store satisfies it by resolving immediately.

```ts
// packages/auth/src/types.ts
export interface SessionStore {
  save(session: Session): Promise<void>;
  find(token: string): Promise<Session | undefined>;
  delete(token: string): Promise<void>;
}
```

`Session` is unchanged (`token`, `userId`, `expiresAt` epoch-ms). The three-verb surface stays minimal on purpose — a Map and a table both fit. No `void | Promise<void>` unions: per ADR 0006's discipline, a sync-shaped backdoor invites exactly the half-awaited bugs the no-`tsc` coverage gate cannot catch.

### 2. `RateLimitStore` changes shape: one atomic verb, policy stays in the limiter

```ts
// packages/ratelimit/src/types.ts
export interface RateLimitStore {
  /**
   * Atomically read-modify-write one bucket. `mutate` receives the current
   * state (undefined for a first-seen key) and returns the state to persist;
   * the store guarantees no other update of the same key interleaves between
   * the read and the write.
   *
   * `mutate` MUST be synchronous and pure over its input — a store may invoke
   * it more than once (e.g. one retry after losing a first-insert race).
   */
  update(key: string, mutate: (current: BucketState | undefined) => BucketState): Promise<BucketState>;
}
```

`get`/`set` are **deleted**, not deprecated. The division of labor is exact:

- **`RateLimiter` keeps all token-bucket math** (refill, cap, spend, retry-after) — it passes the math in as the `mutate` closure and captures the verdict. `check(key, cost)` becomes `async check(key, cost): Promise<RateLimitResult>`; the result is byte-identical to today for identical inputs.
- **The store owns atomicity and nothing else.** `MemoryRateLimitStore.update` is atomic by construction (single-threaded JS + a synchronous `mutate`): `const next = mutate(buckets.get(key)); buckets.set(key, next); return next`. The SQL store wraps the read-modify-write in one `db.transaction` (see §5).

Rejected alternative — pushing capacity/refill into the store (`store.take(key, policy)`): it duplicates the bucket math into every backend and inverts the package's stated design ("the token-bucket decision stays in `RateLimiter`"). Rejected alternative — keeping `get`/`set` and adding a `store.atomically(fn)` wrapper: two verbs plus a bracket is a bigger, leakier surface than one verb that *is* the bracket.

### 3. Prerequisite: the SQLite adapter must serialize transactions

The durable stores make `db.transaction()` a **per-request, steady-state** operation for the first time (one per rate-limit check). `openSqlite`'s `transaction()` (`packages/runtime/src/sqlite.ts:93–111`) issues `raw.exec("BEGIN")` with no queue on a single shared connection; two concurrent transactions interleave at the `await` points and the second `BEGIN` throws `cannot start a transaction within a transaction`. Today only the (serial) migrator transacts, so it never fires; under concurrent requests it will, on the default dev driver.

Decision: fix the substrate once, not each consumer. `openSqlite`'s `transaction()` gains a FIFO queue (an internal promise chain): each transaction waits for the previous to settle before `BEGIN`; a rolled-back transaction must not poison the chain. Inside the span, `fn` receives a tx-scoped handle whose own `transaction` runs the inner callback **flat** on the same span — exactly the shape `createPgDatabase` already implements (`packages/pg/src/adapter.ts:107–110`) — so a nested call composes instead of deadlocking against the queue. The `@lesto/pg` adapter needs no change: each transaction checks out its own pooled client.

(Cross-*process* SQLite writers remain out of scope — SQLite is the single-node dev default; fleets run Postgres.)

### 4. SQL-backed stores: where they live, what they create

Closure factories (ADR 0004 style), colocated with their interfaces, exactly like `@lesto/cache`'s `sqlStore`:

- `packages/auth/src/sql-session-store.ts` → `installSessionSchema(db)`, `sqlSessionStore(db): SqlSessionStore`
- `packages/ratelimit/src/sql-store.ts` → `installRateLimitSchema(db)`, `sqlRateLimitStore(db, options?): SqlRateLimitStore`

Each package declares the minimal structural `SqlStatement`/`SqlDatabase` seam it consumes **locally** in its `types.ts` (type-only, no `@lesto/db` workspace dep) — the established cache precedent. Yes, this grows the seam re-declaration count from 8 to 10; consolidating the declarations into one shared types package is an explicit **non-goal** here (follow-up candidate; it touches ten packages for zero behavior).

Schema — hand-written, dialect-portable DDL (deliberately avoiding `createTableSql`, whose `AUTOINCREMENT` output PG rejects — the known ADR 0006 dialect-drift edge). Install functions issue one awaited `exec` per statement, `IF NOT EXISTS`, idempotent:

```sql
CREATE TABLE IF NOT EXISTS lesto_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesto_sessions_user_id ON lesto_sessions (user_id);
CREATE INDEX IF NOT EXISTS lesto_sessions_expires_at ON lesto_sessions (expires_at);

CREATE TABLE IF NOT EXISTS lesto_rate_limits (
  key        TEXT PRIMARY KEY,
  tokens     DOUBLE PRECISION NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS lesto_rate_limits_updated_at ON lesto_rate_limits (updated_at);
```

Two type traps, decided here so the engineer does not rediscover them:

- **Epoch-ms does not fit `INTEGER` on Postgres** (int4 caps at ~2.1e9; epoch-ms is ~1.8e12). `expires_at`/`updated_at` are `BIGINT` — SQLite gives it INTEGER affinity (64-bit), PG gets int8. `tokens` is `DOUBLE PRECISION` (fractional accrual), REAL affinity on SQLite.
- **node-postgres returns `BIGINT` as a string** (no int8 parser is registered — `packages/pg/src/pg-driver.ts` is a bare pool). Both stores `Number(...)`-coerce every numeric column on read, so `clock() >= session.expiresAt` compares numbers on both drivers. Registering a global int8 parser in `@lesto/pg` is a follow-up under PG hardening, not done here (it mutates pg's global type registry; the local coercion is total and testable).

### 5. The atomic rate-limit check — single transaction, locked read, bounded retry

`sqlRateLimitStore(db, options?: { dialect?: "sqlite" | "postgres" })` (default `"sqlite"`). One transaction per `update`:

```
attempt(n):
  db.transaction(tx):
    row  = tx.prepare("SELECT tokens, updated_at FROM lesto_rate_limits WHERE key = ?"
                      + (dialect === "postgres" ? " FOR UPDATE" : "")).get([key])
    next = mutate(row ? { tokens: Number(row.tokens), updatedAt: Number(row.updated_at) } : undefined)
    row ? tx.prepare("UPDATE lesto_rate_limits SET tokens = ?, updated_at = ? WHERE key = ?").run([...])
        : tx.prepare("INSERT INTO lesto_rate_limits (key, tokens, updated_at) VALUES (?, ?, ?)").run([...])
    return next
  catch unique-violation when n === 0 → attempt(1)
  catch unique-violation when n === 1 → throw RateLimitError("RATELIMIT_STORE_CONFLICT", …)
```

Why each piece is load-bearing:

- **`FOR UPDATE` on Postgres.** Under READ COMMITTED, two concurrent transactions can both `SELECT` the same row and both write — a lost update *inside* transactions. `FOR UPDATE` row-locks the read; the second transaction blocks, then re-reads the committed state. SQLite's parser rejects `FOR UPDATE`, hence the dialect option — and SQLite needs no lock: the §3 queue plus the single connection already serialize every transaction in-process. This is the one dialect fork in the increment; it is an explicit option, never sniffed.
- **First-insert race, closed not shrugged at.** A key's *first* row cannot be locked (there is nothing to lock); two concurrent birth transactions both see no row and both `INSERT`. The plain `INSERT` (not upsert) makes the loser fail loudly on the primary key; **retry once** — the row now exists, so the retry takes the locked path. A second consecutive conflict (possible only against a concurrent sweep, see below) is a coded refusal, `RATELIMIT_STORE_CONFLICT`, never an infinite loop. Unique violations are detected structurally (`error.code === "23505"` for PG, the `UNIQUE constraint failed`/`SQLITE_CONSTRAINT` shape for SQLite) in one covered predicate.
- **Statements are prepared per-transaction on `tx`, not eagerly on `db`.** This deliberately diverges from `sqlStore`'s eager-prepare: on Postgres, a statement prepared from the pool-level handle queries **through the pool**, escaping the transaction's pinned client entirely. Inside a transaction, only `tx.prepare` is correct. (Sessions, below, keep the eager-prepare pattern — they never transact.)
- Store errors **propagate** (the request 500s). A rate limiter that fails open under store failure is a bypass; a silent fail-closed is an outage with no signal. The coded error is the operator's signal.

**Row growth and the sweep.** A bucket row whose `updated_at` is at least `capacity / refillPerSecond * 1000` ms old is semantically identical to no row (the bucket has fully refilled) — so deleting stale rows is invisible to the limiter. `SqlRateLimitStore` exposes `sweep(before: number): Promise<number>` (`DELETE … WHERE updated_at < ?`); the caller computes the threshold from its policy and runs it on whatever cadence it likes (cron, deploy hook). Same posture for sessions: `Sessions.verify` already deletes expired tokens on sight, so only never-again-presented tokens accumulate; `SqlSessionStore` exposes `deleteExpired(now: number): Promise<number>`. Neither sweep is on the *interface* — they are concrete affordances of the SQL stores. No background timer is started by the framework (a non-goal below).

Sessions need no transaction at all: `save`/`find`/`delete` are single statements, and `verify`'s find-then-delete-if-expired pair is benignly racy (deleting an expired token twice is idempotent; the verdict is decided by the clock either way).

**`SqlSessionStore` additionally exposes `deleteByUserId(userId: string): Promise<number>`** — the `user_id` index exists precisely so `IdentityOptions.revokeUserSessions` (whose doc comment today says "typically one `DELETE FROM sessions WHERE user_id = ?`") can be wired as `(id) => store.deleteByUserId(id)` with no hand-written SQL. The core three-verb `SessionStore` interface does **not** grow a by-user verb: memory stores would need a second index for a feature most callers never use.

### 6. The consumer ripple — who awaits now

The coverage gate runs vitest with no `tsc`, but CI's `ws:typecheck` step *does* compile the workspace — so a half-flipped interface fails typecheck even where tests would only see a leaked Promise. The flip units below are chosen so both stay green per commit.

| Surface | Change |
| --- | --- |
| `@lesto/auth` `Sessions` | `create`/`verify`/`revoke` → `async`, awaiting the store. `MemorySessionStore` methods become async-shaped. Same commit as the identity ripple (typecheck couples them). |
| `@lesto/identity` `Identity` | `login` already async — `sessions.create` gains an `await`. `currentUser` awaits `sessions.verify`. **`logout(token): void` becomes `logout(token): Promise<void>`** — a public interface break, the only one in this increment. |
| `@lesto/ratelimit` `RateLimiter` | `check` → `async check(...): Promise<RateLimitResult>`; math unchanged, expressed as the `mutate` closure. |
| `@lesto/ratelimit` middleware | `packages/ratelimit/src/middleware.ts:150` — `const result = await limiter.check(keyFor())`. The middleware is already async; no signature change. Keying, `UNKNOWN_CLIENT_KEY`, warn-once: untouched. |
| `@lesto/kernel` secure-stack | No code change — it passes `RateLimitOptions` through (`packages/kernel/src/secure-stack.ts:92–93`); behavior identical. Tests re-run as-is. |
| `examples/estate` | `controllers.ts:264` (`identity.logout(sessionToken)`) — the sign-out handler becomes `async` and awaits. The node path (`buildIdentity` in `examples/estate/src/identity.ts`) then dogfoods `sqlSessionStore` over its existing SQLite handle. |
| `create-lesto` templates | Audit only — they configure `rateLimit` via options and never call `check`/`logout` directly; update any template that does. |

### 7. Memory vs SQL: who runs what

- **`MemorySessionStore` / `MemoryRateLimitStore` stay and stay the defaults** — `createIdentity` still defaults `sessionStore` to memory; `rateLimit()` still builds a `MemoryRateLimitStore` when no `limiter` is injected. Tests and single-process dev need zero config and no schema install. The async shape costs them nothing (resolved promises).
- **The SQL stores are explicit, injected production choices**: `sessionStore: sqlSessionStore(db)` into `createIdentity`; `limiter: new RateLimiter({ store: sqlRateLimitStore(db, { dialect: "postgres" }), … })` into `rateLimit`/secure-stack. Install functions run at boot, after the migrator, before traffic. No magic auto-selection — choosing your durability tier is configuration, not inference.

### 8. `SignedSessions` — a deliberate separate tier, not a convergence target

Estate's edge path (`examples/estate/src/edge.ts`) authenticates with `SignedSessions` — a stateless HMAC token verified with zero I/O, because a Worker isolate has no store and a DB round-trip per request defeats the edge. The durable store does **not** replace it; Lesto now has an honest two-tier session architecture:

- **Origin tier (this ADR):** store-backed `Sessions` over `sqlSessionStore` — the source of truth; revocable the instant `revoke`/`deleteByUserId` runs; survives restarts; shared across nodes.
- **Edge tier (unchanged):** `SignedSessions` — a short-TTL, non-revocable capability token. Its documented trade ("cannot be revoked before it expires; keep the TTL short") stays the contract.

They share nothing but the `Clock` type, on purpose: blending them (e.g. a signed token that *also* checks a revocation list) requires an edge-readable durable KV, which is the named follow-up in the roadmap — not a thing to half-build inside `@lesto/auth` now.

### 9. `@lesto/orm` — stays out

Still LEGACY (ADR 0004), still imported by no consumer, still self-contained with its own green gate. Deleting it has zero coupling to this increment and would only widen the review diff. It stays a separate, immediately-actionable housekeeping commit after this lands (see the roadmap verdict in `docs/plans/durable-stores.md`).

## What we are NOT doing (named, so nobody "helpfully" adds them)

- **No Redis / Cloudflare KV / D1 / Durable Object stores.** The interfaces now make them possible; building them is the edge-durability increment, after this one proves the shape on SQL.
- **No framework-started background sweeper.** `sweep`/`deleteExpired` are explicit calls; a timer the framework owns is lifecycle surface (shutdown, serverless) this increment does not need.
- **No session rotation, sliding expiry, or session metadata (IP/user-agent) columns.** The `Session` shape is unchanged; those are auth features, not durability.
- **No seam-declaration consolidation** (the 8→10 structural `SqlDatabase` copies). Follow-up candidate.
- **No global int8 type parser in `@lesto/pg`**; store-local `Number()` coercion instead (see §4).
- **No dialect layer for `createTableSql`**, no `LIMIT -1` fix, no AbortSignal threading — all remain ADR 0006's named follow-ups (PG hardening).
- **No re-litigation of ADR 0006.** The seam is taken as built; its status line has been truth-flipped to Implemented with its two outstanding edges noted.

## Consequences

- Sessions and rate limits survive restarts and hold across a fleet — the actual production gap closes. The deploy story for Node-multi-process and for any architecture with a shared Postgres becomes honest.
- **One public interface break:** `Identity.logout` returns a Promise. Every other ripple is an additive `await`.
- A rate-limit check against the SQL store is a transaction with one read and one write **per request, including denied ones** (the refill accrual must persist). On Postgres under attack this is real write load on one tiny row per key; acceptable for v1, and the named optimization path is a single-statement dialect-specific upsert (`LEAST`/`CASE … RETURNING`) — deliberately rejected now because it forks the bucket math per dialect and is much harder to keep at 100% coverage honestly.
- SQLite transactions are now FIFO-serialized in-process — correct, and strictly better than the current "second concurrent transaction throws"; throughput on the dev driver is bounded by the single connection it always had.
- `mutate` may run twice on a first-insert race; it is documented as pure-over-input. The limiter's closure tolerates this by construction.
- The identity journey on Postgres remains blocked by `users`-table dialect drift (ADR 0006's edge) — the integration suite for *this* ADR hand-writes portable DDL and so proves session/rate-limit durability on PG without waiting for the dialect layer.
