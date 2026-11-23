---
"@lesto/db": minor
"@lesto/pg": minor
"@lesto/cloudflare": minor
---

`SqlDatabase` gains a required `batch(statements)`: a list of `{ sql, params, returns }` run as one atomic unit — every statement commits, or none does — resolving one tagged result per statement (`{ returns: "rows", rows }` or `{ returns: "changes", changes }`). An empty batch resolves `[]` without touching the driver.

It is the one atomic primitive every driver can offer. Cloudflare D1 has no interactive transaction, so `d1ToSqlDatabase` maps `batch` onto a single native `d1.batch()` call. `adaptSyncSqlite` (and through it `openSqlite` and the OPFS driver), `@lesto/pg` and `hyperdriveToSqlDatabase` run it as one `BEGIN`…`COMMIT` on one connection through the new shared `batchViaTransaction`. On a tx handle a batch runs inside a `SAVEPOINT` (`batchViaSavepoint`), so a failed batch rolls back alone even when the caller catches its error and the transaction commits.

`adaptSyncSqlite` now routes root-handle statements (`exec`, `prepare(...).run/get/all`) through the same FIFO queue as its spans, so a solo statement can no longer land inside another caller's open transaction. Statements on a tx handle still run directly, so use `tx` inside a `transaction` callback. A root-handle statement (`exec`, `prepare(...).run/get/all`, `transaction`, `batch`) issued from inside the handle's own span now rejects with the coded `DB_ROOT_STATEMENT_IN_SPAN` instead of queuing behind its own span forever; a root statement from a different concurrent caller still waits its turn. Telling the two apart needs async context, which the caller injects: `adaptSyncSqlite(statements, { asyncContext })` takes an `AsyncLocalStorage<object>`, and `openSqlite` passes one. Where no async context exists (the browser OPFS driver) the check is best-effort: the statement waits as before, and no timeout replaces it.

`hyperdriveToSqlDatabase` now queues its spans (`transaction` and `batch`) the same way on its one connection, and takes the same optional `{ asyncContext }` to refuse a root `transaction` or `batch` issued inside its own span. The queue and the guard are exported as `createFifoQueue` and `createSpanGuard`.

`createDb(...).batch([...])` builds a batch from the query builders with no hand-written SQL: pass `select`, `insert(…).values(…)`, `.returning()`, `update(…).set(…).where(…)` and `delete(…).where(…)` stages without their terminal, and get a tuple typed per slot. Each stage compiles to the same SQL its own terminal sends. `rawRows` and `rawChanges` add hand-written statements (a guard such as `INSERT … SELECT … WHERE NOT EXISTS (…)`) to the same batch. `changes()` gates work only on SQLite and D1. A batch cannot branch on its own reads — the check moves into the write.

**Breaking for hand-written handles:** a custom `SqlDatabase` must now implement `batch`; `batch: (statements) => batchViaTransaction(handle, statements)` is the one-line fix for any driver that has `transaction`. A hand-typed `D1Database` must declare `batch`. New error codes: `DB_BATCH_RESULT_MISMATCH` and `CLOUDFLARE_D1_BATCH_RESULT_MISSING`.
