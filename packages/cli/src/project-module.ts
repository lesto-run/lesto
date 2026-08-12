/**
 * Which loader one of the PROJECT's own modules goes through.
 *
 * The `lesto` bin runs the user's TypeScript — `lesto.app.ts`, every `app/routes/*`
 * module, `env.client.ts`, `lesto.sites.ts`, `lesto.build.ts`, `lesto.content.ts`,
 * `lesto.evals.ts` — by dynamic import. Which import that must be is NOT a matter of
 * taste, and getting it wrong fails only in the published shape:
 *
 *   - `bin/lesto.mjs` loads the CLI through jiti, but that does NOT make the CLI's own
 *     dynamic imports jiti's. jiti tries a NATIVE import of its entry first and only
 *     transpiles when that throws (jiti 2.7.0, observed with `JITI_DEBUG=1`) — and an
 *     entry node imported itself keeps node's `import()` for everything it loads later.
 *   - In the repo the native attempt ALWAYS throws: the workspace `@lesto/*` resolve to
 *     `src/*.ts`, whose own extensionless imports node cannot resolve. So jiti falls back,
 *     transpiles, owns the graph, and everything works — which is exactly why no in-repo
 *     test can see this. In a PUBLISHED install every `@lesto/*` is built `dist/*.js`, the
 *     native import SUCCEEDS, jiti never takes over, and the CLI's `import()` is node's.
 *   - Node then loads a `.ts` project file through type-stripping but REFUSES its
 *     extensionless relative specifiers, so a scaffold's `import { env } from "./env"`
 *     dies with `Cannot find module '<project>/env'`.
 *
 * That is the `install-proof` / `test:pack-boot` red on 53074a4: green in the repo and in
 * every `src`-entry test, broken for the outsider — the ONLY shape the bug appears in.
 * The fix is to stop depending on jiti having taken over and hold the jiti importer
 * explicitly, exactly as `@lesto/assets`' `readIsland` does for island modules
 * (L-c2ef4bec).
 *
 * Under BUN the native import is already correct — it resolves `.ts` and extensionless
 * specifiers itself AND honours the `?t=` cache-bust — so Bun keeps it. Routing Bun
 * through jiti would re-transpile the user's whole graph and SILENTLY break `lesto dev`'s
 * re-import: jiti ignores a `?t=` query and serves its cached module.
 *
 * The decision lives here, injected and covered; `bin.ts` holds only the real importers.
 */

import { sep } from "node:path";

/** A dynamic-import function: resolves a specifier to its module namespace. */
export type ModuleImporter = (specifier: string) => Promise<unknown>;

/**
 * Load one of the project's own modules. `bust` (a dev re-load) asks for a re-read
 * instead of the runtime's cached module.
 */
export type ProjectModuleLoader = (specifier: string, bust?: string) => Promise<unknown>;

/** The runtime facts + importers {@link createProjectModuleLoader} chooses between. */
export interface ProjectModuleLoaderOptions {
  /** Whether the bin is running under Bun (a `Bun` global) rather than plain node. */
  readonly runtimeIsBun: boolean;

  /** The runtime's own `import()`. */
  readonly nativeImport: ModuleImporter;

  /** A jiti instance's `import` — the only loader that resolves the project graph under node. */
  readonly jitiImport: ModuleImporter;

  /**
   * Drop the PROJECT's own modules from the node loader's cache, so the next import re-reads
   * them from disk. Called once per `lesto dev` re-load (see {@link evictProjectModules} for
   * what "the project's own" means and why it is not simply everything).
   */
  readonly evictProjectModules: () => void;
}

/** What one {@link evictProjectModules} sweep did — and, crucially, what it failed to do. */
export interface EvictionResult {
  /** Project-owned modules actually dropped, so the next import re-reads them. */
  readonly evicted: number;

  /**
   * Project-owned modules that were targeted but were STILL PRESENT after the delete — a
   * non-evictable cache. Non-zero means hot reload has silently degraded to serving stale
   * code, which is exactly what the caller must say out loud rather than swallow.
   */
  readonly survived: number;
}

/**
 * Drop every PROJECT-OWNED module from a module cache. The one thing that makes `lesto dev`
 * hot reload re-read a file the developer actually edited.
 *
 * Both runtimes need this, for the same reason by two different routes:
 *   - **node** loads project files through jiti, which serves a cached module on a repeated
 *     import and IGNORES a `?t=` query outright.
 *   - **Bun** loads them natively and DOES honour `?t=` — but only for the module named in the
 *     import. That entry's own static imports still resolve to their already-cached modules,
 *     so editing `env.ts` or a component changed nothing while the watcher reported a reload.
 *
 * Evicting first is what turns the re-import into a genuine, TRANSITIVE re-read on both.
 *
 * Only the project's own files are dropped — never anything under a `node_modules`. That
 * distinction is the whole design:
 *   - The user's `lesto.app.ts`, `env.ts`, `app/routes/*` and everything they import MUST be
 *     re-read; they are what changed.
 *   - The framework graph MUST NOT be, and not merely for speed: re-evaluating `@lesto/*`
 *     would mint a SECOND copy of every module-level singleton (the request-context
 *     `AsyncLocalStorage` among them), so the reloaded app and the running server would
 *     disagree about live state. Keeping installed deps cached is what makes this safe where
 *     a blunt `moduleCache: false` instance (or `bun --hot`, which re-runs node_modules too)
 *     would not be.
 *
 * `projectRoots` is normally one path (the project root) but takes several so a root reached
 * through a symlink can pass both its literal and real paths — a cache may key by REAL path,
 * and a missed prefix would silently mean "no reload" again.
 *
 * The delete is VERIFIED rather than assumed: Bun's ESM registry is reached through the
 * Node-compat `require.cache`, whose ESM-evictability is undocumented and could change under a
 * future Bun. A key that survives its delete is counted, so the caller can warn instead of
 * quietly serving stale code — the failure this whole function exists to prevent.
 */
export function evictProjectModules(
  cache: Record<string, unknown>,
  projectRoots: readonly string[],
): EvictionResult {
  let evicted = 0;
  let survived = 0;

  for (const key of Object.keys(cache)) {
    // An installed dependency, even one nested under the project root: keep it.
    if (key.includes(`${sep}node_modules${sep}`)) continue;

    if (projectRoots.some((root) => key.startsWith(`${root}${sep}`))) {
      delete cache[key];

      if (key in cache) survived += 1;
      else evicted += 1;
    }
  }

  return { evicted, survived };
}

/**
 * Build the loader every project-module import in the bin goes through.
 *
 * A re-load EVICTS the project's own modules first, on BOTH runtimes — that single step is
 * what makes an edit to an imported file (`env.ts`, a component, a helper) actually re-read,
 * rather than only the entry named in the import. See {@link evictProjectModules}.
 *
 * Which loader then runs differs, and only that:
 *   - **Bun** → the native import. Bun resolves `.ts` and extensionless specifiers itself, and
 *     a TLA rejection surfaces verbatim. The `?t=` suffix is KEPT on a re-load even though the
 *     eviction has already done the real work: it is the floor. If a future Bun stopped
 *     exposing an evictable module registry, behaviour degrades to exactly what it was before
 *     (the entry alone re-reads) instead of to nothing — and the survivor count makes that
 *     degradation loud rather than silent.
 *   - **node** → jiti, always with the BARE specifier: jiti ignores a `?t=` query entirely, so
 *     appending one would buy nothing and only obscure the path in a resolver error.
 *
 * It is tempting to also route Bun's re-loads through jiti for symmetry — DON'T: jiti-under-Bun
 * mangles a top-level-await rejection into `Cannot access 'default' before initialization`, and
 * the scaffold's `lesto.app.ts` opens its database with TLA, so every failed reload would
 * report that instead of the real cause.
 */
export function createProjectModuleLoader(
  options: ProjectModuleLoaderOptions,
): ProjectModuleLoader {
  const { runtimeIsBun, nativeImport, jitiImport, evictProjectModules: evict } = options;

  return (specifier, bust) => {
    if (bust !== undefined) evict();

    if (runtimeIsBun) {
      return nativeImport(bust === undefined ? specifier : `${specifier}?t=${bust}`);
    }

    return jitiImport(specifier);
  };
}
