import { defineConfig } from "vite";

/**
 * The client bundle for the Tier-4 v1 capstone (ADR 0042 Inc8, corrected in Inc9). `src/main.ts`
 * reaches the durable OPFS engine through the opt-in `@lesto/live/opfs` subpath, which spawns a
 * dedicated Worker (`opfs-worker.ts`) whose LITERAL `import("@sqlite.org/sqlite-wasm")` a real
 * `vite build` statically wires into the worker chunk — the fix for the Inc6 bundler finding that a
 * non-literal specifier was silently dropped (see `examples/live-durable/README.md`). The OPFS engine
 * MUST run in a Worker: its SAHPool VFS needs `createSyncAccessHandle`, which is Worker-only
 * (`[Exposed=DedicatedWorker]`) in every browser — booting it on the main thread was the Inc9 P0.
 * This example's `vite build` is what CI verifies for the client half; the browser session that
 * exercises the built bundle is the manual step + the Playwright smoke in `README.md`.
 */
export default defineConfig({
  optimizeDeps: {
    // The wasm/worker engine ships its own worker + `.wasm` loading — keep it out of the dev
    // server's esbuild pre-bundle scan (the standard exclusion for sqlite-wasm).
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  // The OPFS engine worker (`@lesto/live/opfs`) itself dynamically-imports sqlite-wasm, so its bundle
  // is code-split — which Vite's default `iife` worker format cannot emit. `es` is required.
  worker: {
    format: "es",
  },
  build: {
    // Fixed, unhashed names for the MAIN entry (`index.js`) — one entry, no cache-busting needed, so
    // the tiny static server in `src/app.ts` serves it by a known path. NOTE this does NOT cover the
    // WORKER sub-bundle (that's `worker.rollupOptions`, not this one): the worker chunk + the sqlite
    // engine + the `.wasm` under `/assets/` ARE content-hashed. That's fine — the static server serves
    // by request path and the hashed worker URL is baked into the main bundle by Vite — but it means
    // the unhashed main `index.js` should be sent no-cache (a caching follow-up is filed on the board).
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
