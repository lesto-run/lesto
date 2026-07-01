/**
 * Regenerate `src/routes.gen.ts` from `app/routes/` via the Lesto codegen
 * (`generateRouteManifest`) — the ONE source for estate's file routes on the
 * production Node path (serve) and the edge (worker). estate hand-wires nothing.
 *
 * Run as a PRE-STEP before each entry (`bun src/regenerate-routes.ts && bun
 * serve.ts`, etc.), never imported for its side effect. It must be a separate
 * process: `serve.ts` (through `src/production.ts`) and `worker.ts` statically
 * import `routes.gen.ts` at module load — before any of their own code runs — so a
 * regen inside them would always be too late. Running it first means the entry then
 * imports a fresh manifest, so "drop a file under app/routes/ → it routes" holds on
 * the next start. (`lesto dev` needs no pre-step of its own — it re-scans
 * `app/routes/` at boot and on every save — but the `dev` script still runs it so
 * the committed edge manifest stays in sync.)
 */

import { readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { scanRoutes } from "@lesto/router";
import { generateRouteManifest } from "@lesto/web";

/** Scan `app/routes/`, write the static manifest to `src/routes.gen.ts`, return the file count. */
export async function regenerateRoutes(): Promise<number> {
  const files = await scanRoutes(
    async (path) =>
      (await readdir(path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      })),
    fileURLToPath(new URL("../app/routes", import.meta.url)),
  );

  await writeFile(
    fileURLToPath(new URL("./routes.gen.ts", import.meta.url)),
    generateRouteManifest(files, { importBase: "../app/routes" }),
  );

  return files.length;
}

// Run only when invoked directly (`bun src/regenerate-routes.ts`), not on import.
if (import.meta.main) {
  const count = await regenerateRoutes();
  console.log(`generated src/routes.gen.ts (${count} route files)`);
}
