import { defineConfig } from "vitest/config";

// New Keel code — held to the full bar. content-store is written here, not
// folded in, so it ships at 100% coverage from its first commit.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
