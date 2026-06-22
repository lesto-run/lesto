/**
 * A headless island: it renders nothing visible, it just boots analytics on the
 * client (the page view + `data-analytics` click tracking, see `../analytics`).
 *
 * It is an island only because that is how a static Lesto page runs code in the
 * browser today. When `@lesto/analytics` ships, the framework will inject its
 * browser client into the client entry (the way `@lesto/observability`'s RUM
 * client is injected — ARCHITECTURE §7) and this island will be deleted. The
 * durable parts are the seam (`../analytics/client`) and the `data-analytics`
 * convention, not this vehicle.
 *
 * It renders a hidden `<span>` so the island always has a stable hydration
 * anchor, then `initAnalytics` runs once on mount.
 */

import { defineIsland } from "@lesto/ui";
import { useEffect } from "react";
import type { ReactElement } from "react";

import { initAnalytics } from "../analytics/init";

function AnalyticsBoot(): ReactElement {
  useEffect(() => {
    initAnalytics();
  }, []);

  return <span data-analytics-root hidden />;
}

export default defineIsland({
  name: "Analytics",
  component: AnalyticsBoot,
  fallback: () => <span data-analytics-root hidden />,
});
