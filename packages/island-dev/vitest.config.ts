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
      // The barrel (re-export only) is excluded as every sibling package excludes
      // its `index.ts`. `vite.ts` — the real `vite.createServer` + the
      // Connect→response bridge + the plugin imports + `node:fs`/dynamic-import
      // edge — is the `bin`-equivalent (excluded exactly as `@lesto/assets`'s
      // `bun.ts` and `@lesto/styles`'s `tailwind.ts`); it cannot run under vitest,
      // and the orchestration it feeds (`dev-server.ts`) is covered with fakes.
      exclude: ["src/index.ts", "src/vite.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
