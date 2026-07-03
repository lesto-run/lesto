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
    // module graph once can exceed vitest's 5s default on a contended CI runner. Rather than
    // HIDE that with a blanket 30s timeout (which also loosens hang detection for the other
    // ~390 tests), pay it ONCE per worker in `setupFiles` (which runs in the test process, so
    // it primes the require cache for every test that worker runs). Every subsequent call is
    // <50ms, so vitest's tight 5s default stands.
    setupFiles: ["./test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
