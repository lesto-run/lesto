/**
 * The exact `wrangler` subcommands the Cloudflare deploy driver spawns — named
 * here so a test can PIN them. The driver itself (`bin.ts`) is coverage-excluded
 * wiring that only runs against a live account, so flag drift (a renamed
 * subcommand, a stray flag) would otherwise surface only at a real `lesto deploy`.
 * Pulling the args into this pure module lets the cli gate assert them on every
 * PR: the hermetic `wrangler deploy --dry-run` CI job proves the shipped bundle
 * builds; this proves the FLAGS the driver emits are exactly what we intend.
 */

/** `wrangler deploy` — the deploy invocation. */
export const WRANGLER_DEPLOY_ARGS = ["deploy"] as const;

/** The message a post-deploy-health-failure rollback carries. */
export const WRANGLER_ROLLBACK_MESSAGE = "lesto deploy: post-deploy health check failed";

/** `wrangler rollback --message <reason>` — the rollback invocation. */
export function wranglerRollbackArgs(message: string): readonly string[] {
  return ["rollback", "--message", message];
}
