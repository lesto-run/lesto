/**
 * The cold-start guard for L-90d2de01: a real Vite dev server, a COLD dep cache, and an
 * app whose island graph reaches ordinary npm packages must settle in exactly ONE
 * optimizer pass.
 *
 * WHY THIS IS THE ASSERTION. A second pass is not a perf nit — it is the whole 504 class.
 * Vite discovers a dep mid-crawl, cancels the in-flight optimize, re-runs it, and the
 * pre-bundle hash bumps; a browser request already in flight for the old `?v=` hash then
 * throws `ERR_OUTDATED_OPTIMIZED_DEP` → a 504 "Outdated Optimize Dep". Vite's only
 * recovery is an HMR `full-reload`, which races the browser's HMR-WS connect and can lose
 * on cold start — the island silently never hydrates on that load.
 *
 * HOW A PASS IS COUNTED. `optimizeDeps.esbuildOptions.plugins` are threaded into BOTH the
 * scanner's esbuild context and every optimizer run. The two are told apart by their esbuild
 * options: the scanner bundles from `stdin`, an optimizer run from `entryPoints` (see
 * {@link classifyEsbuildRun}). So a counting plugin gives an exact, public,
 * non-timing-dependent count of each.
 *
 * NON-VACUOUS BY CONSTRUCTION. The second test is the RED case: the identical server with
 * `optimizeDeps.entries` emptied — the state this package shipped before L-90d2de01 —
 * must run the optimizer TWICE and must NOT pre-bundle the lazy island's dep. If the fix
 * ever silently no-ops (a stale scan entry, a dropped glob), the green test and the red
 * test cannot both hold.
 *
 * Runs Vite in `middlewareMode` (no `listen`, so NO port is bound — sandbox-safe) and
 * drives the module crawl the browser would: follow STATIC imports only, so a lazy
 * island's dep can be pre-bundled by the SCANNER alone (the crawl never reaches it).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import prefresh from "@prefresh/vite";
import reactRefresh from "@vitejs/plugin-react";
import { createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";

import type { IslandFile } from "@lesto/assets";
import type { Server } from "node:http";
import type { PluginOption, ViteDevServer } from "vite";

import { viteIslandConfig } from "../src/config";
import { devEntrySource, SCAN_ENTRY_PATH, scanEntrySource } from "../src/entry";
import { ENTRY_PATH, VITE_BASE } from "../src/paths";
import { writeScanEntry } from "../src/vite";

const ROOT = fileURLToPath(new URL("./fixtures/dep-app", import.meta.url));
const STUB = fileURLToPath(new URL("./fixtures/dep-app/lesto-ui-stub.ts", import.meta.url));

/** The dir `writeScanEntry` creates under the fixture — removed after each test. */
const SCAN_DIR = dirname(join(ROOT, SCAN_ENTRY_PATH));

/** The dialects `lesto dev` serves — both must cold-start in one optimizer pass. */
type Dialect = "react" | "preact";

const island = (name: string, file: string, lazy: boolean): IslandFile => ({
  name,
  importPath: join(ROOT, "app/islands", file),
  lazy,
  ssr: false,
});

/**
 * `chart` reaches `preact-render-to-string` through a RELATIVE hop (`app/lib/render.ts`),
 * so a naive "read the island files" pre-scan would miss it. `panel` is LAZY: the entry
 * reaches it by dynamic `import()` only, so its `zod` is unreachable from the static crawl
 * and can be pre-bundled by the dep scanner alone.
 */
const ISLANDS = [
  island("Counter", "counter.tsx", false),
  island("Chart", "chart.tsx", false),
  island("Panel", "panel.tsx", true),
] as const;

/** The three `@lesto/*` modules `synthesizeEntry` always imports; neither is a dep here. */
const STUB_ALIASES = ["@lesto/ui", "@lesto/ui/client", "@lesto/observability/rum"].map((find) => ({
  find: new RegExp(`^${find.replace(/[/-]/g, "\\$&")}$`),
  replacement: STUB,
}));

interface EsbuildRunCounts {
  scanner: number;
  optimizer: number;

  /**
   * Set (once) if an esbuild run under `optimizeDeps` matched NEITHER positive marker — i.e.
   * the scanner/optimizer discriminator drifted. RECORDED here, deliberately not thrown: a
   * throw inside plugin `setup()` is caught by Vite's own scan/optimize error handling and
   * routed to a logger this test SILENCES (`logLevel: "silent"`; the scan catch is config.js
   * ~34193, "Failed to run dependency scan"), so on drift the throw's re-verify message would
   * reach nobody and the test would fail only as a bare count mismatch. The `counts` object is
   * a channel Vite cannot swallow; the test body asserts this stays undefined.
   */
  drift?: string;
}

/** The re-verify pointer surfaced via {@link EsbuildRunCounts.drift} when the discriminator drifts. */
const DRIFT_MESSAGE =
  "esbuild run under optimizeDeps matched neither the `stdin` (scanner) nor the `entryPoints` " +
  "(optimizer) marker — Vite's dep-optimizer wiring drifted; re-verify against " +
  "prepareEsbuildScanner / prepareEsbuildOptimizerRun.";

/**
 * Classify one esbuild run by its POSITIVE marker — never by the ABSENCE of the other's, which
 * would misclassify silently. The scanner bundles a synthetic `stdin` module
 * (`prepareEsbuildScanner`); an optimizer run bundles `entryPoints` (`prepareEsbuildOptimizerRun`).
 * `stdin` alone identifies the scanner (an optimizer run never sets it), so it is checked FIRST and
 * wins even if `entryPoints` were also present. A run with NEITHER marker is `"drift"`: the
 * discriminator couples to undocumented Vite internals and has moved.
 *
 * SCOPED to `optimizeDeps.extensions` being unset — it is, both here and in the shipped
 * `viteIslandConfig`. When set, `extractExportsData` (config.js ~32332) spreads these same plugins
 * into a THIRD `entryPoints` build, which this would tally as an optimizer run; that is why the
 * green legs assert an exact optimizer count rather than trusting exhaustiveness. Re-verify all of
 * this on a Vite major bump (`vite: ^7` will not silently pull 8.x).
 */
function classifyEsbuildRun(initialOptions: {
  entryPoints?: unknown;
  stdin?: unknown;
}): "scanner" | "optimizer" | "drift" {
  if (initialOptions.stdin !== undefined) return "scanner";
  if (initialOptions.entryPoints !== undefined) return "optimizer";
  return "drift";
}

/** An esbuild plugin that tallies each run Vite spreads it into, by {@link classifyEsbuildRun}. */
function countingPlugin(counts: EsbuildRunCounts): unknown {
  return {
    name: "lesto-test:count-esbuild-runs",
    setup(build: { initialOptions: { entryPoints?: unknown; stdin?: unknown } }) {
      const kind = classifyEsbuildRun(build.initialOptions);
      if (kind === "scanner") counts.scanner += 1;
      else if (kind === "optimizer") counts.optimizer += 1;
      else counts.drift ??= DRIFT_MESSAGE;
    },
  };
}

interface ColdServer {
  server: ViteDevServer;
  httpServer: Server;
  cacheDir: string;
  counts: EsbuildRunCounts;
}

let current: ColdServer | undefined;

afterEach(async () => {
  if (current !== undefined) {
    await current.server.close();
    current.httpServer.close();
    rmSync(current.cacheDir, { recursive: true, force: true });
    current = undefined;
  }

  // `writeScanEntry` lands a real file in the fixture's `node_modules`; drop it so a
  // failing run leaves no stray twin behind (it is gitignored but pollutes the tree).
  rmSync(SCAN_DIR, { recursive: true, force: true });
});

/** The dialect's served Fast-Refresh plugin — the SAME lazy choice `vite.ts` makes. */
function fastRefreshPlugin(dialect: Dialect): PluginOption {
  return (dialect === "react" ? reactRefresh() : prefresh()) as PluginOption;
}

/**
 * Stand up the SHIPPED island-dev Vite config over the fixture app on a COLD dep cache.
 * `seedScanner: false` reproduces the pre-fix state by emptying `optimizeDeps.entries`.
 */
async function coldServer(seedScanner: boolean, dialect: Dialect): Promise<ColdServer> {
  const config = viteIslandConfig({ root: ROOT, vitePort: 0, hmrPort: 0, dialect });

  // The dev boot's own writer, at the path the shipped config points `entries` at.
  writeScanEntry(ROOT, scanEntrySource(ROOT, ISLANDS));

  const counts: EsbuildRunCounts = { scanner: 0, optimizer: 0 };
  const httpServer = createHttpServer();

  // A fresh cacheDir per test IS the cold cache: Vite keys its pre-bundle there, so a warm
  // `node_modules/.vite` would skip the scan+optimize path entirely and pass vacuously. It
  // sits under the root (as the default does) so pre-bundled deps are served root-relative
  // rather than through `/@fs/`, which `server.fs.allow` would reject.
  const cacheDir = mkdtempSync(join(ROOT, "node_modules/.vite-cold-"));

  let server: ViteDevServer;
  try {
    server = await createServer({
      root: config.root,
      base: config.base,
      appType: config.appType,
      configFile: config.configFile,
      logLevel: "silent",
      cacheDir,
      server: { middlewareMode: true, hmr: { server: httpServer } },
      plugins: [entryPlugin(), fastRefreshPlugin(dialect)] as PluginOption[],
      optimizeDeps: {
        include: config.optimizeDeps.include,
        entries: seedScanner ? [...config.optimizeDeps.entries] : [],
        esbuildOptions: { plugins: [countingPlugin(counts)] as never },
      },
      resolve: {
        alias: [...config.resolve.alias, ...STUB_ALIASES],
        dedupe: config.resolve.dedupe,
      },
    });
  } catch (error) {
    // `current` is not set yet, so `afterEach` cannot reclaim these — do it here or the
    // cold cacheDir leaks under the fixture on every createServer failure.
    httpServer.close();
    rmSync(cacheDir, { recursive: true, force: true });
    throw error;
  }

  current = { server, httpServer, cacheDir, counts };

  return current;
}

/**
 * The shipped virtual-entry plugin's shape: `/client.js` → the synthesized dev entry.
 * It serves `devEntrySource` (islands by ABSOLUTE path) — NOT the scan twin, whose
 * relative specifiers would have no directory to resolve against as a virtual module.
 */
function entryPlugin(): PluginOption {
  const id = "\0lesto-island-entry.tsx";
  const source = devEntrySource(ISLANDS);

  return {
    name: "lesto:island-entry",
    enforce: "pre",
    resolveId: (requested: string) => (requested === ENTRY_PATH ? id : undefined),
    load: (requested: string) => (requested === id ? source : undefined),
  };
}

/**
 * Crawl the entry's STATIC import graph exactly as a browser cold start does — following
 * `from "…"` but never a lazy island's `import("…")`, which the browser fetches only when
 * the island mounts.
 */
async function crawlStaticGraph(server: ViteDevServer): Promise<void> {
  const seen = new Set<string>();

  const visit = async (url: string): Promise<void> => {
    if (seen.has(url)) return;
    seen.add(url);

    const code = (await server.transformRequest(url).catch(() => undefined))?.code;
    if (code === undefined) return;

    const children: string[] = [];

    for (const match of code.matchAll(/(?:\bfrom|^\s*import)\s*["']([^"']+)["']/gm)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith(VITE_BASE)) continue;
      children.push(`/${specifier.slice(VITE_BASE.length)}`);
    }

    await Promise.all(children.map(visit));
  };

  await visit(ENTRY_PATH);
}

/** Poll until `predicate` holds — the optimizer commits AFTER `waitForRequestsIdle`. */
async function settle(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The deps Vite ended up pre-bundling. */
function optimizedDeps(server: ViteDevServer): string[] {
  return Object.keys(server.environments.client.depsOptimizer?.metadata.optimized ?? {});
}

async function coldStart(seedScanner: boolean, dialect: Dialect): Promise<ColdServer> {
  const cold = await coldServer(seedScanner, dialect);

  await crawlStaticGraph(cold.server);
  await cold.server.environments.client.waitForRequestsIdle();
  await settle(() => optimizedDeps(cold.server).includes("preact-render-to-string"));
  // Let any re-run the crawl-end scheduled (`debouncedProcessing(0)`) start and finish.
  await new Promise((resolve) => setTimeout(resolve, 500));

  return cold;
}

describe("island dev cold start (optimizeDeps.entries seeds the dep scanner)", () => {
  // The discriminator contract, tested directly so the `counts.drift` tripwire above is NOT a
  // vacuous never-fires assertion (repo rule): drive all three arms, including the drift arm real
  // Vite 7.x never reaches. `stdin` wins over `entryPoints` because the scanner spreads
  // `esbuildOptions` AFTER its own `stdin`, so a run could legitimately carry both.
  it("classifies an esbuild run by its positive marker (stdin→scanner, entryPoints→optimizer, neither→drift)", () => {
    expect(classifyEsbuildRun({ stdin: {} })).toBe("scanner");
    expect(classifyEsbuildRun({ entryPoints: [] })).toBe("optimizer");
    expect(classifyEsbuildRun({ stdin: {}, entryPoints: [] })).toBe("scanner");
    expect(classifyEsbuildRun({})).toBe("drift");
  });

  // BOTH shipped dialects, because their SERVED transform differs — `@vitejs/plugin-react`
  // (babel, automatic runtime) vs `@prefresh/vite` — so the scanner (plain esbuild) sees a
  // different graph in each, and the react path's one-pass guarantee is otherwise unguarded
  // (it rests on `react/jsx-dev-runtime ∈ include` + the refresh runtime being virtual). A
  // react-specific reopening of the 504 class fails SILENTLY, so it needs its own leg.
  it.each(["preact", "react"] as const)(
    "settles in ONE optimizer pass with every island dep pre-bundled (%s)",
    async (dialect) => {
      const { server, counts } = await coldStart(true, dialect);

      // Un-swallowable drift signal, asserted FIRST: if the scanner/optimizer discriminator ever
      // drifts, this surfaces the re-verify pointer instead of a bare count mismatch (a throw
      // could not — Vite catches it into a silenced logger). Non-vacuous: the classifier test
      // below drives this arm RED directly.
      expect(counts.drift).toBeUndefined();

      // The scanner ran at all — without a seeded `entries` it short-circuits before esbuild.
      expect(counts.scanner).toBe(1);

      // The crux: one pass. No cancelled optimize, no hash bump, no 504-able window.
      expect(counts.optimizer).toBe(1);

      const deps = optimizedDeps(server);

      // Reached through a relative hop from an eager island.
      expect(deps).toContain("preact-render-to-string");
      // Reached ONLY through the entry's dynamic `import()` of a lazy island — so the static
      // crawl never saw it, and only the scanner could have pre-bundled it. Without this, the
      // first mount of a lazy island re-optimizes and full-reloads the page.
      expect(deps).toContain("zod");
    },
    30_000,
  );

  it("runs the optimizer TWICE without the scan entry (the pre-fix state)", async () => {
    // `entries: []` reproduces the pre-fix scanner-blindness. NOTE it is not byte-identical
    // to the shipped-before state, which left `entries` UNSET (→ Vite's `**/*.html` default);
    // both resolve to zero scannable entries, so the scanner never runs either way — do not
    // "correct" this to `undefined` thinking it is a bug. Dialect is irrelevant to the
    // mechanism here, so this leg runs preact only.
    const { server, counts } = await coldStart(false, "preact");

    // Still classified cleanly — an empty `entries` removes the scan pass, it does not drift.
    expect(counts.drift).toBeUndefined();

    // No entries → `computeEntries` finds nothing → the scanner never bundles.
    expect(counts.scanner).toBe(0);

    // The bug: the crawl discovers `preact-render-to-string`, Vite cancels the first
    // optimize and re-runs it. This is the assertion the green test above must invert.
    expect(counts.optimizer).toBe(2);

    const deps = optimizedDeps(server);

    expect(deps).toContain("preact-render-to-string");
    // The lazy island's dep is NOT pre-bundled: its first mount would re-optimize again.
    expect(deps).not.toContain("zod");
  }, 30_000);
});
