import { describe, expect, it } from "vitest";

import { createProjectModuleLoader, NODE_RELOAD_INERT_NOTICE } from "../src/project-module";
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
      warn: () => undefined,
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
      warn: () => undefined,
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
      warn: () => undefined,
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
      warn: () => undefined,
    });

    await load("/app/app/routes/page.tsx", "1731000000000");

    expect(native.seen).toEqual(["/app/app/routes/page.tsx?t=1731000000000"]);
  });

  it("under node: says ONCE that a re-load is inert, rather than silently serving a stale module", async () => {
    // `lesto dev` under plain node used to die outright in a published install, so this path is
    // newly reachable — and the watcher happily prints "reloaded" while the server keeps serving
    // the OLD module. Silently-stale is the worst outcome; the notice makes it visible. Once,
    // because the watcher fires on every save.
    const jiti = recordingImporter("jiti");
    const warnings: string[] = [];

    const load = createProjectModuleLoader({
      runtimeIsBun: false,
      nativeImport: forbiddenImporter("native"),
      jitiImport: jiti.importer,
      warn: (message) => warnings.push(message),
    });

    // A normal boot carries no `bust` and must stay quiet — a warning on every plain `lesto
    // routes`/`serve` would be noise on a path where nothing is wrong.
    await load("/app/lesto.app.ts");
    expect(warnings).toEqual([]);

    // Three re-loads (a burst of saves) → exactly one notice, naming the runtime and the way out.
    await load("/app/lesto.app.ts", "1");
    await load("/app/app/routes/page.tsx", "2");
    await load("/app/lesto.app.ts", "3");

    expect(warnings).toEqual([NODE_RELOAD_INERT_NOTICE]);
    expect(warnings[0]).toContain("hot reload is inactive under node");

    // ...and the loads themselves still happened, un-busted.
    expect(jiti.seen).toHaveLength(4);
  });

  it("under Bun: never warns — the `?t=` re-load genuinely works there", async () => {
    const native = recordingImporter("native");
    const warnings: string[] = [];

    const load = createProjectModuleLoader({
      runtimeIsBun: true,
      nativeImport: native.importer,
      jitiImport: forbiddenImporter("jiti"),
      warn: (message) => warnings.push(message),
    });

    await load("/app/lesto.app.ts", "1");

    expect(warnings).toEqual([]);
  });
});
