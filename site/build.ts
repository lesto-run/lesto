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

import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildClient, bunBuildClientDeps } from "@lesto/assets";
import {
  markdownTwinPath,
  renderLlmsFull,
  renderLlmsIndex,
  renderMarkdownTwin,
  type LlmsDocSection,
} from "@lesto/content-core/build";
import { createApp } from "@lesto/kernel";
import { buildStaticSites, defineStaticSite, nodeSink } from "@lesto/sites";
import { buildStyles, tailwindStyleCompiler } from "@lesto/styles";

import appConfig from "./lesto.app";
import sites from "./lesto.sites";
import { canonicalUrl, SITE_URL } from "./src/app";
import { buildNav, loadDocs, type DocEntry } from "./src/content";
import { ogImage } from "./src/og";
import { buildSearchIndex } from "./src/search-index";

const PROJECT_ROOT = process.cwd();
const OUT_DIR = "out";
const SITE_OUT = join(OUT_DIR, "docs");

// 0. Agent-legibility drift gate — dogfood `lesto generate agents` (ADR 0035). The
//    committed AGENTS.md + the PROJECT llms.txt must match the app's current
//    conventions (routes, islands, content collections, CLI surface); drift means a
//    convention changed without regenerating, so fail the build rather than ship a
//    stale agent guide. This is the convention-scan PROJECT index — distinct from the
//    docs `llms.txt` (the content corpus index) this build writes to out/docs/ below,
//    so the two never clobber one path. Regenerate with `bun run agents`.
const drift = spawnSync("lesto", ["generate", "agents", "--check"], {
  cwd: PROJECT_ROOT,
  stdio: "inherit",
});

// A spawn FAILURE is not staleness: when `lesto` can't be run at all (`@lesto/cli`
// not installed / not on PATH → ENOENT, or a crash signal) `spawnSync` leaves
// `status` null and sets `error`/`signal`. Diagnose that distinctly rather than
// blaming the artifacts and sending the operator to regenerate — the same
// don't-mask-one-failure-as-another discipline `rethrowUnlessMissingContentPeer` uses.
if (drift.error !== undefined || drift.signal !== null) {
  console.error(
    `\nCould not run \`lesto generate agents --check\` — is @lesto/cli installed? ${
      drift.error?.message ?? `killed by ${drift.signal}`
    }`,
  );

  process.exit(1);
}

if (drift.status !== 0) {
  console.error("\nAGENTS.md / llms.txt are stale — run `bun run agents` and commit the result.");

  process.exit(1);
}

const app = await createApp(appConfig);

// Clean the output dir first — the sink only writes, never deletes, so a route
// removed since the last build (e.g. the blog/changelog that moved to the
// marketing site) would otherwise leave a stale orphan HTML file that a local
// `wrangler deploy` would still ship.
await rm(SITE_OUT, { recursive: true, force: true });

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

// 2b. Compile the Tailwind v4 stylesheet → out/docs/styles.css (ADR 0037). The docs
//     dogfood @lesto/styles: `app/styles/app.css` is scanned against `src/` (where the
//     chrome's utility classes live) and resolved from the project root (`tailwindcss`).
const styles = await buildStyles(
  { entry: "app/styles/app.css", outDir: SITE_OUT, mode: "production" },
  tailwindStyleCompiler({
    resolveBase: PROJECT_ROOT,
    scanRoot: join(PROJECT_ROOT, "src"),
  }),
);

// 3. Emit the keyword search index the island fetches on mount.
const docs = await loadDocs();
const index = buildSearchIndex(docs, new Date().toISOString());
await writeFile(join(SITE_OUT, "search-index.json"), JSON.stringify(index));

// 4. Discoverability — dogfood @lesto/sites' defineStaticSite (over @lesto/seo).
//    A favicon, a sitemap of every prerendered doc route, a permissive robots.txt
//    that points crawlers at it, and the social-preview og.svg every page's
//    <head> advertises. The worker serves the whole out/docs/ tree, so these land
//    at /sitemap.xml etc.
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M22 15h7v26h17v8H22z" fill="#fff"/></svg>`;
const routes: string[] = docs.map((doc) => doc.route);
await defineStaticSite({ siteUrl: SITE_URL, routes, og: ogImage(), favicon: FAVICON }).emit(
  nodeSink(SITE_OUT),
);

// 6. AI-native docs surface — Lesto is agent-native, so its docs are too. Dogfood
//    @lesto/content-core's docs AI surface: a clean Markdown twin of every page
//    (append `.md` to any URL), an `llms.txt` index with usage instructions, and
//    `llms-full.txt` (the whole corpus). The nav grouping/order is the site's, so
//    map it into the package's generic page model; the renderers do the rest.
const byRoute = new Map(docs.map((doc) => [doc.route, doc]));
const toPage = (doc: DocEntry) => ({
  route: doc.route,
  title: doc.title,
  description: doc.description,
  body: doc.text,
});
const docSections: LlmsDocSection[] = buildNav(docs).map((section) => ({
  title: section.title,
  pages: section.items
    .map((item) => byRoute.get(item.route))
    .filter((doc): doc is DocEntry => doc !== undefined)
    .map(toPage),
}));
const llmsOptions = {
  name: "Lesto",
  tagline:
    "Lesto is a batteries-included, agent-native, full-stack TypeScript framework. This documentation is published in Markdown for AI assistants to read directly.",
  siteUrl: SITE_URL,
  howToUse: [
    `Every page is available as clean Markdown at its path + \`.md\` (e.g. \`${SITE_URL}/quickstart.md\`; the home page is \`${SITE_URL}/index.md\`).`,
    `\`${SITE_URL}/llms-full.txt\` is the entire docs corpus in a single file.`,
    "Pages tag anything that is preview or deferred; if a page does not say so, treat it as shipped.",
  ],
};
// The page dirs already exist from the prerender, so each `.md` lands beside its HTML.
for (const doc of docs) {
  const mdPath = join(SITE_OUT, markdownTwinPath(doc.route));
  await mkdir(dirname(mdPath), { recursive: true }); // nested routes: ensure the dir exists
  await writeFile(mdPath, renderMarkdownTwin(toPage(doc), canonicalUrl(doc.route)));
}
await writeFile(join(SITE_OUT, "llms.txt"), renderLlmsIndex(docSections, llmsOptions));
await writeFile(join(SITE_OUT, "llms-full.txt"), renderLlmsFull(docSections, llmsOptions));

console.log(
  `Prerendered ${pageCount} page(s); bundled ${client.islands.length} island(s); ` +
    `compiled styles.css (${(styles.gzipBytes / 1024).toFixed(1)} KB gzip); ` +
    `indexed ${index.entries.length} doc(s); wrote sitemap.xml + robots.txt + og.svg → ${SITE_OUT}/`,
);
