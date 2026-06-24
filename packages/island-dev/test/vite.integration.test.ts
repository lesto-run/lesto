/**
 * The one thing the build sandbox CAN verify of the real Vite edge: that an island
 * module is TRANSFORMED with React Fast Refresh, and — the empirical crux — that a
 * `export default defineIsland(...)` module is a refresh BOUNDARY (its update is
 * accepted in place, preserving `useState`) rather than a module whose update
 * propagates to a full reload.
 *
 * It runs Vite in `middlewareMode` (no `listen`, so NO port is bound — safe in the
 * sandbox) and asks it to transform the island fixture, then inspects the emitted
 * code for the Fast-Refresh registration + the self-accepting `import.meta.hot`
 * footer that marks a boundary. The live HMR round-trip (an edit in a real browser)
 * is the remaining e2e step the sandbox cannot run.
 *
 * Excluded from the unit suite's intent but run by the gate, mirroring
 * `@lesto/styles`'s `tailwind.integration.test.ts`.
 */

import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Server } from "node:http";
import type { ViteDevServer } from "vite";

import { ENTRY_PATH, isViteOwnedPath, VITE_BASE } from "../src/paths";

const fixture = fileURLToPath(new URL("./fixtures/counter.tsx", import.meta.url));

describe("Vite island Fast-Refresh transform", () => {
  let server: ViteDevServer;
  let httpServer: Server;

  beforeAll(async () => {
    // HMR must NOT be `false` or `@vitejs/plugin-react` skips the Fast-Refresh
    // transform (`skipFastRefresh = … || config.server.hmr === false`). Attach HMR to
    // an http server we never `listen()` on, so the refresh transform is enabled while
    // NO port is bound (sandbox-safe).
    httpServer = createHttpServer();

    server = await createServer({
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true, hmr: { server: httpServer } },
      plugins: [react()],
      optimizeDeps: { noDiscovery: true, include: [] },
    });
  });

  afterAll(async () => {
    await server.close();
    httpServer.close();
  });

  it("registers components for Fast Refresh and makes the island a boundary", async () => {
    const result = await server.transformRequest(`/@fs${fixture}`);

    expect(result).not.toBeNull();
    const code = result?.code ?? "";

    // The react-refresh/babel transform ran: the component is registered by signature.
    expect(code).toContain("$RefreshReg$");
    expect(code).toContain("$RefreshSig$");
    expect(code).toContain('$RefreshReg$(_c, "Counter")');

    // The crux: a `export default defineIsland(...)` module IS a Fast-Refresh BOUNDARY.
    // plugin-react emits the self-accepting footer (`import.meta.hot.accept` +
    // `registerExportsForReactRefresh`), NOT the non-boundary bail-out (a bare,
    // unconditional `import.meta.hot.invalidate()` at top level → propagate → reload).
    // So an island edit re-renders in place, preserving `useState`. The
    // `import.meta.hot.invalidate(message)` that DOES appear is the conditional guard
    // INSIDE the accept handler — it fires only if the runtime boundary check rejects
    // a future edit, which it won't while `defineIsland(...)` returns the component.
    expect(code).toContain("import.meta.hot.accept(");
    expect(code).toContain("registerExportsForReactRefresh");
    expect(code).toContain("validateRefreshBoundaryAndEnqueueUpdate");
  });
});

/**
 * Regression for the URL-ownership P0: islands live INSIDE the project root, so Vite
 * serves them at ROOT-RELATIVE URLs (not `/@fs/`). With the dedicated base, the entry's
 * island import is rewritten to a `<base>…` URL that `isViteOwnedPath` MUST own — else
 * the browser's island fetch falls through to the app and 404s (no hydration, no HMR).
 * This asserts the entry-rewrite URL is owned, end-to-end through Vite's import analysis.
 */
describe("Vite island URL ownership (base prefix)", () => {
  let server: ViteDevServer;
  let httpServer: Server;

  const ENTRY_MODULE_ID = "\0lesto-island-entry.tsx";

  beforeAll(async () => {
    httpServer = createHttpServer();

    // The same virtual-entry plugin shape `vite.ts` ships: `/client.js` (base-stripped)
    // → the synthesized entry that statically imports the island by ABSOLUTE path.
    const entryPlugin = {
      name: "lesto:island-entry",
      enforce: "pre" as const,
      resolveId(id: string) {
        return id === ENTRY_PATH ? ENTRY_MODULE_ID : undefined;
      },
      load(id: string) {
        return id === ENTRY_MODULE_ID
          ? `import Island0 from ${JSON.stringify(fixture)};\n`
          : undefined;
      },
    };

    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: process.cwd(),
      base: VITE_BASE,
      server: { middlewareMode: true, hmr: { server: httpServer } },
      plugins: [entryPlugin, react()],
      optimizeDeps: { noDiscovery: true, include: [] },
    });
  });

  afterAll(async () => {
    await server.close();
    httpServer.close();
  });

  it("rewrites the entry's island import to a Vite-owned base-prefixed URL", async () => {
    // Vite strips the base before resolving, so transform the bare entry id.
    const result = await server.transformRequest(ENTRY_PATH);

    const code = result?.code ?? "";
    const match = /from "([^"]*counter[^"]*)"/.exec(code);

    expect(match).not.toBeNull();
    const islandUrl = match?.[1] ?? "";

    // The crux: the island URL is under the base (NOT `/@fs/` or a bare `/test/…`)…
    expect(islandUrl.startsWith(VITE_BASE)).toBe(true);
    // …and the dispatch predicate owns it, so the browser's fetch reaches Vite.
    expect(isViteOwnedPath(islandUrl)).toBe(true);
  });
});
