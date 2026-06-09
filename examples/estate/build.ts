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
 * estate runs in-process (no `keel.app.ts` CLI convention), so this is its build
 * entry — there is no global `keel` command to invoke.
 */

import { fileURLToPath } from "node:url";

import { buildProductionSite } from "./src/production";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const OUT = fileURLToPath(new URL("./out", import.meta.url));

const { manifest } = await buildProductionSite(OUT, ROOT);

for (const site of manifest) {
  console.log(`built ${site.site}: ${site.pages.length} pages → out/${site.site}`);
}

console.log("bundled island client → out/marketing/client.js");
console.log("\nout/marketing is ready to deploy (see wrangler.jsonc). Next: wrangler deploy");
