import { describe, expect, it } from "vitest";

// Import the pure cores directly, NOT via ../src/index — the barrel re-exports
// `bunBuildClientDeps` from `bun.ts`, whose top-level `import.meta.dir` is a Bun
// global undefined under vitest. bun.ts is the excluded Bun-only edge.
import { buildClient } from "../src/build-client";
import type { BuildClientDeps, BundleArtifact, BundleRequest } from "../src/build-client";
import { isChunkFile } from "../src/chunks";
import { AssetsError } from "../src/errors";
import { PREACT_ALIAS } from "../src/preact-alias";
import { verifyPublicEnvDefine } from "../src/public-env";
import { RUM_MODULE, rumImport, rumStartCall } from "../src/rum-client";
import { islandFileFromModule, synthesizeEntry } from "../src/synthesize";
import type { IslandFile } from "../src/synthesize";

describe("synthesizeEntry", () => {
  it("static-imports an eager island and registers it by its carried def", () => {
    const source = synthesizeEntry([
      { name: "Account", importPath: "/app/islands/account.tsx", lazy: false, ssr: false },
    ]);

    expect(source).toContain('import Island0 from "/app/islands/account.tsx";');
    expect(source).toContain(".defineClient(Island0.island)");
    expect(source).toContain('import { hydrateDocumentIslands } from "@lesto/ui/client";');
    expect(source).toContain("hydrateDocumentIslands(registry, {");
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
    // Even an island-less app wires the beacon — the hydrate call still runs (it
    // is a no-op) and the result still feeds report(), so the wiring is uniform.
    expect(source).toContain("hydrateDocumentIslands(registry, {");
    expect(source).toContain("beacon.report(result);");
  });
});

describe("synthesizeEntry — client error beacon (ADR 0011)", () => {
  const islands: IslandFile[] = [
    { name: "Account", importPath: "/a.tsx", lazy: false, ssr: false },
  ];

  it("inlines the beacon runtime and wires both hydration sinks into the hydrate call", () => {
    const source = synthesizeEntry(islands);

    // The runtime is inlined (no @lesto/assets import in the browser graph).
    expect(source).not.toContain("@lesto/assets");
    expect(source).toContain("const reportClientErrors =");
    expect(source).toContain("const beacon = (() => {");

    // The sinks are passed INTO hydrateDocumentIslands (so a deferred island that
    // fails later still reports), and the synchronous result drives the summary.
    expect(source).toContain("const result = hydrateDocumentIslands(registry, {");
    expect(source).toContain("onMountError: beacon.onMountError,");
    expect(source).toContain("onRecoverableError: beacon.onRecoverableError,");
    expect(source).toContain("beacon.report(result);");
  });

  it("emits the POST path and never inlines free text that could carry PII", () => {
    const source = synthesizeEntry(islands);

    expect(source).toContain('"/__lesto/client-errors"');
    // The runtime reads error.code / constructor.name / typeof — never .message.
    expect(source).not.toContain(".message");
  });

  it("passes an author-set sampleRate through to the runtime constructor", () => {
    const source = synthesizeEntry(islands, { sampleRate: 0.5 });

    expect(source).toContain("reportClientErrors({ sampleRate: 0.5 });");
  });

  it("passes an author-set dev flag through (the overlay path)", () => {
    const source = synthesizeEntry(islands, { dev: true });

    expect(source).toContain("reportClientErrors({ dev: true });");
  });

  it("installs the page-refresh hook only in dev (DX-parity R2 page swap)", () => {
    const dev = synthesizeEntry(islands, { dev: true });

    // In dev the entry imports + calls enableDevPageRefresh, so a saved route file swaps
    // the page in place rather than full-reloading.
    expect(dev).toContain(
      'import { enableDevPageRefresh, hydrateDocumentIslands } from "@lesto/ui/client";',
    );
    expect(dev).toContain("enableDevPageRefresh(registry);");

    // A production build ships neither the import nor the call — the swap is dev-only.
    const prod = synthesizeEntry(islands, { dev: false });

    expect(prod).toContain('import { hydrateDocumentIslands } from "@lesto/ui/client";');
    expect(prod).not.toContain("enableDevPageRefresh");
  });

  it("emits both knobs together when both are set", () => {
    const source = synthesizeEntry(islands, { sampleRate: 0.25, dev: false });

    expect(source).toContain("reportClientErrors({ sampleRate: 0.25, dev: false });");
  });

  it("emits an empty options object when no knobs are set (runtime defaults apply)", () => {
    const source = synthesizeEntry(islands);

    // No build-time override → the runtime falls back to its conservative defaults.
    expect(source).toContain("reportClientErrors({  });");
  });
});

describe("rum-client — the browser-RUM wiring snippets (ARCHITECTURE.md §7)", () => {
  it("imports startBrowserRum from the node-free observability subpath", () => {
    expect(RUM_MODULE).toBe("@lesto/observability/rum");
    expect(rumImport()).toBe('import { startBrowserRum } from "@lesto/observability/rum";');
  });

  it("emits a bare start call when no sample rate is set (runtime default applies)", () => {
    expect(rumStartCall()).toBe("startBrowserRum();");
    expect(rumStartCall({})).toBe("startBrowserRum();");
  });

  it("passes an author-set sampleRate through to the runtime", () => {
    expect(rumStartCall({ sampleRate: 0.25 })).toBe("startBrowserRum({ sampleRate: 0.25 });");
  });
});

describe("synthesizeEntry — browser RUM (ARCHITECTURE.md §7)", () => {
  const islands: IslandFile[] = [
    { name: "Account", importPath: "/a.tsx", lazy: false, ssr: false },
  ];

  it("imports startBrowserRum and calls it AFTER hydration", () => {
    const source = synthesizeEntry(islands);

    expect(source).toContain('import { startBrowserRum } from "@lesto/observability/rum";');
    expect(source).toContain("startBrowserRum();");

    // RUM starts after hydration is wired (its buffered observer still sees load
    // entries), so the call follows the hydrate + report lines in the entry.
    expect(source.indexOf("startBrowserRum();")).toBeGreaterThan(
      source.indexOf("beacon.report(result);"),
    );
  });

  it("threads an author-set RUM sample rate into the start call", () => {
    const source = synthesizeEntry(islands, {}, { sampleRate: 0.5 });

    expect(source).toContain("startBrowserRum({ sampleRate: 0.5 });");
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
    // No `react-dom`/`react-dom/server` entries: after the `@lesto/ui` barrel
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
    // A deterministic fake "gzip size": the content's character length. Real gzip
    // lives in `bun.ts` (the excluded Bun edge); the orchestration only needs a
    // number, so a fake keeps the measure/report/budget logic covered offline.
    gzipSize: (contents) => contents.length,
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

    // No public-env injection given → the bundler receives a verified empty map.
    expect(bundled[0]?.publicEnvDefine).toEqual({});
  });

  it("installs the page-swap/overlay hook in the DEV entry, not the prod entry (Bun dev path)", async () => {
    // The Bun dev FALLBACK path now threads `mode` into the synthesized entry, so a
    // `lesto dev` route save swaps the page in place (and hydration errors paint the
    // ADR-0011 overlay) — the dev page-swap is no longer island-dev/Vite-only.
    const dev = fakeDeps();
    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "development", dialect: "react" },
      dev.deps,
    );
    expect(dev.bundled[0]?.entrySource).toContain("enableDevPageRefresh(registry);");

    // A production build ships neither the import nor the call — the swap machinery is
    // dev-only, so `lesto build`'s bundle never carries it.
    const prod = fakeDeps();
    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      prod.deps,
    );
    expect(prod.bundled[0]?.entrySource).not.toContain("enableDevPageRefresh");
  });

  it("threads a verified PUBLIC-env inject map through to the bundler", async () => {
    const { deps, bundled } = fakeDeps();

    const publicEnvDefine = {
      "globalThis.__LESTO_PUBLIC_ENV__": '{"PUBLIC_API_BASE":"https://api"}',
      "import.meta.env.PUBLIC_FLAG": "true",
    };

    await buildClient(
      {
        islandsDir: "/app/islands",
        outDir: "/out",
        mode: "production",
        dialect: "preact",
        publicEnvDefine,
      },
      deps,
    );

    // The map reaches the bundler verbatim (the bundler merges it into Bun's `define`).
    expect(bundled[0]?.publicEnvDefine).toEqual(publicEnvDefine);
  });

  it("REFUSES a build whose inject map names a server (non-public) var", async () => {
    const { deps, bundled } = fakeDeps();

    let thrown: unknown;

    try {
      await buildClient(
        {
          islandsDir: "/app/islands",
          outDir: "/out",
          mode: "production",
          dialect: "preact",
          publicEnvDefine: { "process.env.SESSION_SECRET": '"leaked"' },
        },
        deps,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AssetsError);
    expect((thrown as AssetsError).code).toBe("ASSETS_SERVER_ENV_LEAK");
    expect((thrown as AssetsError).message).toContain("SESSION_SECRET");

    // It fails BEFORE bundling — a leak never reaches the bundler at all.
    expect(bundled).toHaveLength(0);
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

  it("tolerates a marker that is valid JSON but neither an array nor an object", async () => {
    // `null` / a bare number parse cleanly but carry no provenance — treated as no
    // prior generation (the legacy-array and `{current,prior}` branches both miss),
    // so the orphaned chunk falls to the isChunkFile fallback net and is swept.
    const { deps, removed } = fakeDeps({
      listOutDir: () => Promise.resolve(["chunk-stale0001.js"]),
      read: () => Promise.resolve("null"),
    });

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    expect(removed).toEqual(["/out/chunk-stale0001.js"]);
  });

  it("reads the two-generation `{ current, prior }` marker, retaining current + sweeping prior", async () => {
    // The current marker shape: production retains `current` (the immediately-prior
    // generation, for in-flight documents) and sweeps `prior` (the generation behind
    // it) — even for an extensionless ASSET, which isChunkFile can never catch.
    const { deps, removed } = fakeDeps({
      bundle: () =>
        Promise.resolve([
          { kind: "entry", fileName: "entry.js", contents: "ENTRY" },
          { kind: "chunk", fileName: "asset-new000.css", contents: "NEW" },
        ] as BundleArtifact[]),
      listOutDir: () =>
        Promise.resolve(["client.js", "asset-cur111.css", "asset-pri222.css", "asset-new000.css"]),
      read: () =>
        Promise.resolve(
          JSON.stringify({ current: ["asset-cur111.css"], prior: ["asset-pri222.css"] }),
        ),
    });

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    // `current` (asset-cur111.css) is retained; only `prior` (asset-pri222.css) is swept.
    expect(removed).toEqual(["/out/asset-pri222.css"]);
  });

  it("development sweeps a stale ASSET the build no longer emits (the cross-bundler leak)", async () => {
    // An island that imported a non-JS asset (`import './x.css'`) makes the bundler
    // emit an `asset-<hash>.<ext>` file — recorded in the marker like a chunk, but
    // NOT matched by isChunkFile (`.js`-only). Before the provenance-driven sweep it
    // accumulated forever. Build 1 emits the asset; build 2 drops it.
    const { deps, written, removed } = fakeDeps({
      bundle: () =>
        Promise.resolve([
          { kind: "entry", fileName: "entry.js", contents: "ENTRY" },
          { kind: "chunk", fileName: "chunk-deadbeef.js", contents: "CHUNK" },
          { kind: "chunk", fileName: "asset-stylee1.css", contents: "CSS" },
        ] as BundleArtifact[]),
      listOutDir: () => Promise.resolve([]),
    });

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "development", dialect: "react" },
      deps,
    );

    // Build 1 wrote the asset and recorded it in the marker.
    expect(written.has("/out/asset-stylee1.css")).toBe(true);
    expect(removed).toEqual([]);

    // Build 2 no longer imports the asset (entry + chunk only). The out dir still
    // holds the now-stale asset, which dev must sweep — it is marker provenance, not
    // a chunk by name.
    deps.bundle = () =>
      Promise.resolve([
        { kind: "entry", fileName: "entry.js", contents: "ENTRY2" },
        { kind: "chunk", fileName: "chunk-cafef00d.js", contents: "CHUNK2" },
      ] as BundleArtifact[]);
    deps.listOutDir = () =>
      Promise.resolve(["client.js", "chunk-deadbeef.js", "chunk-cafef00d.js", "asset-stylee1.css"]);

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "development", dialect: "react" },
      deps,
    );

    // The stale asset AND the stale chunk are both swept (dev keeps only the new set).
    expect(removed.toSorted()).toEqual(["/out/asset-stylee1.css", "/out/chunk-deadbeef.js"]);
  });

  it("production keeps the immediately-prior ASSET but sweeps the generation before it", async () => {
    // The asset analogue of the chunk one-prior-generation rule. Three production
    // builds, each emitting a fresh asset; isChunkFile can never catch an asset, so
    // the marker's two-generation provenance is what bounds accumulation at one.
    const { deps, removed } = fakeDeps({
      bundle: () =>
        Promise.resolve([
          { kind: "entry", fileName: "entry.js", contents: "E1" },
          { kind: "chunk", fileName: "asset-gen1aaa.css", contents: "A1" },
        ] as BundleArtifact[]),
      listOutDir: () => Promise.resolve([]),
    });

    // Build 1: emits asset-gen1aaa.css. Nothing prior to sweep.
    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );
    expect(removed).toEqual([]);

    // Build 2: emits asset-gen2bbb.css. The immediately-prior asset (gen1) must
    // survive for in-flight documents.
    deps.bundle = () =>
      Promise.resolve([
        { kind: "entry", fileName: "entry.js", contents: "E2" },
        { kind: "chunk", fileName: "asset-gen2bbb.css", contents: "A2" },
      ] as BundleArtifact[]);
    deps.listOutDir = () =>
      Promise.resolve(["client.js", "asset-gen1aaa.css", "asset-gen2bbb.css"]);

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );
    // Gen1 survives — production keeps exactly one prior generation.
    expect(removed).toEqual([]);

    // Build 3: emits asset-gen3ccc.css. Now gen1 is TWO generations old and must be
    // swept; gen2 (the new immediately-prior) survives.
    deps.bundle = () =>
      Promise.resolve([
        { kind: "entry", fileName: "entry.js", contents: "E3" },
        { kind: "chunk", fileName: "asset-gen3ccc.css", contents: "A3" },
      ] as BundleArtifact[]);
    deps.listOutDir = () =>
      Promise.resolve(["client.js", "asset-gen1aaa.css", "asset-gen2bbb.css", "asset-gen3ccc.css"]);

    await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    // Only the two-generations-old asset is swept; the prior generation is retained.
    expect(removed).toEqual(["/out/asset-gen1aaa.css"]);
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

describe("islandFileFromModule — malformed-module refusal (ASSETS_BAD_ISLAND_MODULE)", () => {
  it("classifies a well-formed defineIsland module eager/lazy/ssr from its .island", () => {
    const file = islandFileFromModule("/app/islands/account.tsx", {
      default: { island: { name: "Account", hydrate: "visible", ssr: false } },
    });

    expect(file).toEqual({
      name: "Account",
      importPath: "/app/islands/account.tsx",
      lazy: true,
      ssr: false,
    });
  });

  it("defaults lazy=false / ssr=false when the declaration omits hydrate/ssr", () => {
    const file = islandFileFromModule("/a.tsx", { default: { island: { name: "Plain" } } });

    expect(file).toMatchObject({ name: "Plain", lazy: false, ssr: false });
  });

  it("treats an ssr:true eager island as ssr (the matched-pair guard's input)", () => {
    const file = islandFileFromModule("/r.tsx", { default: { island: { name: "R", ssr: true } } });

    expect(file.ssr).toBe(true);
  });

  it.each([
    ["no default export", { notDefault: {} }],
    ["a default with no .island", { default: {} }],
    ["an undefined module", undefined],
    ["an island with a non-string name", { default: { island: { name: 42 } } }],
    ["a null island", { default: { island: null } }],
  ])("refuses %s with ASSETS_BAD_ISLAND_MODULE naming the file", (_label, module) => {
    try {
      islandFileFromModule("/app/islands/broken.tsx", module);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetsError);
      expect((error as AssetsError).code).toBe("ASSETS_BAD_ISLAND_MODULE");
      expect((error as AssetsError).message).toContain("/app/islands/broken.tsx");
      expect((error as AssetsError).details).toEqual({ importPath: "/app/islands/broken.tsx" });
    }
  });
});

describe("buildClient — gzip sizes + budget (ADR 0011: narrate, shout when over)", () => {
  it("measures the entry + each chunk by gzipSize and returns them, entry first", async () => {
    const { deps } = fakeDeps();

    const result = await buildClient(
      { islandsDir: "/app/islands", outDir: "/out", mode: "production", dialect: "react" },
      deps,
    );

    // The fake gzipSize is content.length: "ENTRY" = 5, "CHUNK" = 5. The entry is
    // measured by its CONFIGURED name (client.js), not the bundler's entry.js.
    expect(result.sizes).toEqual([
      { fileName: "client.js", kind: "entry", gzipBytes: 5 },
      { fileName: "chunk-deadbeef.js", kind: "chunk", gzipBytes: 5 },
    ]);
  });

  it("narrates the dialect/mode and each artifact's gzip size through the report seam", async () => {
    const lines: string[] = [];
    const { deps } = fakeDeps();

    await buildClient(
      {
        islandsDir: "/app/islands",
        outDir: "/out",
        mode: "production",
        dialect: "preact",
        report: (line) => lines.push(line),
      },
      deps,
    );

    const narration = lines.join("\n");

    expect(narration).toContain("lesto: client (preact, production)");
    expect(narration).toContain("entry client.js:");
    expect(narration).toContain("chunk chunk-deadbeef.js:");
    expect(narration).toContain("gzip");
  });

  it("passes a generous budget: the report notes the budget, the build does NOT throw", async () => {
    const lines: string[] = [];
    const { deps } = fakeDeps();

    const result = await buildClient(
      {
        islandsDir: "/app/islands",
        outDir: "/out",
        mode: "production",
        dialect: "react",
        budgetBytes: 1000,
        report: (line) => lines.push(line),
      },
      deps,
    );

    expect(result.entry).toBe("/out/client.js");
    // The entry line carries the budget note, NOT the "OVER" flag.
    const entryLine = lines.find((line) => line.includes("entry client.js"));
    expect(entryLine).toContain("budget");
    expect(entryLine).not.toContain("OVER");
  });

  it("FAILS the build with ASSETS_BUDGET_EXCEEDED when the entry blows the budget", async () => {
    const lines: string[] = [];
    // "ENTRY" gzips to 5 (the fake); a budget of 4 is exceeded.
    const { deps } = fakeDeps();

    try {
      await buildClient(
        {
          islandsDir: "/app/islands",
          outDir: "/out",
          mode: "production",
          dialect: "react",
          budgetBytes: 4,
          report: (line) => lines.push(line),
        },
        deps,
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AssetsError);
      expect((error as AssetsError).code).toBe("ASSETS_BUDGET_EXCEEDED");
      expect((error as AssetsError).message).toContain("client.js");
      expect((error as AssetsError).details).toMatchObject({
        fileName: "client.js",
        gzipBytes: 5,
        budgetBytes: 4,
      });
    }

    // The build still NARRATED before it threw — the report flags the entry OVER.
    const entryLine = lines.find((line) => line.includes("entry client.js"));
    expect(entryLine).toContain("OVER");
  });

  it("with no budget set, reports sizes without a budget note and never fails", async () => {
    const lines: string[] = [];
    const { deps } = fakeDeps();

    const result = await buildClient(
      {
        islandsDir: "/app/islands",
        outDir: "/out",
        mode: "development",
        dialect: "react",
        report: (line) => lines.push(line),
      },
      deps,
    );

    expect(result.sizes).toHaveLength(2);
    const entryLine = lines.find((line) => line.includes("entry client.js"));
    expect(entryLine).not.toContain("budget");
  });
});

describe("verifyPublicEnvDefine", () => {
  it("returns {} for an undefined map (the no-injection common case)", () => {
    expect(verifyPublicEnvDefine(undefined)).toEqual({});
  });

  it("passes an all-public map through unchanged", () => {
    const map = {
      "globalThis.__LESTO_PUBLIC_ENV__": '{"PUBLIC_API_BASE":"https://api"}',
      "import.meta.env.PUBLIC_FLAG": "true",
      "process.env.PUBLIC_ANALYTICS": '"abc"',
    };

    expect(verifyPublicEnvDefine(map)).toBe(map);
  });

  it("refuses an import.meta.env read of a non-PUBLIC name", () => {
    let thrown: unknown;

    try {
      verifyPublicEnvDefine({ "import.meta.env.DATABASE_URL": '"x"' });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as AssetsError).code).toBe("ASSETS_SERVER_ENV_LEAK");
    expect((thrown as AssetsError).message).toContain("DATABASE_URL");
    expect((thrown as AssetsError).details["keys"]).toEqual(["import.meta.env.DATABASE_URL"]);
  });

  it("refuses a process.env read of a non-PUBLIC name", () => {
    expect(() => verifyPublicEnvDefine({ "process.env.SECRET": '"x"' })).toThrow(AssetsError);
  });

  it("refuses an arbitrary global / unrecognized key", () => {
    let thrown: unknown;

    try {
      verifyPublicEnvDefine({ "globalThis.__SOMETHING_ELSE__": "{}" });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as AssetsError).code).toBe("ASSETS_SERVER_ENV_LEAK");
  });

  it("lists EVERY leaked key at once (plural noun)", () => {
    let thrown: AssetsError | undefined;

    try {
      verifyPublicEnvDefine({
        "process.env.A": "1",
        "process.env.B": "2",
        "import.meta.env.PUBLIC_OK": "3",
      });
    } catch (error) {
      thrown = error as AssetsError;
    }

    expect(thrown?.message).toContain("keys");
    expect(thrown?.details["keys"]).toEqual(["process.env.A", "process.env.B"]);
  });
});
