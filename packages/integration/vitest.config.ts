import { defineConfig } from "vitest/config";

// The integration suite tests *other* packages' behavior over a real socket, so
// line coverage of its own source is meaningless — there is no `src/`. It gates
// on green, not on coverage. A generous timeout covers the server boot.
export default defineConfig({
  test: {
    testTimeout: 15_000,
  },
});
