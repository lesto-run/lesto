import { defineConfig } from "vitest/config";

// SKELETON (ADR 0040). Coverage thresholds are deliberately OFF here — unlike every
// shipping @lesto/* package, which holds 100%. This package is a non-functional shape:
// its functions are `NOT_IMPLEMENTED` stubs and its one test is `it.skip`, so there is
// no reachable behavior to cover. The 100% bar applies the moment this becomes real
// (the ADR 0029 AS build, with ADR 0040 as its Phase 3) — at which point this config
// gains the same thresholds block the reference packages use. A skeleton that faked
// coverage would be a lie; a skeleton that claimed 100% of nothing would be worse.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
