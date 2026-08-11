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
   * Where the one-time "hot reload is inert under node" notice goes (real impl:
   * `console.error`). Injected so the warn-once decision is testable without a console spy.
   */
  readonly warn: (message: string) => void;
}

/** The one-time notice a `lesto dev` re-load emits under plain node (see the warn-once below). */
export const NODE_RELOAD_INERT_NOTICE =
  "lesto: hot reload is inactive under node — the module cache cannot be busted here. " +
  "Restart `lesto dev` to pick up changes, or run it under bun for live reload.";

/**
 * Build the loader every project-module import in the bin goes through.
 *
 * Bun → the native import, with the `?t=<now>` suffix appended when a re-load asks for
 * one (Bun treats the query as a distinct module, so the edited file is re-read).
 *
 * Node → jiti, always with the BARE specifier: jiti resolves a `?t=` query to the same
 * cached module, so appending one would buy nothing and only obscure the path in an error
 * message. A `bust` is therefore accepted but INERT under node.
 *
 * Inert, so it says so — ONCE, on the first re-load that asks. `lesto dev` under plain node
 * used to die outright in a published install (it could not even load `lesto.app.ts`), so
 * this path is newly reachable, and a dev whose watcher prints "reloaded" while the server
 * keeps serving the old module has no way to tell. Warning beats silently-stale; the notice
 * is once-per-process because the watcher fires on every save. (Genuinely re-reading under
 * node needs a fresh no-cache jiti per reload, which re-transpiles the whole user graph —
 * a bigger change than this fix, and tracked separately.)
 */
export function createProjectModuleLoader(
  options: ProjectModuleLoaderOptions,
): ProjectModuleLoader {
  const { runtimeIsBun, nativeImport, jitiImport, warn } = options;

  let warned = false;

  return (specifier, bust) => {
    if (runtimeIsBun) {
      return nativeImport(bust === undefined ? specifier : `${specifier}?t=${bust}`);
    }

    if (bust !== undefined && !warned) {
      warned = true;
      warn(NODE_RELOAD_INERT_NOTICE);
    }

    return jitiImport(specifier);
  };
}
