import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// The SSE consumer's only browser touch — the default `browserLiveEnvironment` — is
// covered by stubbing the global `EventSource` (vi.stubGlobal). The only OURS excluded
// (beyond the barrel) are the two browser-only halves of the OPFS engine — `opfs-sqlite.ts`
// (the `new Worker(...)` spawn) and `opfs-worker.ts` (the worker-side sqlite/SAHPool binding).
// The logic that decides anything — the request-correlation RPC client `opfs-rpc.ts` — is
// covered (tested against a fake port pair in `test/opfs-rpc.test.ts`); see the `exclude` note.
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
      // `opfs-sqlite.ts` (spawns a real `Worker`) and `opfs-worker.ts` (dynamic-imports
      // `@sqlite.org/sqlite-wasm` and installs the OPFS SAHPool VFS — Worker-only) are
      // coverage-excluded like `@lesto/runtime`'s `sqlite-drivers.ts`: browser-only wiring that
      // cannot run under Node/vitest. Everything they decide is tested elsewhere — the request
      // correlation in `opfs-rpc.ts` (`test/opfs-rpc.test.ts`) and the atomic rows+cursor
      // transaction in `sqlite-store.ts` against `openSqlite`. No exclusion without a real gate:
      // the end-to-end browser boot of these two is covered by the Playwright smoke (L-2e410682).
      exclude: [
        "src/index.ts",
        "src/opfs-sqlite.ts",
        "src/opfs-worker.ts",
        "**/live-protocol/**",
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
