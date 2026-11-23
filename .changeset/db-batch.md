---
"@lesto/db": minor
"@lesto/pg": minor
"@lesto/cloudflare": minor
---

`SqlDatabase` gains a required `batch(statements)`: a list of `{ sql, params, returns }` run as one atomic unit — every statement commits, or none does — resolving one tagged result per statement (`{ returns: "rows", rows }` or `{ returns: "changes", changes }`). An empty batch resolves `[]` without touching the driver.

It is the one atomic primitive every driver can offer. Cloudflare D1 has no interactive transaction, so `d1ToSqlDatabase` maps `batch` onto a single native `d1.batch()` call. `adaptSyncSqlite` (and through it `openSqlite` and the OPFS driver), `@lesto/pg` and `hyperdriveToSqlDatabase` run it as one `BEGIN`…`COMMIT` on one connection through the new shared `batchViaTransaction`; on a tx handle it runs flat inside the open transaction.

`createDb(...).batch([...])` builds a batch from the query builders with no hand-written SQL: pass `select`, `insert(…).values(…)`, `.returning()`, `update(…).set(…).where(…)` and `delete(…).where(…)` stages without their terminal, and get a tuple typed per slot. Each stage compiles to the same SQL its own terminal sends. `rawRows` and `rawChanges` add hand-written statements (a guard such as `INSERT … SELECT … WHERE changes() = 0`) to the same batch. A batch cannot branch on its own reads — the check moves into the write.

**Breaking for hand-written handles:** a custom `SqlDatabase` must now implement `batch`; `batch: (statements) => batchViaTransaction(handle, statements)` is the one-line fix for any driver that has `transaction`. A hand-typed `D1Database` must declare `batch`. New error codes: `DB_BATCH_RESULT_MISMATCH` and `CLOUDFLARE_D1_BATCH_RESULT_MISSING`.
