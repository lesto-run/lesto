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

import { dispatchSites, nodeStaticReader } from "@lesto/runtime";
import type { RequestOptions } from "@lesto/runtime";
import { buildStaticSites, nodeSink } from "@lesto/sites";
import type { SiteManifest } from "@lesto/sites";
import type { LestoResponse } from "@lesto/web";

import type { TraceSeams } from "@lesto/observability";

import { buildApp } from "./app";
import type { AssistantWiring } from "./assistant";
import sites from "../lesto.sites";

/** The dispatcher a server fronts: `(method, path, options?) -> response`. */
export type SiteDispatch = (
  method: string,
  path: string,
  options?: RequestOptions,
) => Promise<LestoResponse>;

/** What the production build produced — the dispatcher plus the prerender manifest. */
export interface ProductionSite {
  readonly dispatch: SiteDispatch;

  readonly manifest: readonly SiteManifest[];
}

/** What `buildProductionSite` accepts beyond its paths. */
export interface ProductionBuildOptions {
  /**
   * Bundle the client in Preact's compat dialect (`build-client.ts --preact`).
   *
   * Defaults to the `LESTO_PREACT=1` env opt-in — the node serve path, whose SSR
   * is always React, where the alias is sound only because estate's lone island
   * is deferred. The Cloudflare deploy (`build.ts`) passes `true` explicitly:
   * the Worker SSRs in Preact (see `worker.ts` + the `wrangler.jsonc` alias), so
   * its assets must carry the matched Preact client (ADR 0008).
   */
  readonly preactClient?: boolean;

  /**
   * The identity signing secret to construct the app with.
   *
   * The prerender boots the dynamic app only to render the STATIC marketing
   * zone, which signs no tokens — so the value is irrelevant to the output, and
   * `build.ts` passes an ephemeral one. This is what lets a CI build run with no
   * `LESTO_AUTH_SECRET` (a runtime-only Worker secret); absent it, the app falls
   * back to the fail-closed serve-path resolution.
   */
  readonly secret?: string;

  /**
   * The tracer's seam hooks (operability-dx item 3). `serve.ts` constructs the
   * OTLP `Traces` from the env and passes its seams here, so db queries, auth
   * events, mail deliveries, and client-error beacons all become spans. Absent
   * (a static build, a unit test) runs untraced.
   */
  readonly seams?: TraceSeams;

  /**
   * The AI concierge's wiring (ADR 0031 Inc 4) — the injected model and the
   * `ai.*`-span tracer. `serve.ts` builds these from the env (a real model when
   * `ANTHROPIC_API_KEY` is set, else the local demo model) and the OTLP `Traces`.
   * Absent (the static prerender build, a unit test) the route defaults to the
   * local demo model, untraced.
   */
  readonly assistant?: AssistantWiring;
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
  options: ProductionBuildOptions = {},
): Promise<ProductionSite> {
  const app = await buildApp(options.secret, options.seams, options.assistant);

  const handle = app.handle.bind(app);

  const manifest = await buildStaticSites(sites, handle, nodeSink(outDir));

  // The client bundle is produced by `build-client.ts`, spawned (not imported) so
  // this file stays plain node-typed and vitest-importable while the Bun-only
  // `Bun.build` API stays behind a process boundary. `--minify` strips
  // whitespace/comments and mangles identifiers; `--production` pins NODE_ENV so
  // React tree-shakes its development-only branches (dev-mode warnings +
  // invariants are the bulk of an un-minified client bundle) — addressing both
  // Lighthouse's "Minify JavaScript" and "Reduce unused JavaScript" diagnostics.
  //
  // The default path bundles real React, unchanged. `LESTO_PREACT=1` (or the
  // explicit `preactClient` option the deploy build passes) opts the CLIENT
  // bundle into Preact's compat layer (see `build-client.ts`): materially
  // smaller, and sound for estate's lone DEFERRED island (`Account`, `ssr:false`,
  // a fresh `createRoot` mount with no server markup to hydrate). An `ssr: true`
  // island additionally needs the server dialect matched — which the Worker does
  // (preactServerRenderer) and the node serve path, always-React SSR, does not.
  const preactClient = options.preactClient ?? process.env["LESTO_PREACT"] === "1";
  const preact = preactClient ? ["--preact"] : [];

  execFileSync(
    "bun",
    [
      "build-client.ts",
      "--outfile",
      join(outDir, "marketing/client.js"),
      "--minify",
      "--production",
      ...preact,
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );

  const dispatch = dispatchSites({ sites, handle, readStatic: nodeStaticReader(outDir) });

  return { dispatch, manifest };
}
