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

/**
 * Drop every PROJECT-OWNED module from a jiti module cache, returning how many were dropped.
 * The one thing that makes `lesto dev` hot reload work under plain node.
 *
 * jiti serves a cached module for a repeated import and IGNORES a `?t=` query (unlike node's
 * ESM loader and Bun, which treat the query as a new module) — so once the CLI routes project
 * files through jiti, the re-import a file-change triggers hands back the OLD module and the
 * server keeps serving stale code while the watcher cheerfully reports a reload. Evicting the
 * cache entry first is what turns the re-import into a genuine re-read.
 *
 * Only the project's own files are dropped — never anything under a `node_modules`. That
 * distinction is the whole design:
 *   - The user's `lesto.app.ts`, `env.ts`, and `app/routes/*` MUST be re-read; they are what
 *     changed. Dropping the entry re-reads the file's transitive project imports too, so
 *     editing `env.ts` is picked up, not just the entry.
 *   - The framework graph MUST NOT be, and not merely for speed: re-evaluating `@lesto/*`
 *     would mint a SECOND copy of every module-level singleton (the request-context
 *     `AsyncLocalStorage` among them), so the reloaded app and the running server would
 *     disagree about live state. Keeping installed deps cached is what makes this safe where
 *     a blunt `moduleCache: false` instance would not be.
 *
 * `projectRoots` is normally one path (the project root) but takes several so a root reached
 * through a symlink can pass both its literal and real paths — jiti keys the cache by REAL
 * path, and a missed prefix would silently mean "no reload" again.
 */
export function evictProjectModules(
  cache: Record<string, unknown>,
  projectRoots: readonly string[],
): number {
  let evicted = 0;

  for (const key of Object.keys(cache)) {
    // An installed dependency, even one nested under the project root: keep it.
    if (key.includes(`${sep}node_modules${sep}`)) continue;

    if (projectRoots.some((root) => key.startsWith(`${root}${sep}`))) {
      delete cache[key];
      evicted += 1;
    }
  }

  return evicted;
}

/**
 * Build the loader every project-module import in the bin goes through.
 *
 * Bun → the native import, with the `?t=<now>` suffix appended when a re-load asks for one
 * (Bun treats the query as a distinct module, so the edited file is re-read).
 *
 * KNOWN LIMIT on that Bun path: `?t=` re-reads the named ENTRY only — its static imports still
 * resolve to their already-cached modules. So `lesto dev` under Bun picks up an edit to
 * `lesto.app.ts` or to a route file, but NOT to a helper/component/`env.ts` those import; that
 * stays stale until restart. The node path below has no such hole (evicting drops the whole
 * project subtree). It is tempting to "fix" Bun by routing its re-loads through jiti too —
 * DON'T: jiti-under-Bun mangles a top-level-await rejection into `Cannot access 'default'
 * before initialization`, and the scaffold's `lesto.app.ts` opens its database with TLA, so
 * every failed reload would report that instead of the real error. Bun exposes no userland ESM
 * cache to evict, so closing this properly needs the reload to run through a real module graph
 * (the Vite dev-server direction `@lesto/island-dev` already takes for islands), not a
 * different loader here.
 *
 * Node → jiti, always with the BARE specifier, since jiti ignores a `?t=` query. A re-load
 * instead EVICTS the project's own modules from jiti's cache first ({@link
 * evictProjectModules}), which is what actually makes the next import re-read from disk.
 */
export function createProjectModuleLoader(
  options: ProjectModuleLoaderOptions,
): ProjectModuleLoader {
  const { runtimeIsBun, nativeImport, jitiImport, evictProjectModules: evict } = options;

  return (specifier, bust) => {
    if (runtimeIsBun) {
      return nativeImport(bust === undefined ? specifier : `${specifier}?t=${bust}`);
    }

    if (bust !== undefined) evict();

    return jitiImport(specifier);
  };
}
