import { defineConfig } from "vite";

/**
 * The client bundle for the Tier-4 v1 capstone (ADR 0042 Inc8). `src/main.ts` reaches the durable
 * OPFS engine through the opt-in `@lesto/live/opfs` subpath, whose LITERAL
 * `import("@sqlite.org/sqlite-wasm")` a real `vite build` statically wires into `dist/` — the fix for
 * the Inc6 bundler finding that a non-literal specifier was silently dropped (see
 * `examples/live-durable/README.md`). This example's `vite build` is what CI verifies for the client
 * half; the browser session that exercises the built bundle is the manual step in `README.md`.
 */
export default defineConfig({
  optimizeDeps: {
    // The wasm/worker engine ships its own worker + `.wasm` loading — keep it out of the dev
    // server's esbuild pre-bundle scan (the standard exclusion for sqlite-wasm).
    exclude: ["@sqlite.org/sqlite-wasm"],
  },
  build: {
    // Fixed, unhashed output names — one entry, no cache-busting needed, and it keeps the tiny
    // static file server in `src/app.ts` from having to discover a hashed filename.
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
