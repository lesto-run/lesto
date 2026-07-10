// Unit tests for the PURE build/publish-shape logic behind the src→dist migration (0.1.6):
// `deriveEntries` (which src files tsup builds), `srcTargetToDist` (the flat src→dist mapping),
// and `rewriteManifestForPublish` (in-repo `src` manifest → published `dist` manifest). The
// effectful `buildAll` (spawns tsup) is guarded by the pack-import CI job, not here.
//
// NOTE: `scripts/` is NOT in the per-package coverage gate (scripts/coverage-gate.ts sweeps only
// packages/* with a `test:cov`). Run this file directly (it is listed in .github/workflows/ci.yml):
//   bunx vitest run scripts/build-public.test.mjs
import { describe, expect, it } from "vitest";

import { deriveEntries } from "./lib/build-public.mjs";
import { rewriteManifestForPublish, srcTargetToDist } from "./lib/pack-public.mjs";

describe("deriveEntries", () => {
  it("collects flat src targets from exports, de-duping types+import", () => {
    expect(deriveEntries({ exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } } })).toEqual([
      "src/index.ts",
    ]);
  });

  it("collects every subpath entry (multi-export packages like @lesto/ui)", () => {
    expect(
      deriveEntries({
        exports: {
          ".": { types: "./src/index.ts", import: "./src/index.ts" },
          "./client": { types: "./src/client.ts", import: "./src/client.ts" },
          "./server": { types: "./src/server.ts", import: "./src/server.ts" },
        },
      }),
    ).toEqual(["src/client.ts", "src/index.ts", "src/server.ts"]);
  });

  it("adds src/bin.ts for a package that ships an executable (both bin shims import ../src/bin.ts)", () => {
    expect(
      deriveEntries({ bin: { lesto: "./bin/lesto.mjs" }, exports: { ".": { import: "./src/index.ts" } } }),
    ).toEqual(["src/bin.ts", "src/index.ts"]);
  });

  it("ignores non-src export targets (e.g. a raw ./package.json export)", () => {
    expect(
      deriveEntries({ exports: { ".": { import: "./src/index.ts" }, "./package.json": "./package.json" } }),
    ).toEqual(["src/index.ts"]);
  });

  it("handles a .tsx target unchanged as an entry (mapping to .js happens at build)", () => {
    expect(deriveEntries({ exports: { "./react": { import: "./src/react.tsx" } } })).toEqual(["src/react.tsx"]);
  });

  it("returns just the bin entry when there are no exports", () => {
    expect(deriveEntries({ bin: "./bin/x.mjs" })).toEqual(["src/bin.ts"]);
    expect(deriveEntries({})).toEqual([]);
  });
});

describe("srcTargetToDist", () => {
  it("maps ./src/index.ts → dist js + d.ts", () => {
    expect(srcTargetToDist("./src/index.ts")).toEqual({ js: "./dist/index.js", dts: "./dist/index.d.ts" });
  });

  it("accepts a bare (no ./) src path and a .tsx extension", () => {
    expect(srcTargetToDist("src/react.tsx")).toEqual({ js: "./dist/react.js", dts: "./dist/react.d.ts" });
  });

  it("accepts .mts / .cts", () => {
    expect(srcTargetToDist("./src/x.mts").js).toBe("./dist/x.js");
    expect(srcTargetToDist("./src/y.cts").dts).toBe("./dist/y.d.ts");
  });

  it("fails closed on a NESTED src target (would mis-map under tsup's flat output)", () => {
    expect(() => srcTargetToDist("./src/a/b.ts")).toThrow(/flat \.\/src/);
  });

  it("fails closed on a non-src target", () => {
    expect(() => srcTargetToDist("./dist/index.js")).toThrow(/cannot map/);
  });
});

describe("rewriteManifestForPublish", () => {
  const versionMap = { "@lesto/errors": "0.1.6", "@lesto/router": "0.1.6", "@lesto/mail": "0.1.6" };

  it("rewrites exports: runtime conditions → dist .js, types → dist .d.ts, across subpaths", () => {
    const out = rewriteManifestForPublish(
      {
        exports: {
          ".": { types: "./src/index.ts", import: "./src/index.ts" },
          "./server": { types: "./src/server.ts", import: "./src/server.ts" },
        },
      },
      versionMap,
    );
    expect(out.exports).toEqual({
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./server": { types: "./dist/server.d.ts", import: "./dist/server.js" },
    });
  });

  it("leaves non-src export leaves untouched (a raw ./package.json export)", () => {
    const out = rewriteManifestForPublish(
      { exports: { ".": { import: "./src/index.ts" }, "./package.json": "./package.json" } },
      versionMap,
    );
    expect(out.exports["./package.json"]).toBe("./package.json");
  });

  it("leaves a null export leaf (npm's block-a-subpath idiom) untouched", () => {
    const out = rewriteManifestForPublish(
      { exports: { ".": { import: "./src/index.ts" }, "./internal": null } },
      versionMap,
    );
    expect(out.exports["./internal"]).toBeNull();
  });

  it("rewrites every workspace: protocol form using the version map", () => {
    const out = rewriteManifestForPublish(
      {
        dependencies: { "@lesto/errors": "workspace:*", react: "^19" },
        peerDependencies: { "@lesto/mail": "workspace:^" },
        optionalDependencies: { "@lesto/router": "workspace:~" },
        devDependencies: { "@lesto/errors": "workspace:1.2.3" },
      },
      versionMap,
    );
    expect(out.dependencies).toEqual({ "@lesto/errors": "0.1.6", react: "^19" });
    expect(out.peerDependencies).toEqual({ "@lesto/mail": "^0.1.6" });
    expect(out.optionalDependencies).toEqual({ "@lesto/router": "~0.1.6" });
    expect(out.devDependencies).toEqual({ "@lesto/errors": "1.2.3" });
  });

  it("treats an empty workspace spec (`workspace:`) as exact", () => {
    const out = rewriteManifestForPublish({ dependencies: { "@lesto/errors": "workspace:" } }, versionMap);
    expect(out.dependencies["@lesto/errors"]).toBe("0.1.6");
  });

  it("fails closed if a workspace dep is missing from the version map", () => {
    expect(() =>
      rewriteManifestForPublish({ dependencies: { "@lesto/ghost": "workspace:*" } }, versionMap),
    ).toThrow(/no version in the workspace map/);
  });

  it("sets files to [dist], and [bin, dist] for an executable package", () => {
    expect(rewriteManifestForPublish({ files: ["src"] }, versionMap).files).toEqual(["dist"]);
    expect(rewriteManifestForPublish({ bin: { lesto: "./bin/lesto.mjs" }, files: ["src", "bin"] }, versionMap).files).toEqual(
      ["bin", "dist"],
    );
  });

  it("normalises legacy main/module/types ONLY when present, coherent with the . export", () => {
    const withLegacy = rewriteManifestForPublish(
      {
        main: "./dist/index.mjs", // stale (points at a non-existent .mjs)
        module: "./dist/index.mjs",
        types: "./src/index.ts",
        exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } },
      },
      versionMap,
    );
    expect(withLegacy.main).toBe("./dist/index.js");
    expect(withLegacy.module).toBe("./dist/index.js");
    expect(withLegacy.types).toBe("./dist/index.d.ts");

    const noLegacy = rewriteManifestForPublish(
      { exports: { ".": { types: "./src/index.ts", import: "./src/index.ts" } } },
      versionMap,
    );
    expect(noLegacy.main).toBeUndefined();
    expect(noLegacy.module).toBeUndefined();
    expect(noLegacy.types).toBeUndefined();
  });

  it("does not mutate its input (pure)", () => {
    const input = {
      exports: { ".": { import: "./src/index.ts" } },
      dependencies: { "@lesto/errors": "workspace:*" },
      files: ["src"],
    };
    const snapshot = structuredClone(input);
    rewriteManifestForPublish(input, versionMap);
    expect(input).toEqual(snapshot);
  });
});
