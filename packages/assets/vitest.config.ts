import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// `bun.ts` (real Bun.build + node:fs) and the browser `shims/` cannot run under
// vitest — they are the `bin`-equivalent edge, excluded exactly as `index.ts`
// is; the orchestration they feed (`build-client.ts`) is covered with fakes.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/bun.ts", "src/shims/**"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
