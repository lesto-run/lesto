import { defineConfig } from "vitest/config";

// FROZEN BASELINE — folded in from Docks (@usedocks/*).
//
// Lesto's bar is 100% coverage. This package entered the monorepo below that
// bar, so its threshold is frozen here rather than enforced, and ratcheted up
// in follow-up waves. New or modified code in this package is still expected to
// ship fully covered — see CONTENT_COVERAGE.md for the ratchet plan.
export default defineConfig({
  test: {
    // The FIRST HTML-sanitize call cold-inits the sanitizer — `require("jsdom")` + a
    // `new JSDOM("")` to give DOMPurify a DOM (see src/sanitize.ts) — and loading jsdom's
    // module graph once can exceed vitest's 5s default on a contended CI runner; every
    // subsequent call then runs in <50ms. Give it headroom. (A per-worker setupFiles warm-up
    // would remove the cost instead of hiding it — tracked as a follow-up.)
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
