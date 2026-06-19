import { defineConfig } from "vitest/config";

// PREVIEW package — see ADR 0021.
//
// `@lesto/ai` is an experimental seam (the app-builder AI primitives) that
// enters BELOW Lesto's 100%-coverage bar, exactly as `@lesto/content-embeddings`
// does. It is excluded from the central gate not by this file but by its
// package.json declaring NO `test:cov` script — `scripts/coverage-gate.ts` only
// runs packages that declare one (its line 35). This config therefore enforces
// no thresholds; the pure core is still expected to be fully tested, and is.
//
// `bin`/`index` style barrels are excluded from the report for the same reason
// the gated packages exclude them: re-export barrels hold no behaviour to cover.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
