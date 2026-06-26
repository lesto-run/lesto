/**
 * The real Vite (Rolldown) wiring behind {@link buildClient}'s `bundle` seam — the
 * PRODUCTION island bundler (DX-parity R2 Phase 2).
 *
 * This closes the Phase-1 dev/prod bundler mismatch: `lesto dev` already serves
 * islands through Vite (`@lesto/island-dev`, the scaffold default), so `lesto build`
 * bundling them with Vite too means dev and prod share ONE bundler. It is the direct
 * sibling of {@link bunBuildClientDeps} — same {@link BuildClientDeps} contract, same
 * discovery + filesystem seams (reused verbatim; only the `bundle` step differs) — and,
 * like `bun.ts`, it is the irreducible bundler edge excluded from the coverage gate
 * because it cannot run a real bundle under vitest. The orchestration it feeds
 * (`build-client.ts`: the stale-chunk sweep, the budget, the dialect/SSR refusal) is
 * covered with fakes and is bundler-agnostic, so it governs this backend unchanged.
 *
 * Unlike the dev server (`@lesto/island-dev`), the PROD build needs no Fast-Refresh
 * plugin — only `vite` itself — so this lives in `@lesto/assets` beside the
 * orchestration rather than dragging the dev-only `@vitejs/plugin-react` /
 * `@prefresh/vite` peers into every `lesto build`.
 */

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "vite";
import type { Alias, Rollup } from "vite";

import { bunBuildClientDeps } from "./bun";
import type { BuildClientDeps, BundleArtifact, BundleRequest } from "./build-client";
import { AssetsError } from "./errors";
import { PREACT_ALIAS } from "./preact-alias";

/**
 * The preact dialect's resolve aliases — each `react*` specifier anchored (`^…$`) to
 * its `preact/compat` target so `react` is rewritten without also catching `react-dom`.
 * The matched sibling of `bun.ts`'s `preactAliasPlugin` and `@lesto/island-dev`'s dev
 * config: the SAME {@link PREACT_ALIAS} map, expressed as Vite `resolve.alias`.
 */
function preactAliases(): Alias[] {
  return Object.entries(PREACT_ALIAS).map(([from, to]) => ({
    find: new RegExp(`^${from.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`),
    replacement: to,
  }));
}

/**
 * Flatten Vite's build result into the {@link BundleArtifact}s the orchestration writes.
 *
 * `build({ write: false })` returns the in-memory Rollup output (an array iff multiple
 * outputs were configured; one object otherwise). The synthesized entry's chunk is the
 * one with `isEntry` — every other chunk is a lazy island's split (a `hydrate: "visible"`
 * island reached through a dynamic `import()`, the ADR-0009 per-island split). Emitted
 * assets (an island's imported CSS/binary) ride through as non-entry artifacts so they
 * are written too. The orchestration renames the entry to its configured `client.js` and
 * writes the chunks under their content-hashed names.
 */
function collectArtifacts(
  result: Rollup.RollupOutput | Rollup.RollupOutput[],
): readonly BundleArtifact[] {
  const outputs = Array.isArray(result) ? result : [result];

  return outputs.flatMap((output) =>
    output.output.map((item) =>
      item.type === "chunk"
        ? {
            kind: item.isEntry ? ("entry" as const) : ("chunk" as const),
            fileName: item.fileName,
            contents: item.code,
          }
        : { kind: "chunk" as const, fileName: item.fileName, contents: item.source },
    ),
  );
}

/** Bundle the synthesized entry with Vite, applying the preact alias for the preact dialect. */
async function bundle(request: BundleRequest, appRoot: string): Promise<readonly BundleArtifact[]> {
  // Vite/Rollup takes entry FILES, so the synthesized source is staged inside the project
  // root (where its `@lesto/ui`/island imports resolve) and removed after — the same
  // stage-and-clean dance `bun.ts` does.
  const entryFile = join(appRoot, ".lesto-client-entry.tsx");

  await writeFile(entryFile, request.entrySource, "utf8");

  const production = request.mode === "production";

  let result: Rollup.RollupOutput | Rollup.RollupOutput[];

  try {
    result = (await build({
      root: appRoot,
      // This inline config is authoritative — never merge the app's own `vite.config`.
      configFile: false,
      logLevel: "warn",
      clearScreen: false,
      // `mode` drives `process.env.NODE_ENV` (production → "production", the dead-code
      // elimination React/Preact rely on; development → unminified dev runtime), so it
      // need not be redefined below — matching `bun.ts`'s mode-gated NODE_ENV define.
      mode: production ? "production" : "development",
      // Relative dynamic-import + asset URLs, so a lazy island chunk's `import("./chunk-x.js")`
      // resolves beside `/client.js` exactly as Bun's relative chunk imports do.
      base: "./",
      // The verified PUBLIC_* inject map (`@lesto/env`'s `clientDefineMap`), already
      // leak-checked in `build-client.ts`, applied verbatim — the Vite twin of the Bun
      // path's `define`. NODE_ENV is handled by `mode`, so only the public map is here.
      define: { ...request.publicEnvDefine },
      resolve: {
        alias: request.dialect === "preact" ? preactAliases() : [],
        // Force ONE runtime copy across the app and the symlinked workspace `@lesto/ui` —
        // a second React/Preact instance breaks hooks. The dev config's matched guard.
        dedupe: request.dialect === "preact" ? ["preact"] : ["react", "react-dom"],
      },
      build: {
        // Keep the artifacts in memory; the orchestration owns the write-then-sweep on
        // disk (so a crash never strands a half-swept out dir — `build-client.ts`).
        write: false,
        minify: production,
        // We measure gzip ourselves (`gzipSize`, the budget unit); skip Vite's own report.
        reportCompressedSize: false,
        // No modulepreload polyfill: the entry is loaded as a module script in modern
        // browsers, and the polyfill would only pad the budget-measured entry bytes.
        modulePreload: { polyfill: false },
        rollupOptions: {
          input: entryFile,
          // Bun parity for namespace-member access to a missing export. Rollup classifies
          // `ns.missing` (an `import * as ns` member that the module doesn't export) as a
          // NON-FATAL `MISSING_EXPORT` warning — the access is `undefined` at runtime, which
          // is exactly how `Bun.build` bundles it. Vite's build escalates that warning to a
          // fatal error by default; downgrade it back so the prod Vite bundle does not
          // REGRESS apps the Bun build accepts today. The contained live case is
          // `@lesto/ui`'s `React.use` under the preact dialect (`preact/compat` exports no
          // `use`; it is only ever CALLED server-side where React is real — see
          // `define-island.tsx`). A genuine missing NAMED import (`import { x }`) is a hard
          // Rollup ERROR, not this warning, so it still fails the build loud.
          onwarn(warning, defaultHandler) {
            if (warning.code === "MISSING_EXPORT") {
              console.warn(`lesto: ${warning.message}`);

              return;
            }

            defaultHandler(warning);
          },
          output: {
            format: "es",
            // The orchestration writes the entry to its configured name (`client.js`),
            // so this is moot for the entry; the lazy-island chunks must match
            // `isChunkFile` (`chunk-<hash>.js`) for the stale-chunk sweep + generation
            // marker to track them. `hashCharacters: "hex"` keeps the hash alphanumeric
            // (Rollup's base64url default emits `-`/`_`, which that predicate rejects).
            // An emitted asset (an island's imported CSS/binary) gets a DISTINCT
            // `asset-` prefix — never `chunk-` — so it does not masquerade as a sweepable
            // JS chunk (`isChunkFile` is `.js`-only; an asset is not swept under either
            // bundler — a pre-existing cross-bundler gap tracked separately).
            entryFileNames: "client.js",
            chunkFileNames: "chunk-[hash].js",
            assetFileNames: "asset-[hash][extname]",
            hashCharacters: "hex",
          },
        },
      },
      // `build()` returns a RollupWatcher only when `build.watch` is set, which it is not
      // here — so the result is the RollupOutput(s) `collectArtifacts` expects.
    })) as Rollup.RollupOutput | Rollup.RollupOutput[];
  } catch (cause) {
    console.error(cause);

    throw new AssetsError("ASSETS_BUNDLE_FAILED", "the client bundle failed to compile", {
      dialect: request.dialect,
    });
  } finally {
    await rm(entryFile, { force: true });
  }

  return collectArtifacts(result);
}

/**
 * The Vite-backed {@link BuildClientDeps} for `lesto build` (DX-parity R2 Phase 2).
 *
 * Only the `bundle` step is Vite's; island discovery and every filesystem seam are
 * runtime-agnostic (an `await import` of the island module, `node:fs`, `node:zlib`), so
 * they are reused VERBATIM from {@link bunBuildClientDeps} — the same island set + the
 * same gzip unit dev and prod already share, with one bundler swapped underneath. The
 * matched sibling `@lesto/island-dev` reuses that lister the same way for the dev server.
 */
export function viteBuildClientDeps(appRoot: string): BuildClientDeps {
  return {
    ...bunBuildClientDeps(appRoot),
    bundle: (request) => bundle(request, appRoot),
  };
}
