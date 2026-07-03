import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.

export default defineConfig({
  test: {
    // jsdom gives the error-boundary / client-render tests a real DOM to mount
    // into; the sanitizer also lazy-loads jsdom under Node, which this satisfies.
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["react/**/*.{ts,tsx}", "vue/**/*.ts", "svelte/**/*.ts"],
      exclude: ["**/index.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
