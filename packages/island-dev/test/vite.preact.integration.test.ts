/**
 * The preact-dialect twin of `vite.integration.test.ts`: the one thing the build
 * sandbox CAN verify of the `@prefresh/vite` edge — that a preact island module is
 * transformed into a Fast-Refresh BOUNDARY (its update is accepted in place,
 * preserving `useState`) rather than a module whose update propagates to a full
 * reload — AND that the dialect's runtime resolves to PREACT, not a mixed
 * react/preact graph (the `react/jsx-dev-runtime` → `preact/jsx-runtime` alias must
 * hold in DEV, where Vite emits `jsxDEV`).
 *
 * It is built from the SHIPPED `viteIslandConfig({ dialect: "preact" })` output
 * (its real anchored alias map + the new runtime `dedupe`), so it proves the actual
 * config — not a hand-rolled stand-in. It runs Vite in `middlewareMode` (no `listen`,
 * so NO port is bound — safe in the sandbox) with `noDiscovery` (no esbuild
 * pre-bundle); the live HMR round-trip (a real-browser edit) is the e2e step the
 * sandbox cannot run and lives in `packages/e2e`.
 *
 * `@prefresh/vite` is imported statically HERE — that is safe under vitest (node).
 * The lazy import in `vite.ts:45` exists for a different runtime: a static import in
 * the Bun dev process deadlocks its rolldown native binding.
 *
 * Excluded from the unit suite's intent but run by the gate, mirroring the react
 * integration test and `@lesto/styles`'s `tailwind.integration.test.ts`.
 */

import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";

import prefresh from "@prefresh/vite";
import { createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Server } from "node:http";
import type { PluginOption, ViteDevServer } from "vite";

import { viteIslandConfig } from "../src/config";

const fixture = fileURLToPath(new URL("./fixtures/counter.tsx", import.meta.url));

describe("Vite island Fast-Refresh transform (preact / @prefresh/vite)", () => {
  let server: ViteDevServer;
  let httpServer: Server;

  beforeAll(async () => {
    // HMR must NOT be `false` or the refresh transform is skipped. Attach HMR to an
    // http server we never `listen()` on, so the transform runs while NO port binds.
    httpServer = createHttpServer();

    // The SHIPPED preact config: its real anchored `react*` → `preact/compat` alias map
    // plus the runtime `dedupe`. Ports are irrelevant in middlewareMode.
    const config = viteIslandConfig({
      root: process.cwd(),
      vitePort: 0,
      hmrPort: 0,
      dialect: "preact",
    });

    server = await createServer({
      configFile: false,
      logLevel: "silent",
      root: process.cwd(),
      resolve: { alias: config.resolve.alias, dedupe: config.resolve.dedupe },
      server: { middlewareMode: true, hmr: { server: httpServer } },
      // `@prefresh/vite` is typed against its OWN bundled `vite` copy (distinct from this
      // package's), so its plugin isn't assignable to our `PluginOption` without a cast —
      // the same duplicate-install type gap `vite.ts` bridges for the shipped wiring.
      plugins: [prefresh()] as PluginOption[],
      optimizeDeps: { noDiscovery: true, include: [] },
    });
  });

  afterAll(async () => {
    await server.close();
    httpServer.close();
  });

  it("makes a preact island a refresh boundary and resolves the runtime to preact", async () => {
    const result = await server.transformRequest(`/@fs${fixture}`);

    expect(result).not.toBeNull();
    const code = result?.code ?? "";

    // The prefresh transform ran: the component is registered with the prefresh runtime.
    expect(code).toContain("__PREFRESH__.register");
    expect(code).toContain('$RefreshReg$(_c, "Counter")');

    // The crux: a `export default defineIsland(...)` module IS a Fast-Refresh BOUNDARY —
    // prefresh emits a self-accepting `import.meta.hot.accept` that flushes the update in
    // place (preserving `useState`) rather than reloading. `flushUpdates` is prefresh's
    // in-place applier; its presence (vs a bare `location.reload()`) marks the boundary.
    expect(code).toContain("import.meta.hot.accept(");
    expect(code).toContain("flushUpdates");

    // The runtime is PREACT end-to-end — no react/preact mixing. `useState` resolves to
    // preact/compat AND the DEV jsx runtime (`jsxDEV`) resolves to preact/jsx-runtime
    // (the `react/jsx-dev-runtime` alias, which a `react/jsx-runtime`-only map would miss).
    expect(code).toMatch(/import \{ useState \} from "[^"]*\/preact\/compat\//);
    expect(code).toMatch(/import \{ jsxDEV \} from "[^"]*\/preact\/jsx-runtime\//);
  });
});
