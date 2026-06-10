import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // sqlite-drivers.ts is the thin engine wiring (a native-addon `require`
      // and a Bun-only dynamic import that cannot both run under one test
      // runtime); its consumers' decisions live in the covered sqlite.ts.
      exclude: ["src/index.ts", "src/sqlite-drivers.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
