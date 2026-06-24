/**
 * Build the marketing site: prerender the pages, bundle the islands, emit the
 * SEO files.
 *
 *   1. `buildStaticSites` renders every route to `out/www/*.html` (all-or-
 *      nothing: a page that fails to render fails the build).
 *   2. `buildClient` bundles `app/islands/` into `out/www/client.js` — the preact
 *      client that boots the headless islands (analytics, package tabs).
 *   3. A small favicon, then the SEO trio — a sitemap of every route, a
 *      permissive robots.txt, and the social-preview image (og.svg) every page's
 *      <head> advertises.
 *
 * Run by `bun run build.ts` (the `build` and `deploy` package scripts). The
 * Cloudflare Worker serves the whole `out/www/` tree as static assets. Unlike the
 * docs site, there is no AI-docs surface (llms.txt) or search index here — a
 * marketing site is read by people, not crawled as a corpus.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { buildClient, bunBuildClientDeps } from "@lesto/assets";
import { createApp } from "@lesto/kernel";
import { buildStaticSites, defineStaticSite, nodeSink } from "@lesto/sites";
import { buildStyles, tailwindStyleCompiler } from "@lesto/styles";

import appConfig from "./lesto.app";
import sites from "./lesto.sites";
import { SITE_URL } from "./src/app";
import { loadBlog } from "./src/content";
import { ogImage } from "./src/og";

const PROJECT_ROOT = process.cwd();
const OUT_DIR = "out";
const SITE_OUT = join(OUT_DIR, "www");

const app = await createApp(appConfig);

// Clean the output dir first — the sink only writes, never deletes, so a route
// removed since the last build would otherwise leave a stale orphan HTML file
// that a local `wrangler deploy` would still ship.
await rm(SITE_OUT, { recursive: true, force: true });

// 1. Prerender every page.
const manifests = await buildStaticSites(sites, app.handle, nodeSink(OUT_DIR));
const pageCount = manifests.reduce((total, manifest) => total + manifest.pages.length, 0);

// 2. Bundle the islands into out/www/client.js (preact dialect — the pages are
//    React-SSR'd, the islands are ssr:false and boot fresh on preact).
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

// 2b. Compile the Tailwind v4 stylesheet → out/www/styles.css (ADR 0037). The site
//     dogfoods @lesto/styles: `app/styles/app.css` is scanned against `src/` (where
//     every utility class lives) and resolved from the project root (`tailwindcss`).
const styles = await buildStyles(
  { entry: "app/styles/app.css", outDir: SITE_OUT, mode: "production" },
  tailwindStyleCompiler({
    resolveBase: PROJECT_ROOT,
    scanRoot: join(PROJECT_ROOT, "src"),
  }),
);

// 3. Discoverability — dogfood @lesto/sites' defineStaticSite (over @lesto/seo).
//    A favicon, a sitemap of every prerendered route, a permissive robots.txt
//    that points crawlers at it, and the social-preview og.svg every page's
//    <head> advertises. The worker serves the whole out/www/ tree, so these land
//    at /sitemap.xml etc.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M22 15h7v26h17v8H22z" fill="#fff"/></svg>`;
const posts = await loadBlog();
const routes: string[] = [
  "/",
  "/use-cases",
  "/blog",
  ...posts.map((post) => post.route),
  "/changelog",
];
await defineStaticSite({ siteUrl: SITE_URL, routes, og: ogImage(), favicon: FAVICON }).emit(
  nodeSink(SITE_OUT),
);

console.log(
  `Prerendered ${pageCount} page(s); bundled ${client.islands.length} island(s); ` +
    `compiled styles.css (${(styles.gzipBytes / 1024).toFixed(1)} KB gzip); ` +
    `wrote sitemap.xml + robots.txt + og.svg → ${SITE_OUT}/`,
);
