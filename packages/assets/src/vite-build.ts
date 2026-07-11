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
import { collectArtifacts } from "./collect-artifacts";
import { AssetsError } from "./errors";
import { failOnMissingExport } from "./missing-export";
import { dialectRuntimeDeps, preactAliases } from "./vite-alias";

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
        // The shared {@link preactAliases} returns the narrow `{find, replacement}` shape
        // (Vite-free, so island-dev's covered config can share it); it is structurally a
        // Vite `Alias`, cast here at the bundler edge to satisfy `resolve.alias`'s mutable
        // `Alias[]`. `react` needs no alias (its specifiers are already the real runtime).
        alias: request.dialect === "preact" ? (preactAliases() as Alias[]) : [],
        // Force ONE runtime copy across the app and the symlinked workspace `@lesto/ui` —
        // a second React/Preact instance breaks hooks. The dev config's matched guard,
        // derived from the SAME shared {@link dialectRuntimeDeps} so dev and prod agree.
        dedupe: dialectRuntimeDeps(request.dialect).dedupe,
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
          // Make a missing export FATAL. Rollup classifies `ns.missing` (an `import * as ns`
          // member the module doesn't export, or an unreferenced `import { missing }`) as a
          // NON-FATAL `MISSING_EXPORT` warning and compiles the access to `undefined` — and
          // Vite's default handler only WARNS it (only `UNRESOLVED_IMPORT` throws), so a
          // genuine user typo (`ns.typo`) would otherwise ship to prod silently as `undefined`.
          //
          // `failOnMissingExport` (extracted, unit-tested to 100%: `missing-export.ts`) THROWS
          // a coded `ASSETS_MISSING_EXPORT` `AssetsError` naming the missing binding + exporter
          // + importer when the miss was written in FIRST-PARTY source; the throw rides out of
          // Rollup's build and is caught below (which `console.error`s the cause) and re-thrown
          // UNFLATTENED, so the user — and a programmatic caller — sees which binding/module
          // missed. A miss whose importer lives under `node_modules` is a dependency's own
          // guarded-optional access (e.g. `React.use ?? shim` under the preact dialect, whose
          // `preact/compat` is a strict subset of React) and is left a plain warning — failing
          // the app build over a dependency's deliberate feature-probe would be a false
          // positive. The one historical FIRST-PARTY producer — `@lesto/ui`'s `React.use` off
          // the `react → preact/compat` namespace under the preact dialect — is gone (the
          // resolver now carries React's `use` through a server-only seam, so no `react`
          // specifier rides the client island graph). Every other warning code is forwarded to
          // `defaultHandler` unchanged.
          //
          // This DELIBERATELY diverges from `Bun.build`, which silently ships the same access
          // as `undefined` — that silence is the bug, not a parity target. (A missing NAMED
          // import actually REFERENCED in code is already a hard Rollup ERROR thrown before
          // `onwarn` is reached, so it fails loud regardless of this hook.)
          onwarn(warning, defaultHandler) {
            failOnMissingExport(warning);

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

    // A first-party MISSING_EXPORT already names the exact binding + exporter +
    // importer — re-throw it unflattened so that actionable detail survives to a
    // programmatic `buildClient` caller, not just the console. Any other failure
    // is opaque here, so it wears the generic bundle-failed code.
    if (cause instanceof AssetsError && cause.code === "ASSETS_MISSING_EXPORT") throw cause;

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
