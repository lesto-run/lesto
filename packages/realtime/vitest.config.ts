import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        // Pure wiring: the real `pg.Client` factory. Every transport decision is
        // tested in `pg-transport.ts` against the `PgListenClient` seam; this needs
        // `pg` installed and a live socket. (Mirrors `@lesto/pg`'s `pg-driver.ts`.)
        "src/pg-client.ts",
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
