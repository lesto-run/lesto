/**
 * The production assembly: prerender, bundle, and build the front-door dispatch.
 *
 * Factored out of `serve.ts` for one reason that the QA pass made concrete — so
 * the integration test exercises *exactly* the pipeline production runs, not a
 * lookalike. The `/client.js`-not-served bug slipped past every unit test because
 * the units mock the asset layer; a test that calls this function over real HTTP
 * cannot miss it.
 *
 * The three steps, in order:
 *   1. Prerender the static zone(s) to `outDir` (fails on a broken page).
 *   2. Bundle the island hydration client into the marketing zone's output, so a
 *      prerendered page's `<script src="/client.js">` resolves — `/client.js`
 *      maps to `marketing/client.js`, the file both `dispatchSites` and
 *      Cloudflare Static Assets serve. Skipping this leaves islands un-hydrated.
 *   3. Return the path-mount dispatcher: static files for static zones, the live
 *      app for dynamic ones, one origin.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { dispatchSites, nodeStaticReader } from "@keel/runtime";
import type { RequestOptions } from "@keel/runtime";
import { buildStaticSites, nodeSink } from "@keel/sites";
import type { SiteManifest } from "@keel/sites";
import type { KeelResponse } from "@keel/web";

import { buildApp } from "./app";
import sites from "../keel.sites";

/** The dispatcher a server fronts: `(method, path, options?) -> response`. */
export type SiteDispatch = (
  method: string,
  path: string,
  options?: RequestOptions,
) => Promise<KeelResponse>;

/** What the production build produced — the dispatcher plus the prerender manifest. */
export interface ProductionSite {
  readonly dispatch: SiteDispatch;

  readonly manifest: readonly SiteManifest[];
}

/**
 * Assemble the production site into `outDir`, bundling from `projectRoot`.
 *
 * `projectRoot` is where `client.tsx` lives (the example directory); the bundle
 * lands at `<outDir>/marketing/client.js`.
 */
export async function buildProductionSite(
  outDir: string,
  projectRoot: string,
): Promise<ProductionSite> {
  const app = await buildApp();

  const handle = app.handle.bind(app);

  const manifest = await buildStaticSites(sites, handle, nodeSink(outDir));

  // `--minify` strips whitespace/comments and mangles identifiers; `--define`
  // pins NODE_ENV so React tree-shakes its development-only branches (dev-mode
  // warnings + invariants are the bulk of an un-minified client bundle). Together
  // they take /client.js from ~172 KiB to a fraction of that — addressing both
  // Lighthouse's "Minify JavaScript" and "Reduce unused JavaScript" diagnostics.
  execFileSync(
    "bun",
    [
      "build",
      "client.tsx",
      "--outfile",
      join(outDir, "marketing/client.js"),
      "--target",
      "browser",
      "--minify",
      "--define",
      'process.env.NODE_ENV="production"',
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );

  const dispatch = dispatchSites({ sites, handle, readStatic: nodeStaticReader(outDir) });

  return { dispatch, manifest };
}
