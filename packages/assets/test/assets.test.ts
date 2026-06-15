import { describe, expect, it } from "vitest";

// Import the pure cores directly, NOT via ../src/index — the barrel re-exports
// `bunBuildClientDeps` from `bun.ts`, whose top-level `import.meta.dir` is a Bun
// global undefined under vitest. bun.ts is the excluded Bun-only edge.
import { buildClient } from "../src/build-client";
import type { BuildClientDeps, BundleArtifact, BundleRequest } from "../src/build-client";
import { isChunkFile } from "../src/chunks";
import { AssetsError } from "../src/errors";
import { PREACT_ALIAS } from "../src/preact-alias";
import { synthesizeEntry } from "../src/synthesize";
import type { IslandFile } from "../src/synthesize";

describe("synthesizeEntry", () => {
  it("static-imports an eager island and registers it by its carried def", () => {
    const source = synthesizeEntry([
      { name: "Account", importPath: "/app/islands/account.tsx", lazy: false },
    ]);

    expect(source).toContain('import Island0 from "/app/islands/account.tsx";');
    expect(source).toContain(".defineClient(Island0.island)");
    expect(source).toContain('import { hydrateDocumentIslands } from "@keel/ui/client";');
    expect(source).toContain("hydrateDocumentIslands(registry);");
  });

  it("dynamic-imports a lazy (visible) island so only its bytes split", () => {
    const source = synthesizeEntry([
      { name: "Chart", importPath: "/app/islands/chart.tsx", lazy: true },
    ]);

    // No static import for the lazy one…
    expect(source).not.toContain("import Island0");
    // …it is registered with a load() that dynamic-imports its component.
    expect(source).toContain(
      '.defineClient({ name: "Chart", load: () => import("/app/islands/chart.tsx")' +
        ".then((module) => module.default.island.component) })",
    );
  });

  it("mixes eager and lazy islands, numbering the eager imports", () => {
    const source = synthesizeEntry([
      { name: "Account", importPath: "/a.tsx", lazy: false },
      { name: "Chart", importPath: "/b.tsx", lazy: true },
      { name: "Cart", importPath: "/c.tsx", lazy: false },
    ]);

    // Eager imports keep their positional index (0 and 2), lazy gets no import.
    expect(source).toContain('import Island0 from "/a.tsx";');
    expect(source).toContain('import Island2 from "/c.tsx";');
    expect(source).not.toContain("Island1");
    expect(source).toContain(".defineClient(Island0.island)");
    expect(source).toContain('.defineClient({ name: "Chart"');
    expect(source).toContain(".defineClient(Island2.island)");
  });

  it("produces a valid no-island entry (an empty registry hydrates nothing)", () => {
    const source = synthesizeEntry([]);

    expect(source).toContain("const registry = new Registry()");
    expect(source).toContain("hydrateDocumentIslands(registry);");
  });
});

describe("isChunkFile", () => {
  it.each(["chunk-abc123.js", "chunk-AB12cd.js"])("matches a hashed chunk %j", (name) => {
    expect(isChunkFile(name)).toBe(true);
  });

  it.each(["client.js", "index.html", "chunk-.js", "chunk-abc.css", "a-chunk-abc.js"])(
    "leaves %j alone (entry, page, or non-chunk)",
    (name) => {
      expect(isChunkFile(name)).toBe(false);
    },
  );
});

describe("PREACT_ALIAS", () => {
  it("maps every React specifier the client graph pulls to a Preact target", () => {
    // No `react-dom`/`react-dom/server` entries: after the `@keel/ui` barrel
    // split the client never imports the server-render surface, so neither
    // specifier reaches the browser graph and no inert shim is needed.
    expect(PREACT_ALIAS).toEqual({
      react: "preact/compat",
      "react-dom/client": "preact/compat/client",
      "react/jsx-runtime": "preact/jsx-runtime",
      "react/jsx-dev-runtime": "preact/jsx-runtime",
    });
  });
});

// A fake deps bag recording the writes/removes and serving canned islands + artifacts.
function fakeDeps(overrides: Partial<BuildClientDeps> = {}): {
  deps: BuildClientDeps;
  written: Map<string, string | Uint8Array>;
  removed: string[];
  bundled: BundleRequest[];
} {
  const written = new Map<string, string | Uint8Array>();
  const removed: string[] = [];
  const bundled: BundleRequest[] = [];

  const deps: BuildClientDeps = {
    listIslands: () =>
      Promise.resolve([{ name: "Account", importPath: "/a.tsx", lazy: false }] as IslandFile[]),
    bundle: (request) => {
      bundled.push(request);

      return Promise.resolve([
        { kind: "entry", fileName: "entry.js", contents: "ENTRY" },
        { kind: "chunk", fileName: "chunk-deadbeef.js", contents: "CHUNK" },
      ] as BundleArtifact[]);
    },
    listOutDir: () => Promise.resolve([]),
    remove: (path) => {
      removed.push(path);

      return Promise.resolve();
    },
    write: (path, contents) => {
      written.set(path, contents);

      return Promise.resolve();
    },
    ...overrides,
  };

  return { deps, written, removed, bundled };
}

describe("buildClient", () => {
  it("synthesizes from the islands, bundles, and writes the entry + chunks", async () => {
    const { deps, written, bundled } = fakeDeps();

    const result = await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "preact" },
      deps,
    );

    // The bundler saw the synthesized entry for these islands, in the chosen mode/dialect.
    expect(bundled[0]?.mode).toBe("production");
    expect(bundled[0]?.dialect).toBe("preact");
    expect(bundled[0]?.entrySource).toContain(".defineClient(Island0.island)");

    // The entry lands at the default name; the chunk keeps its hashed name.
    expect(written.get("/out/client.js")).toBe("ENTRY");
    expect(written.get("/out/chunk-deadbeef.js")).toBe("CHUNK");
    expect(result.entry).toBe("/out/client.js");
    expect(result.chunks).toEqual(["/out/chunk-deadbeef.js"]);
  });

  it("honors a custom entry name", async () => {
    const { deps, written } = fakeDeps();

    const result = await buildClient(
      {
        islandsDir: "/app/islands",
        outDir: "/out",
        entryName: "hydrate.js",
        mode: "development",
        dialect: "react",
      },
      deps,
    );

    expect(written.has("/out/hydrate.js")).toBe(true);
    expect(result.entry).toBe("/out/hydrate.js");
  });

  it("sweeps the previous build's stale chunks, never the entry or HTML", async () => {
    const { deps, removed } = fakeDeps({
      listOutDir: () =>
        Promise.resolve(["client.js", "index.html", "chunk-old11111.js", "chunk-old22222.js"]),
    });

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    // Only the stale hashed chunks are removed.
    expect(removed.toSorted()).toEqual(["/out/chunk-old11111.js", "/out/chunk-old22222.js"]);
  });

  it("throws ASSETS_NO_ENTRY when the bundler produced no entry artifact", async () => {
    const { deps } = fakeDeps({
      bundle: () => Promise.resolve([{ kind: "chunk", fileName: "chunk-x.js", contents: "c" }]),
    });

    try {
      await buildClient(
        { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
        deps,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetsError);
      expect((error as AssetsError).code).toBe("ASSETS_NO_ENTRY");
    }
  });
});
