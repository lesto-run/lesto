import { defineConfig } from "vitest/config";

// The integration suite tests *other* packages' behavior over a real socket, so
// line coverage of its own source is meaningless — there is no `src/`. It gates
// on green, not on coverage. A generous timeout covers the server boot.
//
// `fileParallelism: false`: the Postgres leg points every file at ONE shared
// database, and files share global bookkeeping (`schema_migrations`) and store
// tables. Running files in parallel races their `DROP TABLE` setup against each
// other's migrators ("relation does not exist" mid-flight). A single socket is
// inherently serial; run the files serially so the suite is deterministic.
export default defineConfig({
  test: {
    testTimeout: 15_000,
    fileParallelism: false,
  },
});
