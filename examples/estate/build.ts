/**
 * Build the deployable static output — for Cloudflare, or any static host.
 *
 *   bun run build.ts
 *
 * Runs the same assembly `serve.ts` does (prerender the marketing zone + bundle
 * the island client), then exits, leaving `out/marketing/` populated:
 * `index.html`, `about/index.html`, and `client.js`. That directory is exactly
 * what `wrangler.jsonc` binds as the Worker's Static Assets, so after this the
 * deploy is just `wrangler deploy`.
 *
 * estate runs in-process (no `lesto.app.ts` CLI convention), so this is its build
 * entry — there is no global `lesto` command to invoke.
 */

import { randomBytes } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { scanRoutes } from "@lesto/router";
import { generateRouteManifest } from "@lesto/web";

import { buildProductionSite } from "./src/production";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const OUT = fileURLToPath(new URL("./out", import.meta.url));

// Regenerate the file-route manifest from app/routes/ before bundling, so the
// committed src/routes.gen.ts the app + Worker import never drifts from the tree.
// This is the Lesto codegen (`generateRouteManifest`); estate hand-wires nothing.
const routeFiles = await scanRoutes(
  async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    })),
  fileURLToPath(new URL("./app/routes", import.meta.url)),
);
await writeFile(
  fileURLToPath(new URL("./src/routes.gen.ts", import.meta.url)),
  generateRouteManifest(routeFiles, { importBase: "../app/routes" }),
);
console.log(`generated src/routes.gen.ts (${routeFiles.length} route files)`);

// The prerender constructs the dynamic app only to render the static marketing
// zone — which mints no tokens — so it needs *a* valid identity secret but the
// value never reaches the output. Honor a real `LESTO_AUTH_SECRET` if the builder
// set one; otherwise use a throwaway. The deployed Worker reads its own
// `SESSION_SECRET` from the runtime env, so a CI build needs no secret of its own.
const buildSecret = process.env["LESTO_AUTH_SECRET"] ?? randomBytes(32).toString("hex");

// The deploy pair is Preact by default: the Worker SSRs through
// `preactServerRenderer` (worker.ts + the wrangler.jsonc alias), so the client
// these assets ship MUST be the Preact bundle — a React client hydrating against
// Preact markup is exactly the ssr-mismatch ADR 0008 closes.
const { manifest } = await buildProductionSite(OUT, ROOT, {
  preactClient: true,
  secret: buildSecret,
});

for (const site of manifest) {
  console.log(`built ${site.site}: ${site.pages.length} pages → out/${site.site}`);
}

console.log("bundled island client (preact) → out/marketing/client.js");
console.log("\nout/marketing is ready to deploy (see wrangler.jsonc). Next: wrangler deploy");
