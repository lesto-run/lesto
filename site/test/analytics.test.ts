/**
 * The analytics seam forwards every call to its driver, and boots it once.
 *
 * This pins the contract the rest of the site (and, later, the swap to
 * `@lesto/analytics`) depends on: `createAnalytics(driver)` is a thin, faithful
 * pass-through. The PostHog driver and the browser wiring are exercised in the
 * real browser, not here — this is the durable, vendor-free part.
 */

import { describe, expect, it } from "vitest";

import { type AnalyticsDriver, createAnalytics } from "../app/analytics/client";

function recordingDriver(): { driver: AnalyticsDriver; calls: string[] } {
  const calls: string[] = [];
  const driver: AnalyticsDriver = {
    init: () => calls.push("init"),
    page: () => calls.push("page"),
    track: (event) => calls.push(`track:${event}`),
    identify: (distinctId) => calls.push(`identify:${distinctId}`),
  };
  return { driver, calls };
}

describe("createAnalytics", () => {
  it("boots the driver once, then forwards page/track/identify in order", () => {
    const { driver, calls } = recordingDriver();

    const analytics = createAnalytics(driver);
    analytics.page();
    analytics.track("clicked_open_in_codespaces", { plan: "free" });
    analytics.identify("user_1");

    expect(calls).toEqual([
      "init",
      "page",
      "track:clicked_open_in_codespaces",
      "identify:user_1",
    ]);
  });

  it("inits exactly once per client", () => {
    const { driver, calls } = recordingDriver();

    createAnalytics(driver);

    expect(calls.filter((call) => call === "init")).toHaveLength(1);
  });
});
