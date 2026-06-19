/**
 * Prerender the docs site to static HTML.
 *
 * Boots the app, then asks `@lesto/sites` to render every route the static zone
 * declares (`lesto.sites.ts`) and write each to `out/docs/`. The build is
 * all-or-nothing: if any page fails to render, nothing is written and this
 * exits non-zero — so a broken doc never ships. There are no islands, so there
 * is no client bundle to build; the output is pure HTML.
 *
 * Run by `bun run build.ts` (the `build` and `deploy` package scripts). The
 * Cloudflare Worker (`worker.ts`) serves the `out/docs/` files this produces.
 */

import { createApp } from "@lesto/kernel";
import { buildStaticSites, nodeSink } from "@lesto/sites";

import appConfig from "./lesto.app";
import sites from "./lesto.sites";

const OUT_DIR = "out";

const app = await createApp(appConfig);
const manifests = await buildStaticSites(sites, app.handle, nodeSink(OUT_DIR));

const pageCount = manifests.reduce((total, manifest) => total + manifest.pages.length, 0);
console.log(`Prerendered ${pageCount} page(s) to ${OUT_DIR}/docs/`);
