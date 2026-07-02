import { defineConfig } from "vite";

/**
 * The client bundle for the durable OPFS-SQLite `live()` round-trip (ADR 0042 Tier 4, v1
 * Inc5/Inc6). This is the ONE piece of config this example exists to exercise: `src/main.ts`
 * imports `@lesto/live`'s `openOpfsSqliteDatabase`, which reaches the optional
 * `@sqlite.org/sqlite-wasm` peer through a dynamic `import(SQLITE_WASM_MODULE)` whose specifier
 * is typed as a bare `string` (so `tsc` never tries to resolve the optional peer). A `vite build`
 * against this config is the proof that a real bundler still wires that import correctly with
 * the peer installed — see `README.md` for what this build found.
 */
export default defineConfig({
  optimizeDeps: {
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
