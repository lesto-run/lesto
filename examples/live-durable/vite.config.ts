import { defineConfig } from "vite";

/**
 * The client bundle for the durable OPFS-SQLite `live()` round-trip (ADR 0042 Tier 4, v1
 * Inc5/Inc6). `src/main.ts` imports `openOpfsSqliteDatabase` from the opt-in `@lesto/live/opfs`
 * subpath, which reaches the optional `@sqlite.org/sqlite-wasm` peer through a LITERAL
 * `import("@sqlite.org/sqlite-wasm")` — so a real `vite build` statically wires the engine into
 * `dist/` (the fix for the Inc6 finding that a non-literal specifier was silently dropped;
 * L-f5bffa40 → L-4ed8e591, see `README.md`).
 */
export default defineConfig({
  optimizeDeps: {
    // The wasm/worker engine must not go through the dev server's esbuild pre-bundle scan (it
    // ships its own worker + `.wasm` asset loading) — the standard exclusion for sqlite-wasm.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  build: {
    // Fixed, unhashed output names — this example has one entry and no need for
    // cache-busting, and it keeps the tiny static file server in `src/app.ts` from having to
    // discover a hashed filename.
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
