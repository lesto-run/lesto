/**
 * @keel/deploy — from a built site set to deployable targets.
 *
 * A thin planning layer: `planDeploy` reads the site set and the static build
 * manifest and produces, per site, a {@link StaticTarget} of files for a CDN or
 * a {@link NodeTarget} for the live tier — plus the {@link RoutingRule}s an edge
 * reads to split `/mls/*` (node) from `/` (static) by longest-prefix match.
 * `shipStatic` then publishes a static target's files through an injected
 * uploader, so the bytes can land on disk, in a CDN, or in a test's map.
 *
 *   const plan = planDeploy(sites, manifest);
 *   for (const target of plan.targets) {
 *     if (target.kind === "static") await shipStatic(target, "out", nodeUploader("dist"));
 *   }
 *   // plan.routing -> the edge router's manifest, most-specific prefix first.
 */

export { contentTypeFor } from "./content-type";

export { planDeploy } from "./plan";
export type {
  DeployAdapter,
  DeployPlan,
  NodeTarget,
  PlanDeployOptions,
  PublishFile,
  RoutingMode,
  RoutingRule,
  StaticTarget,
} from "./plan";

export { nodeUploader, shipStatic } from "./ship";
export type { ShipDeps, ShipResult } from "./ship";

export { DeployError } from "./errors";
export type { DeployErrorCode } from "./errors";
