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
      { name: "Account", importPath: "/app/islands/account.tsx", lazy: false, ssr: false },
    ]);

    expect(source).toContain('import Island0 from "/app/islands/account.tsx";');
    expect(source).toContain(".defineClient(Island0.island)");
    expect(source).toContain('import { hydrateDocumentIslands } from "@keel/ui/client";');
    expect(source).toContain("hydrateDocumentIslands(registry);");
  });

  it("dynamic-imports a lazy (visible) island so only its bytes split", () => {
    const source = synthesizeEntry([
      { name: "Chart", importPath: "/app/islands/chart.tsx", lazy: true, ssr: false },
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
      { name: "Account", importPath: "/a.tsx", lazy: false, ssr: false },
      { name: "Chart", importPath: "/b.tsx", lazy: true, ssr: false },
      { name: "Cart", importPath: "/c.tsx", lazy: false, ssr: false },
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

// A fake deps bag recording the writes/removes and serving canned islands +
// artifacts. `read` is backed by `written`, so the generation marker round-trips
// across successive buildClient calls on the same bag — exactly how a real disk
// would carry one build's chunk list to the next.
function fakeDeps(overrides: Partial<BuildClientDeps> = {}): {
  deps: BuildClientDeps;
  written: Map<string, string | Uint8Array>;
  removed: string[];
  bundled: BundleRequest[];
  writeOrder: string[];
} {
  const written = new Map<string, string | Uint8Array>();
  const removed: string[] = [];
  const bundled: BundleRequest[] = [];
  const writeOrder: string[] = [];

  const deps: BuildClientDeps = {
    listIslands: () =>
      Promise.resolve([
        { name: "Account", importPath: "/a.tsx", lazy: false, ssr: false },
      ] as IslandFile[]),
    bundle: (request) => {
      bundled.push(request);

      return Promise.resolve([
        { kind: "entry", fileName: "entry.js", contents: "ENTRY" },
        { kind: "chunk", fileName: "chunk-deadbeef.js", contents: "CHUNK" },
      ] as BundleArtifact[]);
    },
    listOutDir: () => Promise.resolve([]),
    read: (path) => {
      const value = written.get(path);

      return Promise.resolve(typeof value === "string" ? value : undefined);
    },
    remove: (path) => {
      removed.push(path);
      written.delete(path);

      return Promise.resolve();
    },
    write: (path, contents) => {
      writeOrder.push(path);
      written.set(path, contents);

      return Promise.resolve();
    },
    ...overrides,
  };

  return { deps, written, removed, bundled, writeOrder };
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

  it("writes the new artifacts BEFORE sweeping anything (crash-safe order)", async () => {
    const { deps, writeOrder } = fakeDeps({
      listOutDir: () => Promise.resolve(["chunk-old11111.js"]),
    });

    let firstRemoveAt = -1;
    const baseRemove = deps.remove;
    deps.remove = (path) => {
      // The first remove must come AFTER the entry + new chunk are written: a crash
      // between phases then leaves the new build on disk, never a half-swept dir.
      if (firstRemoveAt === -1) firstRemoveAt = writeOrder.length;

      return baseRemove(path);
    };

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "development", dialect: "react" },
      deps,
    );

    // The entry and the new chunk were both written before the first sweep removal.
    expect(writeOrder).toContain("/out/client.js");
    expect(writeOrder).toContain("/out/chunk-deadbeef.js");
    expect(firstRemoveAt).toBeGreaterThanOrEqual(2);
  });

  it("development sweeps every chunk not in the new build", async () => {
    const { deps, removed } = fakeDeps({
      listOutDir: () =>
        Promise.resolve(["client.js", "index.html", "chunk-old11111.js", "chunk-old22222.js"]),
    });

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "development", dialect: "react" },
      deps,
    );

    // Only the stale hashed chunks are removed — never the entry or the HTML.
    expect(removed.toSorted()).toEqual(["/out/chunk-old11111.js", "/out/chunk-old22222.js"]);
  });

  it("production keeps exactly ONE previous generation for in-flight documents", async () => {
    // Build 1 writes chunk-deadbeef.js and records it as the generation marker.
    const { deps, removed } = fakeDeps();

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    expect(removed).toEqual([]);

    // Build 2 produces a NEW chunk; the prior generation (chunk-deadbeef.js) must
    // survive so an in-flight old document can still fetch it. A stale chunk from
    // TWO generations ago (chunk-ancient.js) is swept.
    deps.bundle = () =>
      Promise.resolve([
        { kind: "entry", fileName: "entry.js", contents: "ENTRY2" },
        { kind: "chunk", fileName: "chunk-cafef00d.js", contents: "CHUNK2" },
      ] as BundleArtifact[]);
    deps.listOutDir = () =>
      Promise.resolve(["client.js", "chunk-deadbeef.js", "chunk-cafef00d.js", "chunk-ancient.js"]);

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    // The prior generation survives; only the two-generations-old chunk is swept.
    expect(removed).toEqual(["/out/chunk-ancient.js"]);
  });

  it.each([
    ["corrupt JSON", "not json{"],
    ["valid JSON that is not an array", '{"chunk-x.js":true}'],
  ])(
    "tolerates a %s generation marker (treats it as no prior generation)",
    async (_label, marker) => {
      const { deps, removed } = fakeDeps({
        listOutDir: () => Promise.resolve(["chunk-stale0001.js"]),
        read: () => Promise.resolve(marker),
      });

      await buildClient(
        { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
        deps,
      );

      // With no parseable prior generation, the stale chunk is swept.
      expect(removed).toEqual(["/out/chunk-stale0001.js"]);
    },
  );

  it("ignores non-string entries in the generation marker", async () => {
    // A marker array with a non-string element: the non-string is filtered out, so
    // only the real prior-generation chunk name is retained.
    const { deps, removed } = fakeDeps({
      listOutDir: () => Promise.resolve(["chunk-prevreal.js", "chunk-stale0001.js"]),
      read: () => Promise.resolve('["chunk-prevreal.js", 42]'),
    });

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    // The named prior chunk survives; the unrelated stale chunk is swept.
    expect(removed).toEqual(["/out/chunk-stale0001.js"]);
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

  it("refuses an ssr: true island under the preact dialect, naming the island", async () => {
    // The broken matched pair: a preact CLIENT bundle hydrating React SERVER
    // markup. The CLI server renders React, so this would silently mismatch — the
    // build must make it loud. The bundler is never even reached.
    const { deps, bundled } = fakeDeps({
      listIslands: () =>
        Promise.resolve([
          { name: "Account", importPath: "/a.tsx", lazy: false, ssr: false },
          { name: "Cart", importPath: "/c.tsx", lazy: false, ssr: true },
        ] as IslandFile[]),
    });

    try {
      await buildClient(
        { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "preact" },
        deps,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetsError);
      expect((error as AssetsError).code).toBe("ASSETS_DIALECT_SSR_MISMATCH");
      // The message names the offending island and points at both resolutions.
      expect((error as AssetsError).message).toContain('"Cart"');
      expect((error as AssetsError).message).not.toContain('"Account"');
      expect((error as AssetsError).message).toContain("ssr: false");
      expect((error as AssetsError).message).toContain("preactServerRenderer");
      expect((error as AssetsError).details).toMatchObject({ islands: ["Cart"] });
    }

    // The refusal short-circuits before bundling.
    expect(bundled).toEqual([]);
  });

  it("names every offending island and pluralizes when more than one is ssr: true", async () => {
    const { deps } = fakeDeps({
      listIslands: () =>
        Promise.resolve([
          { name: "Cart", importPath: "/c.tsx", lazy: false, ssr: true },
          { name: "Account", importPath: "/a.tsx", lazy: false, ssr: false },
          { name: "Banner", importPath: "/b.tsx", lazy: false, ssr: true },
        ] as IslandFile[]),
    });

    try {
      await buildClient(
        { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "preact" },
        deps,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as AssetsError).code).toBe("ASSETS_DIALECT_SSR_MISMATCH");
      // Both ssr islands named (plural form), the deferred one omitted.
      expect((error as AssetsError).message).toContain('islands "Cart", "Banner" are ssr: true');
      expect((error as AssetsError).message).not.toContain('"Account"');
      expect((error as AssetsError).details).toMatchObject({ islands: ["Cart", "Banner"] });
    }
  });

  it("builds fine under the preact dialect when every island is deferred (ssr: false)", async () => {
    const { deps, written } = fakeDeps({
      listIslands: () =>
        Promise.resolve([
          { name: "Account", importPath: "/a.tsx", lazy: false, ssr: false },
          { name: "Chart", importPath: "/b.tsx", lazy: true, ssr: false },
        ] as IslandFile[]),
    });

    const result = await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "preact" },
      deps,
    );

    expect(result.entry).toBe("/out/client.js");
    expect(written.get("/out/client.js")).toBe("ENTRY");
  });

  it("builds fine under the react dialect even with an ssr: true island", async () => {
    // React server + React client are byte-identical, so ssr: true is always fine
    // under the react dialect — the guard is preact-only.
    const { deps, written } = fakeDeps({
      listIslands: () =>
        Promise.resolve([
          { name: "Cart", importPath: "/c.tsx", lazy: false, ssr: true },
        ] as IslandFile[]),
    });

    const result = await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    expect(result.entry).toBe("/out/client.js");
    expect(written.get("/out/client.js")).toBe("ENTRY");
  });
});
