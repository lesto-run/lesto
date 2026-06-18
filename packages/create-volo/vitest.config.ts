import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // src/index.ts is the re-export barrel; src/bin.ts is the thin executable
      // entrypoint (shebang + argv read + real-dependency wiring), exercised by a
      // spawn-based e2e test rather than instrumented in-process.
      exclude: ["src/index.ts", "src/bin.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
