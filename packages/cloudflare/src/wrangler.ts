/**
 * Generate a wrangler config from a deploy plan.
 *
 * The Cloudflare deployment of a Keel site set is one Worker plus a Static
 * Assets binding: the Worker runs the dynamic zone(s), and the prerendered
 * static zone(s) are served from the assets directory (tried first — see
 * `withAssets`). This reads the {@link DeployPlan} to confirm there is a dynamic
 * zone for the Worker to run, then emits the `wrangler.jsonc` object that wires
 * it up: `nodejs_compat` (for `node:crypto` — the signed-session HMAC) and the
 * assets binding the Worker reaches through `env.ASSETS`.
 *
 * Pure: it returns a plain object; the caller serializes it to `wrangler.jsonc`.
 * `compatibility_date` is an input, never `new Date()` — a generated config must
 * be reproducible.
 */

import type { DeployPlan } from "@keel/deploy";

import { CloudflareError } from "./errors";

/** What the generator needs that the plan cannot supply — names, dates, paths. */
export interface WranglerOptions {
  /** The Worker's name. */
  readonly name: string;

  /** The Worker entry module (the file exporting `{ fetch }`). */
  readonly main: string;

  /** Pinned compatibility date — reproducible, so passed in, never derived. */
  readonly compatibilityDate: string;

  /** The directory of prerendered static files to bind as assets. */
  readonly assetsDir: string;

  /** The binding name the Worker reads assets through. Defaults to `ASSETS`. */
  readonly assetsBinding?: string;
}

/** The `wrangler.jsonc` shape this emits — a plain object the caller serializes. */
export interface WranglerConfig {
  readonly name: string;

  readonly main: string;

  readonly compatibility_date: string;

  readonly compatibility_flags: readonly string[];

  readonly assets: {
    readonly directory: string;

    readonly binding: string;
  };
}

/**
 * Build the wrangler config for deploying a plan to Cloudflare.
 *
 * Throws `CLOUDFLARE_NO_DYNAMIC_ZONE` when the plan has no dynamic target — a
 * fully-static site needs no Worker, so generating one would be a mistake worth
 * surfacing rather than a silent empty Worker.
 */
export function wranglerConfig(plan: DeployPlan, options: WranglerOptions): WranglerConfig {
  const hasDynamicZone = plan.targets.some((target) => target.kind === "node");

  if (!hasDynamicZone) {
    throw new CloudflareError(
      "CLOUDFLARE_NO_DYNAMIC_ZONE",
      "This plan has no dynamic zone, so it needs no Worker — deploy its static assets directly.",
    );
  }

  return {
    name: options.name,
    main: options.main,
    compatibility_date: options.compatibilityDate,
    // `nodejs_compat` gives the Worker `node:crypto`, which the signed-session
    // HMAC verification depends on at the edge.
    compatibility_flags: ["nodejs_compat"],
    assets: {
      directory: options.assetsDir,
      binding: options.assetsBinding ?? "ASSETS",
    },
  };
}
