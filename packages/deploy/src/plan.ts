/**
 * Planning a deploy: from a built site set to the concrete targets and routing
 * an edge needs to put the right request at the right tier.
 *
 * This is pure transformation — no IO. `planDeploy` reads the site set and the
 * static build manifest and answers, per site, "what does shipping this look
 * like?": a {@link StaticTarget} of files for the CDN, or a {@link NodeTarget}
 * describing the live process. The plan also carries the {@link RoutingRule}s —
 * the single source of truth an edge router consults to split `/` (static) from
 * `/mls/*` (node) by longest-prefix match.
 */

import { sitePath } from "@keel/sites";
import { contentTypeFor } from "./content-type";
import { DeployError } from "./errors";
import type { Site, SiteManifest } from "@keel/sites";

/** Which tier serves a path: prerendered files on a CDN, or the live app. */
export type RoutingMode = "static" | "dynamic";

/**
 * One published file: where it lives in the build output, the public URL it
 * answers, and the Content-Type the CDN should serve it with.
 */
export interface PublishFile {
  /** Path within the build output root — a manifest `outputPath`, e.g. `marketing/about/index.html`. */
  readonly file: string;

  /** The public route this file answers, e.g. `/about`. */
  readonly route: string;

  /** The Content-Type to serve, derived from the file's extension. */
  readonly contentType: string;
}

/**
 * One rule for the edge router: every request under `basePath` goes to `mode`'s
 * tier. The rules are matched longest-prefix, so `/mls` (dynamic) wins over `/`
 * (static) for `/mls/listings` while everything else falls to the CDN.
 */
export interface RoutingRule {
  /** The path prefix this rule owns — `/` for the root zone, `/mls` for a zone. */
  readonly basePath: string;

  /** The tier that serves this prefix. */
  readonly mode: RoutingMode;
}

/** What it takes to ship a static site: its zone, its rule, and its files. */
export interface StaticTarget {
  readonly kind: "static";

  /** The site's name — its directory in the build output and its plan id. */
  readonly site: string;

  /** The path prefix this site owns. */
  readonly basePath: string;

  /** This zone's routing rule, always `{ basePath, mode: "static" }`. */
  readonly routing: RoutingRule;

  /** The files to publish, each with its public route and Content-Type. */
  readonly files: readonly PublishFile[];
}

/** What it takes to run a dynamic site: its zone, its rule, and its command. */
export interface NodeTarget {
  readonly kind: "node";

  /** The site's name — its plan id. */
  readonly site: string;

  /** The path prefix this site owns and serves live. */
  readonly basePath: string;

  /** This zone's routing rule, always `{ basePath, mode: "dynamic" }`. */
  readonly routing: RoutingRule;

  /** The command that boots the tier serving this zone. */
  readonly run: string;

  /** A dynamic tier resolves every request from the database; it must be reachable. */
  readonly needsDatabase: true;
}

/** A deploy target, discriminated by which tier serves it. */
export type DeployAdapter = StaticTarget | NodeTarget;

/**
 * The whole deploy: every site's target, plus the routing manifest gathered out
 * for the edge. `routing` is the single source an edge/CDN reads to split
 * traffic; `targets` is what each tier ships.
 */
export interface DeployPlan {
  readonly targets: readonly DeployAdapter[];

  /** The routing rules across all zones, ordered most-specific prefix first. */
  readonly routing: readonly RoutingRule[];
}

/**
 * How to plan a deploy. The one real knob is the command a dynamic zone boots
 * with: `keel serve` is the Keel web tier's entrypoint and the default, but a
 * deploy target with a different runtime wrapper can name its own.
 */
export interface PlanDeployOptions {
  /** The command that boots a dynamic zone's tier. Defaults to `keel serve`. */
  readonly serveCommand?: string;
}

/** The command a dynamic Keel zone is served with — the web tier's entrypoint. */
const DEFAULT_SERVE_COMMAND = "keel serve";

/** Index a static build manifest by site name for O(1) per-site lookup. */
function manifestsByName(manifests: readonly SiteManifest[]): Map<string, SiteManifest> {
  return new Map(manifests.map((manifest) => [manifest.site, manifest]));
}

/**
 * A zone's public prefix, normalized the same way routes are.
 *
 * `sitePath` is the build/serve path math; running a site's `basePath` through
 * it (against the root route) collapses a trailing slash and keeps `/` as `/`,
 * so a rule's prefix is exactly the prefix the prerenderer used for that zone.
 */
function zonePrefix(basePath: string): string {
  return sitePath(basePath, "/");
}

/**
 * The publishable files for a static site, drawn from its build manifest.
 *
 * The manifest already named, per page, the origin `path` it answers and the
 * `outputPath` it was written to — exactly the route/file pair a CDN publishes.
 * We attach the Content-Type and drop the build-time status; a non-2xx page
 * could never have reached the manifest, since `buildStaticSites` refuses to
 * write a broken build.
 */
function filesFor(manifest: SiteManifest): readonly PublishFile[] {
  return manifest.pages.map((page) => ({
    file: page.outputPath,
    route: page.path,
    contentType: contentTypeFor(page.outputPath),
  }));
}

/** Plan a static site into its CDN target, failing if the build never built it. */
function planStatic(site: Site, manifest: SiteManifest | undefined): StaticTarget {
  // A static site with no manifest entry was never built — refuse, don't guess.
  if (manifest === undefined) {
    throw new DeployError(
      "DEPLOY_UNKNOWN_SITE",
      `Cannot plan static site "${site.name}": it is absent from the build manifest.`,
      { site: site.name },
    );
  }

  const basePath = zonePrefix(site.basePath);

  const routing: RoutingRule = { basePath, mode: "static" };

  return {
    kind: "static",
    site: site.name,
    basePath,
    routing,
    files: filesFor(manifest),
  };
}

/** Plan a dynamic site into its live-process target — no manifest involved. */
function planNode(site: Site, serveCommand: string): NodeTarget {
  const basePath = zonePrefix(site.basePath);

  const routing: RoutingRule = { basePath, mode: "dynamic" };

  return {
    kind: "node",
    site: site.name,
    basePath,
    routing,
    run: serveCommand,
    needsDatabase: true,
  };
}

/** Plan one site into its target, branching on how it renders. */
function planSite(
  site: Site,
  manifests: Map<string, SiteManifest>,
  serveCommand: string,
): DeployAdapter {
  return site.render === "static"
    ? planStatic(site, manifests.get(site.name))
    : planNode(site, serveCommand);
}

/**
 * Sort routing rules most-specific first, so an edge can match longest-prefix by
 * taking the first rule whose `basePath` the request starts with. Longer paths
 * are more specific (`/mls` before `/`); ties break lexically for a stable order.
 */
function bySpecificity(a: RoutingRule, b: RoutingRule): number {
  return b.basePath.length - a.basePath.length || a.basePath.localeCompare(b.basePath);
}

/**
 * Plan a deploy from a built site set.
 *
 * For each site we produce its target — a {@link StaticTarget} of files for the
 * CDN, or a {@link NodeTarget} for the live tier — and gather the per-zone
 * {@link RoutingRule}s into one manifest, ordered most-specific first. That
 * routing manifest is the deploy's load-bearing value: an edge reads it and
 * splits `/mls/*` to the node app from `/` to the CDN with a longest-prefix
 * match. A static site missing from the build manifest is a `DEPLOY_UNKNOWN_SITE`.
 */
export function planDeploy(
  sites: readonly Site[],
  manifest: readonly SiteManifest[],
  options: PlanDeployOptions = {},
): DeployPlan {
  const serveCommand = options.serveCommand ?? DEFAULT_SERVE_COMMAND;

  const byName = manifestsByName(manifest);

  const targets = sites.map((site) => planSite(site, byName, serveCommand));

  // Order rules most-specific first so an edge matches longest-prefix.
  const routing = targets.map((target) => target.routing).toSorted(bySpecificity);

  return { targets, routing };
}
