import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
//
// react/react-dom major lockstep (a split pair throws at client render) is
// enforced repo-wide by scripts/assert-isolated-node-modules.mjs
// (assertReactLockstep) — keep this package's two devDep pins on one major.

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
