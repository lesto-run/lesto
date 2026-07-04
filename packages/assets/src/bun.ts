/**
 * The real `Bun.build` + `node:fs` wiring behind {@link buildClient}'s seams.
 *
 * This is the dialect-and-bundler edge — `Bun.build` (the only API that can apply
 * the preact resolver plugin; the `bun build` CLI has no `--alias`), dynamic
 * `import()` to read each island's declared hydrate strategy, and the filesystem.
 * It is the `bin`-equivalent of this package: excluded from the coverage gate
 * because it cannot run under vitest, while the orchestration it feeds
 * (`build-client.ts`) is covered with fakes.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import type { BunPlugin } from "bun";

import type { BuildClientDeps, BundleArtifact, BundleRequest } from "./build-client";
import { AssetsError } from "./errors";
import { PREACT_ALIAS } from "./preact-alias";
import { resolveInstalledPackage } from "./resolve-import";
import { islandFileFromModule } from "./synthesize";
import type { IslandFile } from "./synthesize";

/** The island module file extensions an `app/islands/` directory may hold. */
const ISLAND_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

/** Build the Bun resolver plugin that rewrites each React specifier to its Preact target. */
function preactAliasPlugin(appRoot: string): BunPlugin {
  return {
    name: "react-to-preact-compat",
    setup(build) {
      for (const [from, to] of Object.entries(PREACT_ALIAS)) {
        // Anchor the filter so `react-dom/client` is not also caught by `react-dom`.
        const filter = new RegExp(`^${from.replace(/[/\\]/g, "\\$&")}$`);

        // Every target is a bare specifier (`preact/compat`, …) resolved in the
        // consuming app's graph — the inert react-dom shims are gone now that the
        // client never imports `react-dom`/`react-dom/server` (the barrel split).
        const path = Bun.resolveSync(to, appRoot);

        build.onResolve({ filter }, () => ({ path }));
      }
    },
  };
}

/**
 * Read one island module's declaration, classifying it eager/lazy by its hydrate
 * strategy. The classification + the malformed-module refusal
 * (`ASSETS_BAD_ISLAND_MODULE`) live in the pure {@link islandFileFromModule} so
 * they are unit-tested; this only performs the Bun-only dynamic `import`.
 */
async function readIsland(path: string): Promise<IslandFile> {
  return islandFileFromModule(path, await import(path));
}

/** Whether a directory entry is an island module (by extension), ignoring synthesized/hidden files. */
function isIslandModule(name: string): boolean {
  return !name.startsWith(".") && ISLAND_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/** Bundle the synthesized entry with Bun, applying the preact alias for the preact dialect. */
async function bundle(request: BundleRequest, appRoot: string): Promise<readonly BundleArtifact[]> {
  // Bun.build takes entry FILES, so the synthesized source is staged beside the
  // output and removed after; island imports are absolute, so its location is moot.
  const entryFile = join(appRoot, ".lesto-client-entry.tsx");

  await writeFile(entryFile, request.entrySource, "utf8");

  try {
    const production = request.mode === "production";

    const result = await Bun.build({
      entrypoints: [entryFile],
      target: "browser",
      splitting: true,
      minify: production,
      // Inline the verified PUBLIC-env subset alongside NODE_ENV, so an island reads
      // its public config (an API base, an analytics key) in the browser where there
      // is no `process.env`. The map is already leak-checked in `build-client.ts`
      // (ASSETS_SERVER_ENV_LEAK), so it is applied verbatim here.
      define: {
        ...(production ? { "process.env.NODE_ENV": '"production"' } : {}),
        ...request.publicEnvDefine,
      },
      plugins: request.dialect === "preact" ? [preactAliasPlugin(appRoot)] : [],
    });

    if (!result.success) {
      for (const log of result.logs) console.error(log);

      throw new AssetsError("ASSETS_BUNDLE_FAILED", "the client bundle failed to compile", {
        dialect: request.dialect,
      });
    }

    return Promise.all(
      result.outputs.map(async (artifact) => ({
        kind: artifact.kind === "entry-point" ? ("entry" as const) : ("chunk" as const),
        fileName: basename(artifact.path),
        contents: await artifact.text(),
      })),
    );
  } finally {
    await rm(entryFile, { force: true });
  }
}

/**
 * The default {@link BuildClientDeps}, wired to real Bun + `node:fs`.
 *
 * `appRoot` is where island imports and the staged entry resolve from (the
 * project root). The preact alias's bare targets (`preact/compat`, …) resolve in
 * the app's `node_modules`.
 */
export function bunBuildClientDeps(appRoot: string): BuildClientDeps {
  return {
    listIslands: async (islandsDir) => {
      const names = await readdir(islandsDir);

      return Promise.all(
        names.filter(isIslandModule).map((name) => readIsland(join(islandsDir, name))),
      );
    },

    bundle: (request) => bundle(request, appRoot),

    // The RUM preflight's probe: is the package a framework import belongs to installed in the app's
    // node_modules chain? A pure `node_modules` walk (NOT `Bun.resolveSync`) because this seam is
    // shared with `viteBuildClientDeps`, whose `lesto build`/`deploy` runs under plain Node (the
    // jiti bin) where a `Bun` global is undefined — see `resolveInstalledPackage`.
    resolveClientImport: (specifier) => resolveInstalledPackage(specifier, appRoot, existsSync),

    // A first build has no out dir yet — that is "no stale chunks", not an error.
    listOutDir: async (outDir) => {
      try {
        return await readdir(outDir);
      } catch {
        return [];
      }
    },

    // The generation marker is absent on a first build — `undefined`, not an error.
    read: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },

    remove: (path) => rm(path),

    // Ensure the out dir exists before writing the entry/chunks — on a fresh app
    // (a just-scaffolded project) it does not yet, so the first `lesto build`/`dev`
    // must create it rather than fail with ENOENT.
    write: async (path, contents) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents);
    },

    // The gzipped byte length the size report + budget speak — the same `gzipSync`
    // the standalone `bundle-size` script measures with, so the in-build budget and
    // the CI assertion agree to the byte.
    gzipSize: (contents) => gzipSync(contents).byteLength,
  };
}
