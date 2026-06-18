import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
//
// Two files are deliberately excluded — the same split `@lesto/cli` uses:
//   - `index.ts`   the re-export barrel (no behaviour to cover)
//   - `bin.ts`     the executable entry: pure wiring (parse argv, open a real
//                  SQLite db, read/write the tracked report files, `console.log`)
//                  that hands every decision to the covered `runReport` core. It
//                  holds no branch a unit test could meaningfully assert without
//                  shelling out a process; its logic lives in `report-run.ts`,
//                  which IS covered to 100%.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
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
