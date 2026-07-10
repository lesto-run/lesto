/**
 * The dev entry is the shipped `synthesizeEntry` output with the dev beacon flag —
 * so the tests confirm it carries the island registrations, the hydrate call, and
 * `dev: true` (the overlay-not-POST switch), for both eager and lazy islands.
 *
 * Its scan-only twin (`scanEntrySource`) must reach the SAME modules while carrying no
 * absolute island specifier — Vite's dep scanner externalizes any specifier that resolves
 * to itself, so an absolute import would leave the scan blind (silently) and re-open the
 * cold-start re-optimize L-90d2de01 closes.
 */

import type { IslandFile } from "@lesto/assets";
import { describe, expect, it } from "vitest";

import { devEntrySource, SCAN_ENTRY_PATH, scanEntrySource } from "../src/entry";

const eager: IslandFile = {
  name: "Counter",
  importPath: "/abs/app/islands/counter.tsx",
  lazy: false,
  ssr: false,
};

const lazy: IslandFile = {
  name: "Chart",
  importPath: "/abs/app/islands/chart.tsx",
  lazy: true,
  ssr: false,
};

describe("devEntrySource", () => {
  it("registers an eager island by static import and wires the dev beacon", () => {
    const source = devEntrySource([eager]);

    expect(source).toContain('import Island0 from "/abs/app/islands/counter.tsx"');
    expect(source).toContain(".defineClient(Island0.island)");
    expect(source).toContain("hydrateDocumentIslands");
    expect(source).toContain("dev: true");
  });

  it("registers a lazy island by dynamic import", () => {
    const source = devEntrySource([lazy]);

    expect(source).toContain('name: "Chart"');
    expect(source).toContain('import("/abs/app/islands/chart.tsx")');
    expect(source).toContain("dev: true");
  });

  it("handles an app with no islands", () => {
    const source = devEntrySource([]);

    expect(source).toContain("hydrateDocumentIslands");
    expect(source).toContain("dev: true");
  });
});

describe("scanEntrySource", () => {
  const root = "/abs";

  it("lives under node_modules, where Vite's globEntries honours it", () => {
    // `globEntries` routes a pattern containing `node_modules` PAST its own
    // `**\/node_modules/**` ignore; anywhere else under node_modules would be dropped.
    expect(SCAN_ENTRY_PATH).toContain("node_modules/");
    // Root-relative: Vite globs `optimizeDeps.entries` against `config.root`.
    expect(SCAN_ENTRY_PATH.startsWith("/")).toBe(false);
    // A JS/TS extension `isScannable` accepts (its `.(j|t)sx?|.mjs` test); `.tsx` mirrors
    // the served virtual entry id (`\0lesto-island-entry.tsx`) — the entry body has no JSX.
    expect(SCAN_ENTRY_PATH.endsWith(".tsx")).toBe(true);
  });

  it("rewrites an eager island's absolute import to a relative specifier", () => {
    const source = scanEntrySource(root, [eager]);

    // `/abs/node_modules/.lesto/` → `/abs/app/islands/counter.tsx`
    expect(source).toContain('import Island0 from "../../app/islands/counter.tsx"');
    expect(source).not.toContain('"/abs/app/islands/counter.tsx"');
  });

  it("rewrites a lazy island's dynamic import too", () => {
    // Lazy islands are reachable ONLY through the entry's `import()`; the scanner follows
    // it, which is how a lazy island's deps get pre-bundled before its first mount.
    const source = scanEntrySource(root, [lazy]);

    expect(source).toContain('import("../../app/islands/chart.tsx")');
    expect(source).not.toContain('"/abs/app/islands/chart.tsx"');
  });

  it("dot-prefixes a specifier that would otherwise read as a package name", () => {
    // An island BELOW the scan entry's directory relativizes to `nested/x.tsx`, which node
    // and Vite would both resolve as the PACKAGE `nested` — it must be `./nested/x.tsx`.
    const nested: IslandFile = {
      ...eager,
      importPath: "/abs/node_modules/.lesto/nested/x.tsx",
    };

    expect(scanEntrySource(root, [nested])).toContain('from "./nested/x.tsx"');
  });

  it("keeps the entry's own bare imports verbatim, so the scanner sees them as deps", () => {
    // These are what a real (npm-installed, not workspace-symlinked) app pre-bundles; if
    // the twin dropped or rewrote them, the scan would miss them and the optimizer re-runs.
    const source = scanEntrySource(root, [eager]);

    expect(source).toContain('from "@lesto/ui"');
    expect(source).toContain('from "@lesto/ui/client"');
    expect(source).toContain('from "@lesto/observability/rum"');
  });

  it("reaches the same islands as the served entry, differing only in specifier form", () => {
    const served = devEntrySource([eager, lazy]);
    const scanned = scanEntrySource(root, [eager, lazy]);

    // Same registrations, same hydrate call, same beacon — one `synthesizeEntry` call.
    expect(scanned).toContain(".defineClient(Island0.island)");
    expect(scanned).toContain('name: "Chart"');
    expect(served.length).toBeGreaterThan(0);

    // The ONLY difference is that no absolute island path survives into the twin, which
    // is the whole point: `shouldExternalizeDep` skips a specifier that resolves to itself.
    for (const island of [eager, lazy]) {
      expect(served).toContain(island.importPath);
      expect(scanned).not.toContain(island.importPath);
    }
  });
});
