import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds
// (the coverage gate runs `test:cov` and trusts the exit code — without these the
// bar is measured but never enforced). A line we cannot reach is a line we should
// not have written.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The barrel (re-export only, no logic) is excluded exactly as the sibling
      // packages exclude their `index.ts`. `tailwind.ts` — the real `@tailwindcss/*`
      // engine + `node:fs` edge — is the `bin`-equivalent (excluded exactly as
      // `@lesto/assets`'s `bun.ts` is); its behavior is verified by the integration
      // test that compiles a real fixture, not by branch coverage.
      exclude: ["src/index.ts", "src/tailwind.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
