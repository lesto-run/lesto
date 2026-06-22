/**
 * The browser analytics seam.
 *
 * This is the ONLY analytics surface the rest of the site touches —
 * `analytics.page()` / `.track()` / `.identify()`. It is intentionally shaped
 * like the browser client `@lesto/analytics` will eventually expose, so the move
 * to the in-house battery is a **driver swap, not a rewrite**: replace the
 * PostHog driver in `init.ts` with the battery's, and every call site here and in
 * the `data-analytics` attributes keeps working unchanged.
 *
 * See `./README.md` for the lift-and-fit plan.
 */

/** A flat bag of event properties. Values are JSON scalars — what every backend
 *  (PostHog today, `@lesto/analytics` tomorrow) accepts without translation. */
export type EventProps = Record<string, string | number | boolean | null>;

/** The analytics client the site calls. The portable contract. */
export interface Analytics {
  /** Record a page view. */
  page(props?: EventProps): void;
  /** Record a named product event (e.g. `clicked_open_in_codespaces`). */
  track(event: string, props?: EventProps): void;
  /** Associate the current visitor with a stable id (e.g. after sign-in). */
  identify(distinctId: string, traits?: EventProps): void;
}

/**
 * A pluggable backend behind {@link Analytics}. PostHog is the interim driver
 * (`./posthog-driver.ts`); `@lesto/analytics` will provide its own. The seam is
 * this interface — nothing outside a driver imports a vendor SDK.
 */
export interface AnalyticsDriver {
  /** Boot the backend (load the SDK, apply config). Called once by `createAnalytics`. */
  init(): void;
  page(props?: EventProps): void;
  track(event: string, props?: EventProps): void;
  identify(distinctId: string, traits?: EventProps): void;
}

/** Wrap a driver as an {@link Analytics} client, booting it once. */
export function createAnalytics(driver: AnalyticsDriver): Analytics {
  driver.init();
  return {
    page: (props) => {
      driver.page(props);
    },
    track: (event, props) => {
      driver.track(event, props);
    },
    identify: (distinctId, traits) => {
      driver.identify(distinctId, traits);
    },
  };
}
