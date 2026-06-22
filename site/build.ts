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

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildClient, bunBuildClientDeps } from "@lesto/assets";
import { createApp } from "@lesto/kernel";
import { robots, sitemap, type SitemapUrl } from "@lesto/seo";
import { buildStaticSites, nodeSink } from "@lesto/sites";

import appConfig from "./lesto.app";
import sites from "./lesto.sites";
import { docMarkdown, llmsFull, llmsIndex, markdownPath } from "./src/ai-docs";
import { canonicalUrl, SITE_URL } from "./src/app";
import { loadBlog, loadDocs } from "./src/content";
import { ogImage } from "./src/og";
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
const docs = await loadDocs();
const index = buildSearchIndex(docs, new Date().toISOString());
await writeFile(join(SITE_OUT, "search-index.json"), JSON.stringify(index));

// 4. A small SVG favicon (an indigo "L"), referenced from every page's <head>.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M22 15h7v26h17v8H22z" fill="#fff"/></svg>`;
await writeFile(join(SITE_OUT, "favicon.svg"), FAVICON);

// 5. SEO discoverability — dogfood @lesto/seo. A sitemap of every prerendered
//    route (docs + blog + changelog), a permissive robots.txt that points
//    crawlers at it, and the social-preview image (og.svg) every page's <head>
//    advertises. The worker serves the whole out/docs/ tree, so these land at
//    /sitemap.xml etc.
// /blog and /changelog are registered + prerendered unconditionally (see
// lesto.sites.ts), so the sitemap lists them unconditionally too.
const blog = await loadBlog();
const routes: string[] = [
  ...docs.map((doc) => doc.route),
  "/blog",
  ...blog.map((post) => post.route),
  "/changelog",
];
const sitemapUrls: SitemapUrl[] = routes.map((route) => ({
  loc: canonicalUrl(route),
  priority: route === "/" ? 1 : 0.7,
}));
await writeFile(join(SITE_OUT, "sitemap.xml"), sitemap(sitemapUrls));
await writeFile(join(SITE_OUT, "robots.txt"), robots({ sitemap: `${SITE_URL}/sitemap.xml` }));
await writeFile(join(SITE_OUT, "og.svg"), ogImage());

// 6. AI-native docs surface — Lesto is agent-native, so its docs are too. A clean
//    Markdown twin of every page (append `.md` to any URL), an `llms.txt` index
//    with usage instructions, and `llms-full.txt` (the whole corpus). The page
//    dirs already exist from the prerender, so each `.md` lands beside its HTML.
for (const doc of docs) {
  const mdPath = join(SITE_OUT, markdownPath(doc.route));
  await mkdir(dirname(mdPath), { recursive: true }); // nested routes: ensure the dir exists
  await writeFile(mdPath, docMarkdown(doc, canonicalUrl(doc.route)));
}
await writeFile(join(SITE_OUT, "llms.txt"), llmsIndex(docs, SITE_URL));
await writeFile(join(SITE_OUT, "llms-full.txt"), llmsFull(docs, SITE_URL));

console.log(
  `Prerendered ${pageCount} page(s); bundled ${client.islands.length} island(s); indexed ${index.entries.length} doc(s); wrote sitemap.xml + robots.txt + og.svg → ${SITE_OUT}/`,
);
