/**
 * Build the docs site: prerender the pages, bundle the search island, emit the
 * search index.
 *
 *   1. `buildStaticSites` renders every doc route to `out/docs/*.html`
 *      (all-or-nothing: a page that fails to render fails the build).
 *   2. `buildClient` bundles `app/islands/` into `out/docs/client.js` — the
 *      preact client that mounts the deferred search box (small, ssr:false).
 *   3. `buildSearchIndex` writes `out/docs/search-index.json`, the keyword index
 *      the search box fetches on mount.
 *
 * Run by `bun run build.ts` (the `build` and `deploy` package scripts). The
 * Cloudflare Worker serves the whole `out/docs/` tree as static assets.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildClient, bunBuildClientDeps } from "@lesto/assets";
import { createApp } from "@lesto/kernel";
import { buildStaticSites, nodeSink } from "@lesto/sites";

import appConfig from "./lesto.app";
import sites from "./lesto.sites";
import { loadDocs } from "./src/content";
import { buildSearchIndex } from "./src/search-index";

const PROJECT_ROOT = process.cwd();
const OUT_DIR = "out";
const SITE_OUT = join(OUT_DIR, "docs");

const app = await createApp(appConfig);

// 1. Prerender every doc page.
const manifests = await buildStaticSites(sites, app.handle, nodeSink(OUT_DIR));
const pageCount = manifests.reduce((total, manifest) => total + manifest.pages.length, 0);

// 2. Bundle the search island into out/docs/client.js (preact dialect — the
//    pages are React-SSR'd, the island is ssr:false and mounts fresh on preact).
//    `buildClient` resolves island imports as absolute paths, so root them here.
const client = await buildClient(
  {
    islandsDir: join(PROJECT_ROOT, "app/islands"),
    outDir: join(PROJECT_ROOT, SITE_OUT),
    entryName: "client.js",
    mode: "production",
    dialect: "preact",
  },
  bunBuildClientDeps(PROJECT_ROOT),
);

// 3. Emit the keyword search index the island fetches on mount.
const index = buildSearchIndex(await loadDocs(), new Date().toISOString());
await writeFile(join(SITE_OUT, "search-index.json"), JSON.stringify(index));

console.log(
  `Prerendered ${pageCount} page(s); bundled ${client.islands.length} island(s); indexed ${index.entries.length} doc(s) → ${SITE_OUT}/`,
);
