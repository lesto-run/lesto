import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
export default defineConfig({
  test: {
    // `.out/` is this package's gitignored scratch root — the e2e suite builds throwaway
    // projects there (it must live inside the repo so their `@lesto/*` imports resolve), and
    // it collects hand-written probes too. Vitest's default `include` would happily pick up a
    // stray `*.test.ts` left in one of those trees and run it as if it were a real suite: two
    // reviewers independently hit that, seeing a RED `test:cov` from files that are not part
    // of the package. Excluding the whole scratch root keeps the suite exactly the committed
    // `test/` tree. (Same class as the worktree-sibling discovery trap in AGENTS.md.)
    exclude: ["**/node_modules/**", "**/dist/**", ".out/**"],

    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        // bin.ts is the thin executable wiring (shebang, process.argv, real
        // dependency construction); its logic lives in covered modules and it
        // is exercised end-to-end by a test that spawns it.
        "src/bin.ts",
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
