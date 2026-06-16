/**
 * `DeferredPanel` — a below-the-fold island that hydrates only when visible.
 *
 * The third island flavor in the playground, completing the matrix: `Account`
 * hydrates eagerly on load with server-resolved data, `LiveListing` mounts fresh
 * and fetches on the client, and this one declares `hydrate: "visible"` — so its
 * interactivity is wired only once it scrolls into view (an `IntersectionObserver`
 * in `hydrateDocumentIslands`), keeping its JS off the critical path. The server
 * paints the static fallback until then.
 */

import { useState } from "react";
import type { ReactNode } from "react";

import { defineIsland } from "@keel/ui";

function DeferredPanelView(): ReactNode {
  const [clicks, setClicks] = useState(0);

  return (
    <div className="card">
      <p className="card__price">Hydrated on view</p>

      <p className="copy">
        This island's JavaScript stayed off the critical path: it wired up only when it scrolled
        into view (`hydrate: "visible"`).
      </p>

      <button type="button" onClick={() => setClicks((n) => n + 1)}>
        Clicked {clicks}×
      </button>
    </div>
  );
}

export const DeferredPanel = defineIsland({
  name: "DeferredPanel",
  hydrate: "visible",
  component: DeferredPanelView,
  fallback: () => (
    <div className="card">
      <p className="copy">Deferred panel — hydrates when it scrolls into view.</p>
    </div>
  ),
});
