/**
 * Drop the queue's three tables — the shared teardown the cross-driver integration
 * suites run before reinstalling a fresh queue schema.
 *
 * WHY drop ALL THREE (`lesto_job_deps`, `lesto_job_batches`, `lesto_jobs`), not
 * just `lesto_jobs`: on Postgres the database persists across tests (every test
 * opens a fresh pool onto the SAME socket), so a batch test's leftover
 * `lesto_job_deps` edge survives into the next test. Dropping `lesto_jobs` alone
 * resets its IDENTITY sequence, so the next batch's ids restart at 1,2 and it
 * re-inserts the SAME `(job_id, depends_on_id)` pair — colliding with the survivor
 * on the edge table's composite PRIMARY KEY and failing `enqueueBatch` before the
 * test under proof even runs. Clearing the satellite tables too gives each test
 * the fresh schema it assumes. (On SQLite every test gets a brand-new in-memory
 * db, so these drops are a harmless no-op.)
 *
 * Drop ORDER is NOT a constraint: `lesto_job_deps` carries no foreign key (see
 * `queue.ts` — its only key is the composite `PRIMARY KEY (job_id, depends_on_id)`,
 * and `lesto_jobs.batch_id` references nothing), so any order succeeds. Deps-first
 * is kept only because it is marginally fail-safer if an `exec` dies mid-teardown:
 * the satellite rows go before the table their ids point at.
 */

/** The minimal handle shape the drop needs: a multi-statement-safe `exec`. */
interface QueueTableHandle {
  exec(sql: string): Promise<void>;
}

/** The queue's three tables, satellites first (see the module's drop-order note). */
const QUEUE_TABLES = ["lesto_job_deps", "lesto_job_batches", "lesto_jobs"] as const;

/**
 * Drop the queue trio (`IF EXISTS`) on `handle`. Each call site keeps its OWN other
 * table drops inline and calls this for the queue tables — the WHY lives here once.
 */
export async function dropQueueTables(handle: QueueTableHandle): Promise<void> {
  for (const table of QUEUE_TABLES) {
    await handle.exec(`DROP TABLE IF EXISTS ${table}`);
  }
}
