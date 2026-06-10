import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The bar is non-negotiable: 100% coverage, enforced in CI by these thresholds.
// A line we cannot reach is a line we should not have written.
//
// React resolution note: this package historically pinned react@18 as a
// devDependency, but the workspace only carries react-dom@19. A mixed
// react@18 / react-dom@19 pair throws at render time ("Objects are not valid
// as a React child") because the element shape differs across the major. The
// package's peer range is `react >=18`, so we align the *test* runtime on the
// hoisted react@19 — matching react-dom@19 and the rest of the monorepo
// (e.g. @keel/ui) — via an exact-match alias. The alias is scoped to `react`
// and its jsx runtimes; `react-dom` is left untouched.
const reactRoot = fileURLToPath(new URL("../../node_modules/react", import.meta.url));

export default defineConfig({
  test: {
    // jsdom gives the error-boundary / client-render tests a real DOM to mount
    // into; the sanitizer also lazy-loads jsdom under Node, which this satisfies.
    environment: "jsdom",
    coverage: {
      provider: "v8",
      include: ["react/**/*.{ts,tsx}", "vue/**/*.ts", "svelte/**/*.ts"],
      exclude: ["**/index.ts"],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${reactRoot}/index.js` },
      { find: /^react\/jsx-runtime$/, replacement: `${reactRoot}/jsx-runtime.js` },
      { find: /^react\/jsx-dev-runtime$/, replacement: `${reactRoot}/jsx-dev-runtime.js` },
    ],
  },
});
