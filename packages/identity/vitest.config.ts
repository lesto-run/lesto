import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
export default defineConfig({
  test: {
    // No suite-wide timeout override: the scrypt-bound paths (password + recovery-code
    // hashing) run under an injected cheap-cost `hasher` in tests (see test/cheap-hasher.ts),
    // so every test finishes well inside vitest's 5s default — and that default keeps
    // honest hang-detection on the whole suite instead of a 30s tourniquet.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
