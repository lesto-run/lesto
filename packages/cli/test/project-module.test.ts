import { describe, expect, it } from "vitest";

import { createProjectModuleLoader, evictProjectModules } from "../src/project-module";
import type { ModuleImporter } from "../src/project-module";

/**
 * The project-module loader decision — which import the bin uses for the USER's
 * TypeScript, and what it passes.
 *
 * This is the covered half of the `install-proof` fix: under node the project graph MUST
 * go through jiti, because a published install's compiled entry is imported natively and
 * its dynamic `import()` is then node's — which loads a `.ts` file by type-stripping and
 * refuses its extensionless relative specifiers. See `src/project-module.ts` for the full
 * mechanism. The end-to-end proof that the published closure really boots is
 * `scripts/pack-and-boot.mjs` (CI's `install-proof` job); what is pinned here is the
 * routing decision itself, which no in-repo spawn can observe (in the repo jiti's native
 * attempt always fails and it transpiles, masking the difference entirely).
 */

/** An importer that records what it was handed and resolves a marker namespace. */
function recordingImporter(name: string): { importer: ModuleImporter; seen: string[] } {
  const seen: string[] = [];

  return {
    seen,
    importer: (specifier) => {
      seen.push(specifier);

      return Promise.resolve({ loadedBy: name });
    },
  };
}

/** An importer that fails the test outright if the loader ever reaches it. */
const forbiddenImporter =
  (name: string): ModuleImporter =>
  (specifier) => {
    throw new Error(`the ${name} importer must not be used (was handed ${specifier})`);
  };

describe("createProjectModuleLoader", () => {
  it("under node: routes the project module through JITI — never the native import", async () => {
    const jiti = recordingImporter("jiti");

    const load = createProjectModuleLoader({
      runtimeIsBun: false,
      nativeImport: forbiddenImporter("native"),
      jitiImport: jiti.importer,
      evictProjectModules: () => undefined,
    });

    await expect(load("/app/lesto.app.ts")).resolves.toEqual({ loadedBy: "jiti" });
    expect(jiti.seen).toEqual(["/app/lesto.app.ts"]);
  });

  it("under node: a dev re-load's `bust` never reaches jiti as a `?t=` query", async () => {
    // jiti resolves `<path>?t=1` to the same cached module it already has, so appending the
    // suffix would buy nothing and would only corrupt the path in a resolver error message.
    // Asserting the BARE specifier is what keeps a future "just pass bust through" from
    // shipping a query jiti silently ignores.
    const jiti = recordingImporter("jiti");

    const load = createProjectModuleLoader({
      runtimeIsBun: false,
      nativeImport: forbiddenImporter("native"),
      jitiImport: jiti.importer,
      evictProjectModules: () => undefined,
    });

    await load("/app/lesto.app.ts", "1731000000000");

    expect(jiti.seen).toEqual(["/app/lesto.app.ts"]);
  });

  it("under Bun: keeps the NATIVE import — Bun resolves the project graph itself", async () => {
    // Bun resolves `.ts` and extensionless specifiers natively, so it needs no jiti; routing
    // it through jiti would re-transpile the user's whole graph and break the `?t=` re-load
    // below. A reached jiti importer fails this test.
    const native = recordingImporter("native");

    const load = createProjectModuleLoader({
      runtimeIsBun: true,
      nativeImport: native.importer,
      jitiImport: forbiddenImporter("jiti"),
      evictProjectModules: () => undefined,
    });

    await expect(load("/app/lesto.app.ts")).resolves.toEqual({ loadedBy: "native" });
    expect(native.seen).toEqual(["/app/lesto.app.ts"]);
  });

  it("under Bun: a dev re-load's `bust` is appended as the `?t=` cache-bust query", async () => {
    // `lesto dev` re-imports an edited `lesto.app.ts` / route file by asking for a NEW module
    // key; dropping the suffix would serve the cached module and silently stop hot reload.
    const native = recordingImporter("native");

    const load = createProjectModuleLoader({
      runtimeIsBun: true,
      nativeImport: native.importer,
      jitiImport: forbiddenImporter("jiti"),
      evictProjectModules: () => undefined,
    });

    await load("/app/app/routes/page.tsx", "1731000000000");

    expect(native.seen).toEqual(["/app/app/routes/page.tsx?t=1731000000000"]);
  });

  it("under node: EVICTS the project's cached modules on a re-load, so the next import re-reads", async () => {
    // The whole of node hot reload. jiti ignores `?t=` and serves its cached module, so
    // without this eviction `lesto dev` re-imports the OLD code while the watcher reports a
    // reload — the server silently serves stale routes.
    const jiti = recordingImporter("jiti");
    let evictions = 0;

    const load = createProjectModuleLoader({
      runtimeIsBun: false,
      nativeImport: forbiddenImporter("native"),
      jitiImport: jiti.importer,
      evictProjectModules: () => {
        evictions += 1;
      },
    });

    // A plain boot must NOT evict — there is nothing stale, and dropping the cache on every
    // ordinary `lesto routes`/`serve` import would re-read the project for no reason.
    await load("/app/lesto.app.ts");
    expect(evictions).toBe(0);

    // Each re-load evicts exactly once, before its import.
    await load("/app/lesto.app.ts", "1");
    await load("/app/app/routes/page.tsx", "2");

    expect(evictions).toBe(2);
  });

  it("under Bun: never evicts — the `?t=` re-load already re-reads there", async () => {
    const native = recordingImporter("native");
    let evictions = 0;

    const load = createProjectModuleLoader({
      runtimeIsBun: true,
      nativeImport: native.importer,
      jitiImport: forbiddenImporter("jiti"),
      evictProjectModules: () => {
        evictions += 1;
      },
    });

    await load("/app/lesto.app.ts", "1");

    expect(evictions).toBe(0);
  });
});

/** Cache entries as jiti holds them: absolute real paths → module records. */
const cacheOf = (...keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.map((key) => [key, { id: key }]));

describe("evictProjectModules", () => {
  // Cache keys as jiti holds them: absolute real paths.
  const ROOT = "/proj";

  it("drops the project's own modules and reports how many", () => {
    const cache = cacheOf(
      "/proj/lesto.app.ts",
      "/proj/env.ts",
      "/proj/app/routes/page.tsx",
      "/other/elsewhere.ts",
    );

    expect(evictProjectModules(cache, [ROOT])).toBe(3);
    expect(Object.keys(cache)).toEqual(["/other/elsewhere.ts"]);
  });

  it("KEEPS installed dependencies, even nested under the project root", () => {
    // Re-evaluating `@lesto/*` would mint a second copy of every module-level singleton (the
    // request-context AsyncLocalStorage among them), so the reloaded app and the running
    // server would disagree about live state. This is the assertion that keeps a future
    // "just clear the whole cache" from looking harmless.
    const cache = cacheOf(
      "/proj/lesto.app.ts",
      "/proj/node_modules/@lesto/web/dist/index.js",
      "/proj/node_modules/.bun/jiti/dist/jiti.cjs",
    );

    expect(evictProjectModules(cache, [ROOT])).toBe(1);
    expect(Object.keys(cache)).toEqual([
      "/proj/node_modules/@lesto/web/dist/index.js",
      "/proj/node_modules/.bun/jiti/dist/jiti.cjs",
    ]);
  });

  it("matches ANY of the given roots, so a symlinked project still reloads", () => {
    // jiti keys the cache by REAL path. A project reached through a symlink would never match
    // a bare `process.cwd()` prefix, and its hot reload would silently do nothing.
    const cache = cacheOf("/real/volume/app/lesto.app.ts", "/elsewhere/x.ts");

    expect(evictProjectModules(cache, ["/home/me/app", "/real/volume/app"])).toBe(1);
    expect(Object.keys(cache)).toEqual(["/elsewhere/x.ts"]);
  });

  it("does not treat a SIBLING directory sharing the root's name prefix as the project", () => {
    // `/proj-backup/x.ts` starts with `/proj` as a raw string; only a path-separated prefix
    // is genuinely inside the project.
    const cache = cacheOf("/proj-backup/x.ts", "/proj/keep-me.ts");

    expect(evictProjectModules(cache, [ROOT])).toBe(1);
    expect(Object.keys(cache)).toEqual(["/proj-backup/x.ts"]);
  });

  it("is a no-op on an empty cache", () => {
    expect(evictProjectModules({}, [ROOT])).toBe(0);
  });
});
