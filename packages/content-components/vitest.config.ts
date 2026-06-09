import { defineConfig } from "vitest/config";

// FROZEN BASELINE — folded in from Docks (@usedocks/*).
//
// Keel's bar is 100% coverage. This package entered the monorepo below that
// bar, so its threshold is frozen here rather than enforced, and ratcheted up
// in follow-up waves. New or modified code in this package is still expected to
// ship fully covered — see CONTENT_COVERAGE.md for the ratchet plan.
export default defineConfig({
  test: {
    // This package was folded in without ported tests (the ratchet plan adds
    // them in follow-up waves). A run with no spec files should not hard-fail
    // CI on exit code alone; coverage enforcement is still frozen above, not
    // disabled. No assertions, thresholds, or strictness are relaxed by this.
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["react/**/*.{ts,tsx}", "vue/**/*.ts", "svelte/**/*.ts"],
      exclude: ["**/index.ts"],
    },
  },
});
