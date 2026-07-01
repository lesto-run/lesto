import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// The SSE consumer's only browser touch — the default `browserLiveEnvironment` — is
// covered by stubbing the global `EventSource` (vi.stubGlobal), so nothing of OURS is
// excluded but the barrel.
//
// `@lesto/live-protocol` is excluded for a tooling reason, not a coverage one: Vitest's
// coverage `isIncluded` matches the `include` glob with picomatch `contains: true`
// (substring) after an "external file" guard that is a naive `path.startsWith(root)`. This
// package's root — `packages/live` — is a STRING PREFIX of `packages/live-protocol`, so the
// guard treats that sibling as internal and its `/src/` segment then matches `src/**/*.ts`.
// Left unexcluded, the sibling's (independently 100%-covered) source is measured against
// THIS package's tests and can never reach 100%. Sibling roots that do not share the prefix
// (`@lesto/errors`, `packages/live-server`) are correctly dropped by the guard already.
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "**/live-protocol/**"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
