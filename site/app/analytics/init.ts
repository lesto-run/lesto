/**
 * Boot analytics in the browser: send the page view and wire declarative click
 * tracking. Called once per page by the headless analytics island.
 *
 * Click tracking is DECLARATIVE: any element with `data-analytics="event_name"`
 * fires `analytics.track("event_name")` when clicked. Adding tracking to a link
 * or button is therefore an attribute, not a code change — and the same
 * convention carries over to `@lesto/analytics`, so nothing here is throwaway.
 */

import { type Analytics, createAnalytics } from "./client";
import { posthogDriver } from "./posthog-driver";

let analytics: Analytics | undefined;

/** Idempotent: safe to call on every island mount; only the first call boots. */
export function initAnalytics(): void {
  if (analytics !== undefined || typeof window === "undefined") return;

  // The driver swap point: replace `posthogDriver()` with the @lesto/analytics
  // browser client when the battery ships — nothing below changes.
  analytics = createAnalytics(posthogDriver());

  analytics.page();
  wireClickTracking(analytics);
}

/** One delegated listener turns every `[data-analytics]` click into an event. */
function wireClickTracking(client: Analytics): void {
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const el = target.closest<HTMLElement>("[data-analytics]");
    const name = el?.dataset["analytics"];
    if (name === undefined || name === "") return;

    client.track(name);
  });
}
