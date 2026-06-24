/**
 * The post-build hook `lesto build` fires after it prerenders the docs and builds
 * the search island + Tailwind CSS (the `build`/`deploy` package scripts run plain
 * `lesto build` now — no forked script).
 *
 * It emits everything the command itself does not, all through the same sink the
 * pages use, by dogfooding the relevant Lesto packages:
 *   - the keyword search index the search island fetches (`@lesto/content-search`);
 *   - the discoverability files — favicon, sitemap, robots, og.svg (`@lesto/sites`);
 *   - the AI-native docs surface — a `.md` twin per page, `llms.txt`, and the full
 *     corpus `llms-full.txt` (`@lesto/content-core`).
 */

import type { BuildHook } from "@lesto/cli";
import {
  markdownTwinPath,
  renderLlmsFull,
  renderLlmsIndex,
  renderMarkdownTwin,
  type LlmsDocSection,
} from "@lesto/content-core/build";
import { defineStaticSite } from "@lesto/sites";

import { canonicalUrl, SITE_URL } from "./src/app";
import { buildNav, loadDocs, type DocEntry } from "./src/content";
import { ogImage } from "./src/og";
import { buildSearchIndex } from "./src/search-index";

/** A small SVG favicon (an indigo "L"), referenced from every page's <head>. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M22 15h7v26h17v8H22z" fill="#fff"/></svg>`;

/** A doc reshaped into the generic page model `@lesto/content-core`'s renderers take. */
const toPage = (doc: DocEntry) => ({
  route: doc.route,
  title: doc.title,
  description: doc.description,
  body: doc.text,
});

const onBuilt: BuildHook = async ({ sites }) => {
  const site = sites.find((candidate) => candidate.name === "docs");
  if (site === undefined) return;
  const { sink } = site;

  const docs = await loadDocs();

  // 1. The keyword search index the deferred search island fetches on mount.
  await sink("search-index.json", JSON.stringify(buildSearchIndex(docs, new Date().toISOString())));

  // 2. Discoverability (favicon/sitemap/robots/og). `site.routes` is exactly what was
  //    prerendered, so the sitemap can never drift from the pages on disk.
  await defineStaticSite({
    siteUrl: SITE_URL,
    routes: site.routes,
    og: ogImage(),
    favicon: FAVICON,
  }).emit(sink);

  // 3. The AI-native docs surface — a clean Markdown twin of every page, an
  //    `llms.txt` index with usage instructions, and `llms-full.txt` (the whole
  //    corpus). The nav grouping/order is the site's, mapped into the package's
  //    generic page model; the renderers do the rest.
  const byRoute = new Map(docs.map((doc) => [doc.route, doc]));
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
    await sink(
      markdownTwinPath(doc.route),
      renderMarkdownTwin(toPage(doc), canonicalUrl(doc.route)),
    );
  }
  await sink("llms.txt", renderLlmsIndex(docSections, llmsOptions));
  await sink("llms-full.txt", renderLlmsFull(docSections, llmsOptions));
};

export default onBuilt;
