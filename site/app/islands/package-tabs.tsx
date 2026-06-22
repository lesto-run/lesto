/**
 * A headless island that upgrades the server-rendered package-manager tabs.
 *
 * Pure dogfooding: the tab markup is emitted by `@lesto/content-markdown`'s
 * `rehypePackageCommands` at build time (works with no JS — the npm command
 * shows by default), and this island just calls the framework's own
 * `enhancePackageCommands` once on the client to wire switching, cross-page
 * sync, and the remembered choice. The site contributes only the slot.
 *
 * Like the analytics island, it is an island only because that is how a static
 * Lesto page runs code in the browser today; the durable part is the framework
 * enhancer, not this vehicle.
 */

import { enhancePackageCommands } from "@lesto/content-markdown/client";
import { defineIsland } from "@lesto/ui";
import { useEffect } from "react";
import type { ReactElement } from "react";

function PackageTabsBoot(): ReactElement {
  useEffect(() => {
    enhancePackageCommands();
  }, []);

  return <span data-pm-root hidden />;
}

export default defineIsland({
  name: "PackageTabs",
  component: PackageTabsBoot,
  fallback: () => <span data-pm-root hidden />,
});
