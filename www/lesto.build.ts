/**
 * The post-build hook `lesto build` fires after it prerenders the pages and builds
 * the island client + Tailwind CSS (the `build`/`deploy` package scripts run plain
 * `lesto build` now — no forked script).
 *
 * It emits the discoverability files the command itself does not: a favicon, a
 * sitemap of every prerendered route, a permissive robots.txt, and the social-
 * preview og.svg every page's <head> advertises — all by dogfooding @lesto/sites'
 * `defineStaticSite` over @lesto/seo, written through the same sink the pages use.
 */

import type { BuildHook } from "@lesto/cli";
import { defineStaticSite } from "@lesto/sites";

import { SITE_URL } from "./src/app";
import { ogImage } from "./src/og";

/** A small SVG favicon (an indigo "L"), referenced from every page's <head>. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#4f46e5"/><path d="M22 15h7v26h17v8H22z" fill="#fff"/></svg>`;

const onBuilt: BuildHook = async ({ sites }) => {
  const site = sites.find((candidate) => candidate.name === "www");
  if (site === undefined) return;

  // `site.routes` is exactly what was prerendered, so the sitemap can never drift
  // from the pages on disk.
  await defineStaticSite({
    siteUrl: SITE_URL,
    routes: site.routes,
    og: ogImage(),
    favicon: FAVICON,
  }).emit(site.sink);
};

export default onBuilt;
