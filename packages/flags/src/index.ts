/**
 * @volo/flags — first-class feature flags.
 *
 *   const flags = defineFlags({
 *     defaults: { "new-listing-ui": false },
 *     resolve: (flag, c) => (c.query("preview") === "1" ? true : undefined),
 *   });
 *
 *   app
 *     .use(flags.gate("beta"))                          // hides a whole subtree when off
 *     .get("/api/new", flags.gate("new-listing-ui"), handler);
 *
 * An off flag is a 404 by default — the feature simply does not exist to a client.
 * Resolution is dynamic-then-static, and an unknown flag is off.
 */

export { defineFlags } from "./flags";
export type { Flags, FlagsConfig } from "./flags";
