/**
 * Config for the interim PostHog driver.
 *
 * `key` is a PostHog **public project key** (`phc_…`) — safe to ship in client
 * JS. Leaving it empty keeps analytics **OFF**: the driver no-ops, no SDK loads,
 * and no cookie is set. To turn it on, paste your project's public key here (or
 * wire it from a build-time env in `build.ts`).
 *
 * When `@lesto/analytics` lands, this PostHog config goes away with the driver.
 */
export const ANALYTICS_CONFIG: { readonly key: string; readonly host: string } = {
  key: "",
  host: "https://us.i.posthog.com",
};
