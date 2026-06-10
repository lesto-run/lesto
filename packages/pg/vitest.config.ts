import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // pg-driver.ts is the thin engine wiring (a `require("pg")` + `new Pool`)
      // that needs a real Postgres install to run; its consumer's decisions
      // (translation, the SqlDatabase mapping, pooled transactions) live in the
      // covered adapter.ts, tested against a fake Pool.
      exclude: ["src/index.ts", "src/pg-driver.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
