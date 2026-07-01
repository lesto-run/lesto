import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// The poll loop's real timers are driven by an injected seam, so every branch —
// including a failed poll and a mid-tick unsubscribe — is reachable in a unit test.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        // Pure wiring: the real `pg` logical-replication client. Every change-source
        // decision is tested in `replication.ts` against the `PgReplicationClient` seam;
        // this needs `pg` installed and a live WAL stream. (Mirrors `@lesto/realtime`'s
        // `pg-client.ts` and `@lesto/pg`'s `pg-driver.ts`.)
        "src/pg-replication-client.ts",
        // Pure wiring: the real `pg` catalog probe for the replica-identity guard. The engine's
        // use of its boolean is tested against the injected `replicaIdentity` seam; the query
        // itself needs a live Postgres. Coverage-excluded like the replication client.
        "src/pg-catalog.ts",
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
