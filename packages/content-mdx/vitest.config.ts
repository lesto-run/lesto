import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
//
// index.ts barrels are pure re-exports (no logic) and are excluded, matching
// the convention across the monorepo (see packages/ui, packages/forms).
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/index.ts", "src/components/index.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
