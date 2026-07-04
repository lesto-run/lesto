import { defineConfig } from "vite";

/**
 * The client bundle for the durable OPFS-SQLite `live()` round-trip (ADR 0042 Tier 4, v1
 * Inc5/Inc6, corrected in Inc9). `src/main.ts` imports `openOpfsSqliteDatabase` from the opt-in
 * `@lesto/live/opfs` subpath, which spawns a dedicated Worker (`opfs-worker.ts`) whose LITERAL
 * `import("@sqlite.org/sqlite-wasm")` a real `vite build` statically wires into the worker chunk
 * (the fix for the Inc6 finding that a non-literal specifier was silently dropped; L-f5bffa40 →
 * L-4ed8e591, see `README.md`). The engine MUST run in a Worker: its SAHPool VFS needs
 * `createSyncAccessHandle`, which is Worker-only in every browser — the Inc9 P0 fix.
 */
export default defineConfig({
  optimizeDeps: {
    // The wasm/worker engine must not go through the dev server's esbuild pre-bundle scan (it
    // ships its own worker + `.wasm` asset loading) — the standard exclusion for sqlite-wasm.
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  // The OPFS engine worker (`@lesto/live/opfs`) dynamically-imports sqlite-wasm, so its bundle is
  // code-split — which Vite's default `iife` worker format cannot emit. `es` is required.
  worker: {
    format: "es",
  },
  build: {
    // Fixed, unhashed names for the MAIN entry (`index.js`) — one entry, no cache-busting, so the
    // static server serves it by a known path. This does NOT cover the WORKER sub-bundle
    // (`worker.rollupOptions`): the worker chunk + sqlite engine + `.wasm` under `/assets/` ARE
    // content-hashed (fine — served by request path, URL baked into the main bundle by Vite).
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
